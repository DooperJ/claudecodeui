import { useTranslation } from 'react-i18next';
import { memo, useCallback, useMemo, useRef } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';

import type { BackgroundTaskSummary,
  ChatMessage,
  LiveActivity,
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition } from '@/shared/types';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { isToolGroupItem } from '@/modules/chat/utils/toolGrouping';
import type { MessageListItem } from '@/modules/chat/utils/toolGrouping';
import TranscriptVirtualList from '@/modules/chat/transcript/TranscriptVirtualList';
import type { TranscriptListHandle, TranscriptRow } from '@/modules/chat/transcript/TranscriptVirtualList';
import LiveActivityRow from '@/modules/chat/transcript/LiveActivityRow';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import ChatExportMenu from '@/modules/chat/transcript/ChatExportMenu';
import { BackgroundTasksStrip } from '@/modules/chat/transcript/BackgroundTasksStrip';

type ChatMessagesPaneProps = {
  /** Filled with the transcript's scrolling element by the virtual list. */
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
  listRef: RefObject<TranscriptListHandle>;
  /** The transcript as rows: single messages and folded runs of tool calls. */
  transcriptItems: MessageListItem[];
  onAtBottomChange: (atBottom: boolean) => void;
  onScroll: () => void;
  /** Called when the oldest loaded row scrolls into view, to fetch the page before it. */
  onStartReached: () => void;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  /** What the running turn is doing right now; null when nothing is running, so no status line is drawn. */
  liveActivity?: LiveActivity | null;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  providerModels: Record<LLMProvider, string>;
  setProviderModel: (provider: LLMProvider, model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  revealMessage: (message: ChatMessage) => void;
  /** The session's running background tasks from the activity map, for the strip to list ones whose rows are not loaded. */
  backgroundTasks?: BackgroundTaskSummary[];
  /** The chat websocket's send, which the background-tasks strip stops a task over. */
  sendMessage: (message: unknown) => void;
  loadAllMessages: () => void;
  isLoadingAllMessages: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  /** Loads an already-sent message back into the composer; absent when the provider cannot re-run from a point. */
  onEditMessage?: (message: ChatMessage) => void;
  /** Branches the conversation into a new session ending at a message. */
  onForkFromMessage?: (message: ChatMessage) => void;
  /** Fetches the whole transcript for an export, which otherwise only sees the loaded page. */
  onLoadFullTranscript?: () => Promise<ChatMessage[]>;
};

/** How long a row extended upward by older history counts as growing upward: enough for the render and its measurement. */
const GROWS_UPWARD_WINDOW_MS = 3000;

/** A transcript row's content plus the message before it, which spacing and grouping cues read. */
type TranscriptItemWithContext = { item: MessageListItem; prevMessage: ChatMessage | null };

/**
 * Keys for the rows inside a collapsed tool group. They only have to be unique
 * among that group's own rows (ToolGroupContainer disambiguates repeats), so
 * they do not depend on the pane's per-render key map — and being a module
 * function, the prop keeps its identity, which is what lets
 * memo(ToolGroupContainer) skip a group on a stream tick that did not touch it.
 */
const getGroupedMessageKey = (message: ChatMessage): string =>
  getIntrinsicMessageKey(message) ?? 'message-generated';

/**
 * Rendered by chat's ChatInterface as the transcript: a virtual list of messages
 * and tool groups, the export menu, the provider empty state and the
 * load-all-history overlay.
 */
function ChatMessagesPane({
  scrollContainerRef,
  listRef,
  transcriptItems,
  onAtBottomChange,
  onScroll,
  onStartReached,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  hasActivityIndicator = false,
  liveActivity = null,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  providerModels,
  setProviderModel,
  providerModelCatalog,
  providerModelActions,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  revealMessage,
  backgroundTasks,
  sendMessage,
  loadAllMessages,
  isLoadingAllMessages,
  createDiff,
  onEditMessage,
  onForkFromMessage,
  onLoadFullTranscript,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  // Stable, deterministic keys for the messages in the list.
  //
  // A server refresh can replace source records with equivalent new objects, so
  // object identity is not a durable React key across pagination or hydration.
  // Deriving keys from the ordered messages (intrinsic key, disambiguated by
  // occurrence index on collision) preserves existing DOM nodes and component
  // state when older history is prepended.
  // The row key each message was last drawn under. A row is keyed by its first
  // message, so when older history lands and a row changes shape (a single tool
  // call folds into a run that now starts earlier, or a run grows upward), its
  // key would change and the list could no longer find the row the reader was
  // looking at. A row keeps the key one of its messages already had instead.
  const transcriptId = selectedSession?.id || currentSessionId || 'new-session';
  const rowKeyByMessageRef = useRef<{ transcriptId: string; keys: Map<string, string> }>({
    transcriptId,
    keys: new Map(),
  });

  // Rows whose first message changed while they kept their key: older history
  // landed and extended them upward. The height they gain is above what the
  // reader is looking at, so the list shifts the scroll position by it. Each
  // entry expires: it only has to outlive the measurement that follows the render.
  const growsUpwardUntilRef = useRef(new Map<string, number>());
  const firstMemberByRowKeyRef = useRef(new Map<string, string>());

  const rows = useMemo(() => {
    if (rowKeyByMessageRef.current.transcriptId !== transcriptId) {
      rowKeyByMessageRef.current = { transcriptId, keys: new Map() };
      growsUpwardUntilRef.current.clear();
      firstMemberByRowKeyRef.current.clear();
    }
    const rowKeyByMessage = rowKeyByMessageRef.current.keys;
    const firstMemberByRowKey = firstMemberByRowKeyRef.current;

    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage): string => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      return seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`;
    };

    const usedRowKeys = new Set<string>();
    const resolveRowKey = (memberKeys: string[], ownKey: string): string => {
      const inherited = memberKeys
        .map((memberKey) => rowKeyByMessage.get(memberKey))
        .find((rowKey): rowKey is string => rowKey !== undefined && !usedRowKeys.has(rowKey));
      const key = inherited ?? (usedRowKeys.has(ownKey) ? `${ownKey}__row` : ownKey);
      usedRowKeys.add(key);
      memberKeys.forEach((memberKey) => rowKeyByMessage.set(memberKey, key));
      const previousFirstMember = firstMemberByRowKey.get(key);
      if (previousFirstMember !== undefined && previousFirstMember !== memberKeys[0]) {
        growsUpwardUntilRef.current.set(key, Date.now() + GROWS_UPWARD_WINDOW_MS);
      }
      firstMemberByRowKey.set(key, memberKeys[0]);
      return key;
    };

    let previous: ChatMessage | null = null;
    return transcriptItems.map((item): TranscriptRow<TranscriptItemWithContext> => {
      const prevMessage = previous;
      if (isToolGroupItem(item)) {
        const memberKeys = item.messages.map((message) => assign(message));
        previous = item.messages[item.messages.length - 1] || previous;
        const key = resolveRowKey(memberKeys, `tool-group-${memberKeys[0]}`);
        return { key, item: { item, prevMessage }, timestamp: String(item.timestamp) };
      }

      const messageKey = assign(item);
      previous = item;
      const key = resolveRowKey([messageKey], messageKey);
      return { key, item: { item, prevMessage }, timestamp: String(item.timestamp) };
    });
  }, [transcriptId, transcriptItems]);

  const renderRow = useCallback((row: TranscriptRow<TranscriptItemWithContext>) => {
    const { item, prevMessage } = row.item;
    return (
      <div
        data-message-timestamp={row.timestamp || undefined}
        className="mx-auto w-full max-w-[54.25rem] px-4 pb-3 sm:pb-4"
      >
        {isToolGroupItem(item) ? (
          <ToolGroupContainer
            group={item}
            prevMessage={prevMessage}
            createDiff={createDiff}
            getMessageKey={getGroupedMessageKey}
            onFileOpen={onFileOpen}
            onShowSettings={onShowSettings}
            onGrantToolPermission={onGrantToolPermission}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            selectedProject={selectedProject}
            provider={provider}
          />
        ) : (
          <MessageComponent
            message={item}
            prevMessage={prevMessage}
            createDiff={createDiff}
            onFileOpen={onFileOpen}
            onShowSettings={onShowSettings}
            onGrantToolPermission={onGrantToolPermission}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            selectedProject={selectedProject}
            provider={provider}
            onEditMessage={onEditMessage}
            onForkFromMessage={onForkFromMessage}
          />
        )}
      </div>
    );
  }, [
    createDiff,
    onEditMessage,
    onFileOpen,
    onForkFromMessage,
    onGrantToolPermission,
    onShowSettings,
    provider,
    selectedProject,
    showRawParameters,
    showThinking,
  ]);

  // Room above the first row for the floating strip and export menu, and below
  // the last row for the composer's activity tab when it is showing.
  const listPaddingTop = 64;
  const listPaddingBottom = hasActivityIndicator ? 56 : 16;

  const showList = chatMessages.length > 0;

  return (
    <div
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className="relative min-h-0 flex-1 overflow-hidden"
    >
      {showList ? (
        <>
          <TranscriptVirtualList
            rows={rows}
            renderRow={renderRow}
            resetKey={transcriptId}
            growsUpwardUntilRef={growsUpwardUntilRef}
            tail={liveActivity ? <LiveActivityRow activity={liveActivity} /> : undefined}
            listRef={listRef}
            scrollContainerRef={scrollContainerRef}
            onAtBottomChange={onAtBottomChange}
            onScroll={onScroll}
            onStartReached={onStartReached}
            paddingTop={listPaddingTop}
            paddingBottom={listPaddingBottom}
          />
          {/* Floating over the list so they stay in view while the transcript scrolls under them. */}
          <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex items-start justify-between gap-2 sm:px-4">
            <div className="pointer-events-auto min-w-0 pl-4 sm:pl-0">
              <BackgroundTasksStrip
                messages={chatMessages}
                tasks={backgroundTasks}
                sessionId={selectedSession?.id || currentSessionId}
                sendMessage={sendMessage}
                onReveal={revealMessage}
                onLoadAll={loadAllMessages}
              />
            </div>
            <div className="pointer-events-auto">
              <ChatExportMenu
                messages={chatMessages}
                sessionTitle={selectedSession?.summary || selectedSession?.title}
                provider={provider}
                selectedProject={selectedProject}
                createDiff={createDiff}
                onLoadFullTranscript={onLoadFullTranscript}
              />
            </div>
          </div>
          {/* Floating over the list so it never changes the list's height. */}
          {(isLoadingMoreMessages || isLoadingAllMessages) && (
            <div className="pointer-events-none absolute inset-x-0 top-14 z-10 flex justify-center px-4">
              <div className="flex items-center space-x-2 rounded-full bg-background/90 px-3 py-1 text-sm text-gray-500 shadow dark:text-gray-400">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                <p>{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="h-full overflow-y-auto overflow-x-hidden px-4 pt-3 sm:pt-4">
          <div className="mx-auto w-full max-w-[54.25rem]">
            {(isLoadingSessionMessages || isProcessing) ? (
              <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
                <div className="flex items-center justify-center space-x-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                  <p>{t('session.loading.sessionMessages')}</p>
                </div>
              </div>
            ) : (
              <ProviderSelectionEmptyState
                selectedSession={selectedSession}
                currentSessionId={currentSessionId}
                provider={provider}
                setProvider={setProvider}
                textareaRef={textareaRef}
                providerModels={providerModels}
                setProviderModel={setProviderModel}
                providerModelCatalog={providerModelCatalog}
                providerModelActions={providerModelActions}
                providerModelsLoading={providerModelsLoading}
                tasksEnabled={tasksEnabled}
                isTaskMasterInstalled={isTaskMasterInstalled}
                onShowAllTasks={onShowAllTasks}
                setInput={setInput}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ChatMessagesPane);
