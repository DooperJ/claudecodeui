import { createRef } from 'react';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { groupConsecutiveTools } from '@/modules/chat/utils/toolGrouping';
import type { ChatMessage } from '@/shared/types';

const noop = () => undefined;

/**
 * The transcript pane with every prop it needs and nothing wired to a session,
 * for tests that care about what it draws. `extra` overrides or adds props.
 */
export function renderTranscriptPane(chatMessages: ChatMessage[], extra: Record<string, unknown> = {}) {
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
    revealMessage: noop,
    sendMessage: noop,
    loadAllMessages: noop,
    isLoadingAllMessages: false,
    showRawParameters: false,
    showThinking: true,
    ...extra,
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return (
    <UiPreferencesProvider>
      <ChatMessagesPane {...(props as any)} />
    </UiPreferencesProvider>
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

