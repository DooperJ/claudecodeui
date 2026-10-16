import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { MutableRefObject, ReactNode, Ref, RefObject } from 'react';

/** One transcript row as the list sees it: a stable key plus what to draw. */
export type TranscriptRow<TItem> = {
  /** Unique and stable across renders and across older rows being prepended. */
  key: string;
  item: TItem;
  /** Mirrors the row's `data-message-timestamp`, which jumps and highlights look up. */
  timestamp: string | undefined;
};

/** What the chat hooks can ask the list to do. */
export type TranscriptListHandle = {
  /** `index` is a row; `'LAST'` is the very end of the list. */
  scrollToIndex: (options: {
    index: number | 'LAST';
    align: 'start' | 'center' | 'end';
    behavior?: 'auto' | 'smooth';
  }) => void;
};

type TranscriptVirtualListProps<TItem> = {
  rows: TranscriptRow<TItem>[];
  renderRow: (row: TranscriptRow<TItem>) => ReactNode;
  /** Changes when the transcript is a different conversation; the list starts over. */
  resetKey: string;
  listRef: Ref<TranscriptListHandle>;
  /** Receives the scrolling element so wheel, scroll and DOM lookups can reach it. */
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
  onAtBottomChange: (atBottom: boolean) => void;
  /** Fired on every scroll of the list's scrolling element. */
  onScroll: () => void;
  /** Fired once each time the reader comes within reach of the oldest loaded row. */
  onStartReached: () => void;
  /**
   * Row keys mapped to the time until which the row is known to be growing
   * upward (older history was added at its top). When such a row changes height
   * the scroll position moves by the same amount, because the change is above
   * what the reader is looking at even though the row spans the viewport.
   */
  growsUpwardUntilRef: RefObject<Map<string, number>>;
  /** Space above the first row and below the last, in pixels. */
  paddingTop: number;
  paddingBottom: number;
};

/** Height assumed for a row until it has been rendered once and measured. */
const INITIAL_ROW_ESTIMATE_PX = 160;

/** Rows rendered beyond the visible ones, so a fast scroll rarely meets an unrendered row. */
const OVERSCAN_ROWS = 8;

/** Within this distance of the end, the reader counts as following the conversation. */
const AT_BOTTOM_THRESHOLD_PX = 50;

/** Closer than this to the top, older history is requested. */
const START_REACHED_DISTANCE_PX = 400;

/**
 * Rendered by chat's ChatMessagesPane as the transcript's scrolling list.
 *
 * Only the rows near the viewport exist in the DOM. Each row is measured once
 * and keeps its measured height; rows not measured yet are laid out at an
 * estimate that is frozen per row, so nothing moves until a row is actually
 * rendered. The virtualizer anchors the list to its end: older rows added above
 * keep the reader's rows in place, a reader at the end keeps following new and
 * growing rows, and every height correction is applied before the frame is
 * painted. Safari has no native scroll anchoring and this list does not rely on
 * it.
 *
 * Where the browser lacks ResizeObserver (jsdom in tests), every row is rendered
 * in a plain scrolling container instead.
 */
