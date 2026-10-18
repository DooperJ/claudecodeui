import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';

/** The steer action appears only where the session can take a message mid-turn. */
describe('queued message card', () => {
  it('offers to steer when the session can take it, and calls back', () => {
    const onSteer = vi.fn();
    render(<QueuedMessageCard content="also add tests" onEdit={() => undefined} onDelete={() => undefined} onSteer={onSteer} />);

    fireEvent.click(screen.getByRole('button', { name: 'Send now without interrupting' }));

    expect(onSteer).toHaveBeenCalledTimes(1);
  });

  it('has no steer action when the session cannot take one', () => {
    render(<QueuedMessageCard content="also add tests" onEdit={() => undefined} onDelete={() => undefined} />);

    expect(screen.queryByRole('button', { name: 'Send now without interrupting' })).toBeNull();
  });
});
