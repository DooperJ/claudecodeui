import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { ChatMessage, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * Enter sends on a desktop keyboard, but a phone's soft keyboard has no Shift or
 * Ctrl to ask for a new line, so on a touch-first device Enter must type one
 * and the send button does the sending. Ctrl/Cmd+Enter sends everywhere.
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


function pressEnter(view: ReturnType<typeof renderComposer>['view'], modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  const preventDefault = vi.fn();
  act(() => {
    view.result.current.handleKeyDown({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      ...modifiers,
      nativeEvent: { isComposing: false },
      preventDefault,
    } as never);
  });
  return preventDefault;
}

function setPointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query === '(pointer: coarse)' }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('Enter sends on a device whose primary pointer is a mouse', async () => {
  setPointer(false);
  const { view } = renderComposer(true);
  await act(async () => { view.result.current.setInput('hello'); });

  const preventDefault = pressEnter(view);

  assert.ok(preventDefault.mock.calls.length > 0, 'the key press is taken over to send');
});

test('Enter on a touch-first device is left alone so it types a new line', async () => {
  setPointer(true);
  const { view, sentFrames } = renderComposer(true);
  await act(async () => { view.result.current.setInput('hello'); });

  const preventDefault = pressEnter(view);

  assert.equal(preventDefault.mock.calls.length, 0, 'the browser inserts the newline');
  assert.deepEqual(sentFrames, []);
});

test('Ctrl+Enter and Cmd+Enter still send on a touch-first device (hardware keyboard)', async () => {
  setPointer(true);
  const { view } = renderComposer(true);
  await act(async () => { view.result.current.setInput('hello'); });

  assert.ok(pressEnter(view, { ctrlKey: true }).mock.calls.length > 0);
  await act(async () => { view.result.current.setInput('hello'); });
  assert.ok(pressEnter(view, { metaKey: true }).mock.calls.length > 0);
});
