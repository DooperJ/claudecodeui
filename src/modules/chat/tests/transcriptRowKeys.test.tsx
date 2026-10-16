import assert from 'node:assert/strict';

import { createRef } from 'react';
import { render } from '@testing-library/react';
import { test } from 'vitest';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { groupConsecutiveTools } from '@/modules/chat/utils/toolGrouping';
import type { ChatMessage } from '@/shared/types';

/**
 * Older history lands above the rows already shown. A row the reader was looking
 * at can change shape when it does: a lone tool call folds into a run that now
 * starts earlier. The list anchors the reader to a row by its key, so the row
 * must keep its key through that change — a new key meant the list could not
 * find the reader's row, did not hold the position, and the view jumped to
 * unrelated history.
 */

const noop = () => undefined;

const toolCall = (second: number, path: string): ChatMessage => ({
  type: 'tool',
  content: '',
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
  isToolUse: true,
  toolName: 'Read',
  toolId: `tool-${second}`,
  toolInput: JSON.stringify({ file_path: path }),
});

const reply = (second: number, content: string): ChatMessage => ({
  type: 'assistant',
  content,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
});

function renderPane(chatMessages: ChatMessage[]) {
  const props = {
    scrollContainerRef: createRef<HTMLDivElement>(),
    listRef: createRef(),
    textareaRef: createRef<HTMLTextAreaElement>(),
    selectedSession: { id: 'session-1' },
    selectedProject: { projectId: 'project-1', name: 'repo', path: '/repo' },
    providerModels: {},
    providerModelCatalog: {},
    providerModelActions: {},
    createDiff: () => [],
    onGrantToolPermission: () => ({ success: true }),
    onWheel: noop,
    onTouchMove: noop,
    onScroll: noop,
    onAtBottomChange: noop,
    onStartReached: noop,
    transcriptItems: groupConsecutiveTools(chatMessages, true),
    isLoadingSessionMessages: false,
    chatMessages,
    currentSessionId: 'session-1',
    provider: 'claude',
    setProvider: noop,
    setProviderModel: noop,
    providerModelsLoading: false,
    tasksEnabled: false,
    isTaskMasterInstalled: false,
    onShowAllTasks: null,
    setInput: noop,
    isLoadingMoreMessages: false,
    hasMoreMessages: false,
    totalMessages: chatMessages.length,
    sessionMessagesCount: chatMessages.length,
    revealMessage: noop,
    sendMessage: noop,
    loadAllMessages: noop,
    allMessagesLoaded: true,
    isLoadingAllMessages: false,
    loadAllJustFinished: false,
    showLoadAllOverlay: false,
    showRawParameters: false,
    showThinking: true,
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return (
    <UiPreferencesProvider>
      <ChatMessagesPane {...(props as any)} />
    </UiPreferencesProvider>
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

const rowKeys = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-item-key]')].map((element) => element.getAttribute('data-item-key'));

test('a lone tool call keeps its row key when older calls fold it into a run', () => {
  const lone = toolCall(30, '/src/c.ts');
  const { container, rerender } = render(renderPane([lone, reply(40, 'done')]));
  const [keyBefore] = rowKeys(container);

  // Two older calls of the same tool land above it.
  rerender(renderPane([toolCall(10, '/src/a.ts'), toolCall(20, '/src/b.ts'), lone, reply(40, 'done')]));
  const keysAfter = rowKeys(container);

  assert.equal(keysAfter.length, 2, 'the three calls fold into one row, followed by the reply');
  assert.equal(keysAfter[0], keyBefore, 'the folded row is the row the reader was on');
});

test('a run of tool calls keeps its row key when older calls extend it upward', () => {
  const run = [toolCall(30, '/src/c.ts'), toolCall(31, '/src/d.ts')];
  const { container, rerender } = render(renderPane([...run, reply(40, 'done')]));
  const [keyBefore] = rowKeys(container);

  rerender(renderPane([toolCall(10, '/src/a.ts'), toolCall(20, '/src/b.ts'), ...run, reply(40, 'done')]));

  assert.equal(rowKeys(container)[0], keyBefore);
});

test('rows are keyed independently for a different conversation', () => {
  const first = render(renderPane([toolCall(30, '/src/c.ts'), reply(40, 'done')]));
  const keys = rowKeys(first.container);
  first.unmount();

  const second = render(renderPane([toolCall(30, '/src/c.ts'), reply(40, 'done')]));
  assert.deepEqual(rowKeys(second.container), keys, 'same content, same keys, nothing carried over');
});
