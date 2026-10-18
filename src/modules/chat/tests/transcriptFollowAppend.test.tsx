import { createRef } from 'react';
import type { ReactNode } from 'react';

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TranscriptVirtualList from '@/modules/chat/transcript/TranscriptVirtualList';
import type { TranscriptRow } from '@/modules/chat/transcript/TranscriptVirtualList';

/**
 * A reader at the end of the transcript keeps seeing new messages even while a
 * live status line holds the list's last position. jsdom has no layout, so the
 * virtualizer is replaced by a stub that only records the scroll commands.
 */

const scrollToIndex = vi.fn();

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    scrollToIndex,
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    measureElement: () => undefined,
  }),
}));

const buildRows = (count: number): TranscriptRow<string>[] => (
  Array.from({ length: count }, (_, index) => ({
    key: `row-${index}`,
    item: `message ${index}`,
    timestamp: undefined,
  }))
);

function renderList(
  rows: TranscriptRow<string>[],
  options: { tail?: ReactNode; onScrollerReady?: (scroller: HTMLDivElement) => void } = {},
) {
  const props = {
    renderRow: (row: TranscriptRow<string>) => <span>{row.item}</span>,
    resetKey: 'session-1',
    listRef: createRef<never>(),
    scrollContainerRef: { current: null as HTMLDivElement | null },
    onAtBottomChange: () => undefined,
    onScroll: () => undefined,
    onStartReached: () => undefined,
    growsUpwardUntilRef: { current: new Map<string, number>() },
    paddingTop: 0,
    paddingBottom: 0,
  };
  const view = render(<TranscriptVirtualList {...props} rows={rows} tail={options.tail} />);
  return {
    rerenderWith: (nextRows: TranscriptRow<string>[], nextTail: ReactNode = options.tail) => (
      view.rerender(<TranscriptVirtualList {...props} rows={nextRows} tail={nextTail} />)
    ),
    scroller: view.container.querySelector('.chat-messages-pane') as HTMLDivElement,
  };
}

/** Reports the scroller's position the way a real scroll event does. */
function scrollTo(scroller: HTMLDivElement, scrollTop: number) {
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: scrollTop });
  scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
}

describe('transcript follows a new last message', () => {
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    scrollToIndex.mockClear();
    // The list only virtualizes where ResizeObserver exists.
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('scrolls to the end when a row is added before the live status line', () => {
    const tail = <div>working</div>;
    const { rerenderWith } = renderList(buildRows(3), { tail });
    scrollToIndex.mockClear();

    rerenderWith(buildRows(4), tail);

    // Four rows plus the status line: the end is index 4.
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith(4, { align: 'end' });
  });

  it('does not pull a reader who scrolled up back to the end', () => {
    const tail = <div>working</div>;
    const { rerenderWith, scroller } = renderList(buildRows(3), { tail });
    scrollTo(scroller, 100); // 500px from the end
    scrollToIndex.mockClear();

    rerenderWith(buildRows(4), tail);

    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('leaves the position alone when older history is added above', () => {
    const tail = <div>working</div>;
    const rows = buildRows(3);
    const { rerenderWith } = renderList(rows, { tail });
    scrollToIndex.mockClear();

    // Older rows are prepended; the last message is unchanged.
    rerenderWith([{ key: 'older-0', item: 'older', timestamp: undefined }, ...rows], tail);

    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
