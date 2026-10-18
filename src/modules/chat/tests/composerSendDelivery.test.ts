import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { ChatMessage, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * A message is only shown as sent once the socket accepted the frame. When the
 * connection is down the text stays in the composer, nothing claims the turn is
 * running, and the user is told — the failure that used to look like a reply
 * that never came.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION = { id: 'session-1', title: 'Existing' } as ProjectSession;

function renderComposer(socketOpen: boolean, waitForConnection?: () => Promise<boolean>, openAfterWait = false) {
  let open = socketOpen;
  const sentFrames: Array<Record<string, unknown>> = [];
  const tracked: Array<Record<string, unknown>> = [];
  const added: ChatMessage[] = [];
  const processing: string[] = [];

  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => {
        if (!open) return false;
        sentFrames.push(message as Record<string, unknown>);
        return true;
      },
      trackSend: (frame) => { tracked.push(frame); },
      waitForConnection: waitForConnection
        ? async () => { const connected = await waitForConnection(); if (connected && openAfterWait) open = true; return connected; }
        : undefined,
      onSessionProcessing: (sessionId) => { processing.push(String(sessionId)); },
      scrollToBottom: () => undefined,
      addMessage: (message) => { added.push(message); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  return { view, sentFrames, tracked, added, processing };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a send on a dead connection keeps the text, shows no sent message and never starts the spinner', async () => {
  const { view, tracked, added, processing } = renderComposer(false);
  await act(async () => { view.result.current.setInput('hello'); });

  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  assert.equal(view.result.current.input, 'hello', 'the text is still in the composer');
  assert.deepEqual(processing, [], 'no run is claimed');
  assert.deepEqual(tracked, [], 'nothing waits for an acknowledgement');
  assert.deepEqual(added.map((message) => message.type), ['error'], 'only the failure notice is added, not the user message');
});

test('a delivered send carries a clientMessageId, is tracked, and shows as sending', async () => {
  const { view, sentFrames, tracked, added, processing } = renderComposer(true);
  await act(async () => { view.result.current.setInput('hello'); });

  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  const frame = sentFrames[0];
  assert.equal(frame.type, 'chat.send');
  assert.match(String(frame.clientMessageId), /^cm-[A-Za-z0-9_-]+$/);
  assert.deepEqual(tracked, [frame]);

  const userRow = added.find((message) => message.type === 'user');
  assert.equal(userRow?.clientMessageId, frame.clientMessageId);
  assert.equal(userRow?.deliveryStatus, 'sending');
  assert.deepEqual(processing, ['session-1']);
  assert.equal(view.result.current.input, '', 'the composer is cleared once the frame is out');
});

test('a send that finds the socket reconnecting waits for it and then goes out', async () => {
  const { view, sentFrames, tracked, added } = renderComposer(false, async () => true, true);
  await act(async () => { view.result.current.setInput('hello'); });

  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  assert.equal(sentFrames.length, 1, 'sent once the connection returned');
  assert.equal(tracked.length, 1);
  assert.equal(added.some((message) => message.type === 'error'), false);
  assert.equal(view.result.current.input, '');
});

test('a send whose wait for the socket runs out behaves like a send on a dead connection', async () => {
  const { view, sentFrames, added, processing } = renderComposer(false, async () => false);
  await act(async () => { view.result.current.setInput('hello'); });

  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  assert.deepEqual(sentFrames, []);
  assert.deepEqual(processing, []);
  assert.equal(view.result.current.input, 'hello');
  assert.deepEqual(added.map((message) => message.type), ['error']);
});
