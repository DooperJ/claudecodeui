import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * The sender shows its own row for a message the moment it is sent, and the
 * server later reports the same turn as a run event under the same id. Two
 * rows for one message would put the question on screen twice.
 */

vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: vi.fn() } } }));

afterEach(() => {
  vi.resetModules();
});

const userRow = (id: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id,
  kind: 'text',
  role: 'user',
  provider: 'claude',
  sessionId: 's1',
  content: 'hello',
  timestamp: '2026-01-01T00:00:00.000Z',
  ...extra,
} as NormalizedMessage);

async function freshStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  return renderHook(() => useSessionStore());
}

describe('session store user echoes', () => {
  it('ignores the server copy of a user message the sender already shows', async () => {
    const view = await freshStore();

    act(() => view.result.current.appendRealtime('s1', userRow('local_cm-1', { deliveryStatus: 'sending' })));
    act(() => view.result.current.appendRealtime('s1', userRow('local_cm-1')));

    assert.equal(view.result.current.getMessages('s1').length, 1);
  });

  it('keeps the server copy on a page that never had the optimistic row', async () => {
    const view = await freshStore();

    act(() => view.result.current.appendRealtime('s1', userRow('local_cm-9')));

    assert.deepEqual(view.result.current.getMessages('s1').map((message) => message.id), ['local_cm-9']);
  });

  it('patches one live row without touching the others', async () => {
    const view = await freshStore();
    act(() => view.result.current.appendRealtime('s1', userRow('local_cm-1', { deliveryStatus: 'sending' })));
    act(() => view.result.current.appendRealtime('s1', userRow('local_cm-2', { content: 'other' })));

    act(() => view.result.current.patchRealtimeMessage('s1', 'local_cm-1', { deliveryStatus: 'failed' }));

    const [first, second] = view.result.current.getMessages('s1');
    assert.equal(first.deliveryStatus, 'failed');
    assert.equal(second.deliveryStatus, undefined);
  });
});
