import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * `chat_accepted` is the server's receipt for a sent message. It is bookkeeping
 * for the delivery tracker; letting it through to the store would add a blank
 * row to the transcript for every message sent.
 */

test('a chat_accepted receipt never reaches the transcript store', () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const appended: NormalizedMessage[] = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: { appendRealtime: (_sid: string, msg: NormalizedMessage) => { appended.push(msg); } } as unknown as SessionStore,
  }));

  (listener as ((event: ServerEvent) => void) | null)?.({
    kind: 'chat_accepted',
    sessionId: 'viewed-session',
    clientMessageId: 'cm-1',
    duplicate: false,
  });

  assert.deepEqual(appended, []);
});
