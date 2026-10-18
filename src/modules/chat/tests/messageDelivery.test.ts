import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { useMessageDelivery } from '@/modules/chat/hooks/useMessageDelivery';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ServerEvent } from '@/shared/types';

/**
 * A sent message is followed until the server acknowledges it. One that is
 * never acknowledged, or is refused, is marked not delivered so the user can
 * retry; one cut off by a dropped connection is resent when the socket returns.
 */

const lastStatus = (patches: Array<{ patch: unknown }>) =>
  (patches[patches.length - 1]?.patch as { deliveryStatus?: string } | undefined)?.deliveryStatus;

const FRAME = { type: 'chat.send', sessionId: 's1', clientMessageId: 'cm-1', content: 'hi', options: {} };

function setup(sendResult = true) {
  const removed: Array<{ sessionId: string; id: string }> = [];
  const steerRefused: string[] = [];
  let listener: ((event: ServerEvent) => void) | null = null;
  const patches: Array<{ sessionId: string; id: string; patch: unknown }> = [];
  const sent: unknown[] = [];
  const idled: string[] = [];
  const processing: string[] = [];
  const state = { sendResult };

  const sessionStore = {
    patchRealtimeMessage: (sessionId: string, id: string, patch: unknown) => patches.push({ sessionId, id, patch }),
    removeRealtimeMessage: (sessionId: string, id: string) => removed.push({ sessionId, id }),
  } as unknown as SessionStore;

  const view = renderHook(() => useMessageDelivery({
    subscribe: (next) => { listener = next; return () => { listener = null; }; },
    sendMessage: (message) => { sent.push(message); return state.sendResult; },
    sessionStore,
    onSessionProcessing: (sessionId) => { processing.push(String(sessionId)); },
    onSessionIdle: (sessionId) => { idled.push(String(sessionId)); },
    onSteerRefused: (clientMessageId) => { steerRefused.push(clientMessageId); },
  }));

  return {
    view,
    patches,
    sent,
    idled,
    processing,
    removed,
    steerRefused,
    state,
    emit: (event: ServerEvent) => act(() => { listener?.(event); }),
  };
}

describe('useMessageDelivery', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('clears the sending state when the server acknowledges the message', () => {
    const ctx = setup();
    act(() => ctx.view.result.current.trackSend(FRAME, 's1'));

    ctx.emit({ kind: 'chat_accepted', sessionId: 's1', clientMessageId: 'cm-1', duplicate: false });
    act(() => { vi.advanceTimersByTime(30_000); });

    assert.deepEqual(ctx.patches, [{ sessionId: 's1', id: 'local_cm-1', patch: { deliveryStatus: undefined } }]);
    assert.deepEqual(ctx.idled, []);
  });

  it('marks the message failed and stops the spinner when no acknowledgement arrives', () => {
    const ctx = setup();
    act(() => ctx.view.result.current.trackSend(FRAME, 's1'));

    act(() => { vi.advanceTimersByTime(10_000); });

    assert.deepEqual(ctx.patches, [{ sessionId: 's1', id: 'local_cm-1', patch: { deliveryStatus: 'failed' } }]);
    assert.deepEqual(ctx.idled, ['s1']);
  });

  it('marks the message failed when the server refuses it', () => {
    const ctx = setup();
    act(() => ctx.view.result.current.trackSend(FRAME, 's1'));

    ctx.emit({ kind: 'protocol_error', code: 'SESSION_NOT_FOUND', clientMessageId: 'cm-1' });

    assert.equal(lastStatus(ctx.patches), 'failed');
  });

  it('retry resends the same frame and goes back to sending', () => {
    const ctx = setup();
    act(() => ctx.view.result.current.trackSend(FRAME, 's1'));
    act(() => { vi.advanceTimersByTime(10_000); });

    let retried = false;
    act(() => { retried = ctx.view.result.current.retrySend('cm-1'); });

    assert.equal(retried, true);
    assert.deepEqual(ctx.sent, [FRAME]);
    assert.equal(lastStatus(ctx.patches), 'sending');
    assert.deepEqual(ctx.processing, ['s1']);
  });

  it('retry reports failure and keeps the row failed while the socket is down', () => {
    const ctx = setup(false);
    act(() => ctx.view.result.current.trackSend(FRAME, 's1'));
    act(() => { vi.advanceTimersByTime(10_000); });
    const patchesBefore = ctx.patches.length;

    let retried = true;
    act(() => { retried = ctx.view.result.current.retrySend('cm-1'); });

    assert.equal(retried, false);
    assert.equal(ctx.patches.length, patchesBefore);
  });

  it('resends unacknowledged messages when the socket reconnects, but not refused ones', () => {
    const ctx = setup();
    act(() => ctx.view.result.current.trackSend(FRAME, 's1'));
    act(() => ctx.view.result.current.trackSend({ ...FRAME, clientMessageId: 'cm-2' }, 's1'));
    ctx.emit({ kind: 'protocol_error', code: 'RUN_IN_PROGRESS', clientMessageId: 'cm-2' });

    ctx.emit({ kind: 'websocket_reconnected' });

    assert.deepEqual(ctx.sent, [FRAME]);
  });

  it('a late acknowledgement revives a message already shown as failed', () => {
    const ctx = setup();
    act(() => ctx.view.result.current.trackSend(FRAME, 's1'));
    act(() => { vi.advanceTimersByTime(10_000); });

    ctx.emit({ kind: 'chat_accepted', sessionId: 's1', clientMessageId: 'cm-1', duplicate: false });

    assert.equal(lastStatus(ctx.patches), undefined);
    assert.deepEqual(ctx.processing, ['s1']);
  });

  it('a repeat acknowledgement of a retry does not mark the session busy again', () => {
    const ctx = setup();
    act(() => ctx.view.result.current.trackSend(FRAME, 's1'));

    ctx.emit({ kind: 'chat_accepted', sessionId: 's1', clientMessageId: 'cm-1', duplicate: true });

    assert.deepEqual(ctx.processing, []);
  });

  it('hands a steering message back to the queue instead of failing it when no turn took it', () => {
    const ctx = setup();
    const steer = { type: 'chat.steer', sessionId: 's1', clientMessageId: 'cm-steer', content: 'hi', options: {} };
    act(() => ctx.view.result.current.trackSend(steer, 's1'));

    ctx.emit({ kind: 'protocol_error', code: 'STEER_UNAVAILABLE', sessionId: 's1', clientMessageId: 'cm-steer' });
    act(() => { vi.advanceTimersByTime(30_000); });

    assert.deepEqual(ctx.removed, [{ sessionId: 's1', id: 'local_cm-steer' }], 'the optimistic row is dropped');
    assert.deepEqual(ctx.steerRefused, ['cm-steer']);
    assert.deepEqual(ctx.patches, [], 'it is not marked failed');
    assert.deepEqual(ctx.idled, [], 'the session keeps whatever state it has');
  });
});
