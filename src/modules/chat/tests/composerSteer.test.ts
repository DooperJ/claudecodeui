import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readQueuedMessage } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * While a turn runs, a message waits in the queue. "Steer" sends it into the
 * running turn instead: the queued copy is taken away at once (the server would
 * otherwise send it again after the turn), the message shows as sent, and if
 * no turn took it after all it goes back to the queue.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION = { id: 'session-1', title: 'Existing' } as ProjectSession;

function renderComposer(socketOpen = true) {
  const sentFrames: Array<Record<string, unknown>> = [];
  const tracked: Array<Record<string, unknown>> = [];
  const added: ChatMessage[] = [];

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
      isLoading: true,
      canAbortSession: true,
      tokenBudget: null,
      sendMessage: (message) => {
        if (!socketOpen) return false;
        sentFrames.push(message as Record<string, unknown>);
        return true;
      },
      trackSend: (frame) => { tracked.push(frame); },
      onSessionProcessing: () => undefined,
      scrollToBottom: () => undefined,
      addMessage: (message) => { added.push(message); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  return { view, sentFrames, tracked, added };
}

const queue = async (view: ReturnType<typeof renderComposer>['view'], text: string) => {
  await act(async () => { view.result.current.setInput(text); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('steering sends the queued message into the running turn and takes it out of the queue', async () => {
  const { view, sentFrames, tracked, added } = renderComposer();
  await queue(view, 'also add tests');
  assert.equal(view.result.current.queuedDraft?.content, 'also add tests');
  assert.ok(readQueuedMessage(SESSION.id), 'the queue holds a stored copy the server would send after the turn');

  await act(async () => { view.result.current.steerQueuedDraft(); });

  const frame = sentFrames.find((candidate) => candidate.type === 'chat.steer');
  assert.ok(frame, 'a steering frame went out');
  assert.equal(frame.sessionId, SESSION.id);
  assert.equal(frame.content, 'also add tests');
  assert.match(String(frame.clientMessageId), /^cm-[A-Za-z0-9_-]+$/);
  assert.deepEqual(tracked, [frame], 'its delivery is followed like any send');

  const row = added.find((message) => message.type === 'user');
  assert.equal(row?.clientMessageId, frame.clientMessageId);
  assert.equal(row?.deliveryStatus, 'sending');

  assert.equal(view.result.current.queuedDraft, null, 'the card is gone');
  assert.equal(readQueuedMessage(SESSION.id), null, 'and so is the stored copy');
});

test('steering on a dead connection keeps the message queued and says so', async () => {
  const { view, sentFrames, added } = renderComposer(false);
  await queue(view, 'also add tests');

  await act(async () => { view.result.current.steerQueuedDraft(); });

  assert.deepEqual(sentFrames, []);
  assert.equal(view.result.current.queuedDraft?.content, 'also add tests');
  assert.deepEqual(added.map((message) => message.type), ['error']);
});

test('a steering message no turn took goes back to the queue', async () => {
  const { view, sentFrames } = renderComposer();
  await queue(view, 'also add tests');
  await act(async () => { view.result.current.steerQueuedDraft(); });
  const frame = sentFrames.find((candidate) => candidate.type === 'chat.steer');

  await act(async () => { view.result.current.restoreSteeredDraft(String(frame?.clientMessageId)); });

  assert.equal(view.result.current.queuedDraft?.content, 'also add tests');
  assert.ok(readQueuedMessage(SESSION.id), 'stored again, so the server sends it once the session is idle');
});

test('a refusal does not displace a message queued in the meantime', async () => {
  const { view, sentFrames } = renderComposer();
  await queue(view, 'first');
  await act(async () => { view.result.current.steerQueuedDraft(); });
  const frame = sentFrames.find((candidate) => candidate.type === 'chat.steer');
  await queue(view, 'second');

  await act(async () => { view.result.current.restoreSteeredDraft(String(frame?.clientMessageId)); });

  assert.equal(view.result.current.queuedDraft?.content, 'second', 'the newer queue entry keeps its place');
  assert.equal(view.result.current.input, 'first', 'the refused text is not lost');
});