export default function TranscriptVirtualList<TItem>({
  rows,
  renderRow,
  resetKey,
  listRef,
  scrollContainerRef,
  onAtBottomChange,
  onScroll,
  onStartReached,
  growsUpwardUntilRef,
  paddingTop,
  paddingBottom,
}: TranscriptVirtualListProps<TItem>) {
  const scrollerRef = scrollContainerRef;
  const canVirtualize = typeof ResizeObserver !== 'undefined';

  const count = rows.length;
  const averageRowHeightRef = useRef(INITIAL_ROW_ESTIMATE_PX);
  // The estimate a row was first laid out with. It must not change afterwards:
  // re-estimating rows that are not measured yet would resize everything below
  // them without any row actually changing, and nothing would compensate.
  const frozenEstimatesRef = useRef(new Map<string, number>());

  const getItemKey = (index: number): string => rows[index]?.key ?? `transcript-row-${index}`;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (index) => {
      const key = getItemKey(index);
      const frozen = frozenEstimatesRef.current.get(key);
      if (frozen !== undefined) return frozen;
      const estimate = averageRowHeightRef.current;
      frozenEstimatesRef.current.set(key, estimate);
      return estimate;
    },
    getItemKey,
    overscan: OVERSCAN_ROWS,
    paddingStart: paddingTop,
    paddingEnd: paddingBottom,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: AT_BOTTOM_THRESHOLD_PX,
    onChange: (instance) => {
      // The running mean of measured heights is the best guess for rows not yet seen.
      const measured = [...instance.itemSizeCache.values()];
      if (measured.length > 0) {
        averageRowHeightRef.current = measured.reduce((sum, size) => sum + size, 0) / measured.length;
      }
    },
    enabled: canVirtualize,
  });

  // The library's default rule, plus rows known to grow upward. (The default
  // compensates a first measurement of any row starting above the viewport,
  // and a later change only for rows entirely above it, never while scrolling back.)
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const offset = instance.scrollOffset ?? 0;
    const growingUpwardUntil = growsUpwardUntilRef.current?.get(String(item.key));
    if (
      growingUpwardUntil !== undefined
      && growingUpwardUntil > Date.now()
      && item.start < offset + (instance.scrollElement?.clientHeight ?? 0)
    ) {
      return true;
    }
    const isFirstMeasure = !instance.itemSizeCache.has(item.key);
    return isFirstMeasure
      ? item.start < offset
      : item.end <= offset && instance.scrollDirection !== 'backward';
  };

  const reportedAtBottomRef = useRef(true);

  useImperativeHandle(listRef, () => ({
    scrollToIndex: ({ index, align, behavior = 'auto' }) => {
      if (index === 'LAST') {
        virtualizer.scrollToIndex(count - 1, { align: 'end', behavior });
        return;
      }
      virtualizer.scrollToIndex(index, { align, behavior });
    },
  }), [count, virtualizer]);

  // A conversation opens at its end.
  useLayoutEffect(() => {
    reportedAtBottomRef.current = true;
    averageRowHeightRef.current = INITIAL_ROW_ESTIMATE_PX;
    frozenEstimatesRef.current.clear();
    if (canVirtualize && count > 0) {
      virtualizer.scrollToIndex(count - 1, { align: 'end' });
    }
  // Only the conversation identity restarts the list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const handleScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const distanceFromEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const atBottom = distanceFromEnd < AT_BOTTOM_THRESHOLD_PX;
    if (atBottom !== reportedAtBottomRef.current) {
      reportedAtBottomRef.current = atBottom;
      onAtBottomChange(atBottom);
    }

    // Asked on every scroll near the top, not once: the owner declines while a
    // page is already loading, and a request that was declined must be repeated.
    if (scroller.scrollTop < START_REACHED_DISTANCE_PX) {
      onStartReached();
    }
    onScroll();
  }, [onAtBottomChange, onScroll, onStartReached, scrollerRef]);

  // A page that lands while the reader is still near the top (or a transcript
  // too short to scroll at all) leaves them within reach of yet older history.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller && scroller.scrollTop < START_REACHED_DISTANCE_PX) {
      onStartReached();
    }
  // Re-checked when the row count changes, e.g. after a page lands.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, resetKey]);

  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scrollerRef.current = element;
  }, [scrollerRef]);

  if (!canVirtualize) {
    return (
      <div
        ref={attachScroller as unknown as RefObject<HTMLDivElement>}
        onScroll={handleScroll}
        className="chat-messages-pane h-full overflow-y-auto overflow-x-hidden"
      >
        <div style={{ height: paddingTop }} />
        {rows.map((row) => <div key={row.key} data-item-key={row.key}>{renderRow(row)}</div>)}
        <div style={{ height: paddingBottom }} />
      </div>
    );
  }

  return (
    <div
      ref={attachScroller}
      onScroll={handleScroll}
      className="chat-messages-pane h-full overflow-y-auto overflow-x-hidden"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const row = rows[virtualItem.index];
          return (
            <div
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              data-item-key={String(virtualItem.key)}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {row ? renderRow(row) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
