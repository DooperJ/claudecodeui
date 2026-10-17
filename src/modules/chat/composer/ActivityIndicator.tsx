import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { SessionActivity } from '@/shared/types';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
  onAbort?: () => void;
  isInputFocused?: boolean;
};

const EXIT_ANIMATION_MS = 220;

/**
 * The Stop tab above the composer while a response is in flight. What the
 * session is doing and for how long is told by the status line at the end of the
 * transcript; this tab only keeps the interrupt within reach of the input, which
 * is why it is gone for background-only work (nothing responding, nothing to
 * stop) and while a permission request replaces it.
 *
 * Rendered by chat's ChatComposer above the input so the user can interrupt the
 * in-flight turn without leaving the composer.
 */
export default function ActivityIndicator({ activity, onAbort, isInputFocused = false }: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const stoppable = activity && activity.canInterrupt && !activity.background ? activity : null;
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(stoppable);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (stoppable) {
      setRenderedActivity(stoppable);
      setIsExiting(false);
      return;
    }

    if (!renderedActivity) return;

    setIsExiting(true);
    const timer = setTimeout(() => {
      setRenderedActivity(null);
      setIsExiting(false);
    }, EXIT_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [stoppable, renderedActivity]);

  if (!renderedActivity) return null;

  const tabSurfaceClassName = [
    'chat-activity-tab inline-flex h-8 items-center rounded-b-none rounded-t-lg border border-b-0 bg-card px-3 text-xs transition-all duration-200',
    isInputFocused
      ? 'border-primary/30 shadow-[0_-1px_2px_hsl(var(--foreground)/0.08),1px_0_2px_hsl(var(--foreground)/0.06),-1px_0_2px_hsl(var(--foreground)/0.06)]'
      : 'border-border/50 shadow-[0_-1px_1px_hsl(var(--foreground)/0.04),1px_0_1px_hsl(var(--foreground)/0.03),-1px_0_1px_hsl(var(--foreground)/0.03)]',
  ].join(' ');

  return (
    <div
      className={`pointer-events-none bg-transparent ${
        isExiting ? 'chat-activity-exit' : 'chat-activity-enter'
      }`}
    >
      <div className="flex items-end justify-end gap-2">
        {onAbort && (
          <button
            type="button"
            onClick={onAbort}
            className={`${tabSurfaceClassName} pointer-events-auto gap-1.5 text-muted-foreground hover:bg-card hover:text-destructive`}
            aria-label={t('claudeStatus.stop', { defaultValue: 'Stop' })}
          >
            <svg className="h-2.5 w-2.5 fill-current" viewBox="0 0 24 24" aria-hidden>
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
            <span>{t('claudeStatus.stop', { defaultValue: 'Stop' })}</span>
            <kbd className="hidden rounded border border-border/60 px-1 text-[10px] text-muted-foreground/70 sm:inline-block">
              esc
            </kbd>
          </button>
        )}
      </div>
    </div>
  );
}
