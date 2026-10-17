import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { Shimmer } from '@/shared/ui';
import type { LiveActivity } from '@/shared/types';
import { describeBackgroundTask, ownBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';

type LiveActivityRowProps = {
  activity: LiveActivity;
};

/** The wording for each tool; a tool without an entry reads as "Using <tool>". */
const TOOL_VERB_KEYS: Record<string, string> = {
  Read: 'reading',
  Edit: 'editing',
  MultiEdit: 'editing',
  NotebookEdit: 'editing',
  Write: 'writing',
  Bash: 'running',
  Grep: 'searching',
  Glob: 'searching',
  WebFetch: 'fetching',
  WebSearch: 'searchingWeb',
  Task: 'agent',
  Agent: 'agent',
};

function describeStage(activity: LiveActivity, t: TFunction): { label: string; detail: string | null } {
  const { stage } = activity;
  switch (stage.kind) {
    case 'tool': {
      const verbKey = TOOL_VERB_KEYS[stage.tool];
      return {
        label: verbKey
          ? t(`liveActivity.tool.${verbKey}`)
          : t('liveActivity.tool.using', { tool: stage.tool }),
        detail: stage.target,
      };
    }
    case 'toolResult':
      return { label: t('liveActivity.toolResult'), detail: null };
    case 'permission':
      return { label: t('liveActivity.permission', { tool: stage.tool }), detail: null };
    case 'background': {
      const tasks = ownBackgroundTasks(activity.tasks);
      return {
        label: t('liveActivity.background'),
        detail: tasks.length === 1
          ? describeBackgroundTask(tasks[0], t)
          : t('claudeStatus.backgroundTask.count', { count: tasks.length, defaultValue: '{{count}} tasks' }),
      };
    }
    default:
      return { label: t('liveActivity.thinking'), detail: null };
  }
}

/**
 * Rendered by chat's ChatMessagesPane as the last row of the transcript while a
 * turn is running: one line saying what the session is doing right now, with the
 * elapsed time. It is not a message. It is drawn from the rows that have arrived,
 * it sits below them and is replaced by the next real row (a tool call, a reply)
 * as soon as one arrives, and it disappears when the turn ends. A fixed one-line
 * height keeps it from moving the rows above it.
 */
export default function LiveActivityRow({ activity }: LiveActivityRowProps) {
  const { t } = useTranslation('chat');
  const [elapsedSeconds, setElapsedSeconds] = useState(() => Math.max(0, Math.floor((Date.now() - activity.startedAt) / 1000)));

  useEffect(() => {
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - activity.startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [activity.startedAt]);

  const { label, detail } = describeStage(activity, t);
  const isBackground = activity.stage.kind === 'background';
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = minutes < 1
    ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
    : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });

  return (
    <div
      role="status"
      aria-live="polite"
      data-live-activity={activity.stage.kind}
      className="mx-auto w-full max-w-[54.25rem] px-4 pb-3 sm:pb-4"
    >
      <div className="flex h-6 items-center gap-2 px-3 text-sm sm:px-0">
        <span
          className={`h-1.5 w-1.5 shrink-0 animate-pulse rounded-full ${
            isBackground ? 'bg-purple-500 dark:bg-purple-400' : 'bg-primary'
          }`}
          aria-hidden
        />
        <Shimmer className="shrink-0 font-medium">{`${label}…`}</Shimmer>
        {detail && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={detail}>{detail}</span>
        )}
        <span className="shrink-0 tabular-nums text-xs text-muted-foreground/60">{elapsedLabel}</span>
      </div>
    </div>
  );
}
