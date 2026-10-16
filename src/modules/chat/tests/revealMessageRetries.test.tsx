import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

/**
 * The background-tasks strip reveals a task's row by asking the virtual list to
 * scroll to it. The row can be absent for a moment (a re-render is still
 * landing), so the jump retries; settling for the nearest row on the first
 * attempt scrolled to an unrelated row and ended the retry chain, and the
 * task's row never came into view.
 */

vi.mock('@/shared/api', () => ({
  api: { providers: { sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }) } },
}));

const project: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
const session: ProjectSession = { id: 'session-a', summary: 'A', lastActivity: '2026-01-01T00:00:00.000Z', messageCount: 1 } as ProjectSession;
const slot = { fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0 };

let stored: NormalizedMessage[] = [];
const store = {
  fetchFromServer: vi.fn(async () => slot),
  fetchMore: vi.fn(),
  appendRealtime: vi.fn(),
  refreshLatestFromServer: vi.fn(),
  setActiveSession: vi.fn(),
  isStale: vi.fn(() => false),
  updateStreaming: vi.fn(),
  finalizeStreaming: vi.fn(),
  getMessages: vi.fn(() => stored),
  getSessionSlot: vi.fn(() => slot),
};

const message = (id: string, timestamp: string): NormalizedMessage => ({
  id,
  kind: 'text',
  role: 'assistant',
  provider: 'claude',
  sessionId: 'session-a',
  content: id,
  timestamp,
} as NormalizedMessage);

beforeEach(() => {
  vi.useFakeTimers();
  stored = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

async function renderSessionState() {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  const hook = renderHook(() =>
    useChatSessionState({
      isActive: true,
      selectedProject: project,
      selectedSession: session,
      ws: null,
      sendMessage: vi.fn(),
      resetStreamingState: vi.fn(),
      statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
      sessionStore: store as never,
    }),
  );
  const scrollToIndex = vi.fn();
  (hook.result.current.listRef as { current: unknown }).current = { scrollToIndex };
  return { hook, scrollToIndex };
}

test('revealing a row not yet in the list waits for it instead of scrolling to its neighbour', async () => {
  stored = [message('neighbour', '2026-08-21T10:32:09.000Z')];
  const { hook, scrollToIndex } = await renderSessionState();

  await act(async () => {
    hook.result.current.revealMessage({ type: 'assistant', content: '', timestamp: '2026-08-21T10:32:10.000Z' });
  });
  assert.equal(scrollToIndex.mock.calls.length, 0, 'the neighbour must not be scrolled to');

  // The row arrives with a later render; the next retry finds it.
  stored = [...stored, message('target', '2026-08-21T10:32:10.000Z')];
  await act(async () => {
    hook.rerender();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });

  assert.equal(scrollToIndex.mock.calls.length, 1);
  assert.equal(scrollToIndex.mock.calls[0][0].index, 1, 'the second row');
  assert.equal(scrollToIndex.mock.calls[0][0].align, 'center');
});

test('the last attempt settles for the nearest row, for a hit collapsed inside a tool group', async () => {
  stored = [message('group', '2026-08-21T10:32:09.000Z')];
  const { hook, scrollToIndex } = await renderSessionState();

  await act(async () => {
    hook.result.current.revealMessage({ type: 'assistant', content: '', timestamp: '2026-08-21T10:32:10.000Z' });
    // 20 retries, 150ms apart.
    await vi.advanceTimersByTimeAsync(3500);
  });

  assert.equal(scrollToIndex.mock.calls.length, 1);
  assert.equal(scrollToIndex.mock.calls[0][0].index, 0);
});
