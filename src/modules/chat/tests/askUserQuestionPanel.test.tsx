import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';
import type { PendingPermissionRequest } from '@/shared/types';

/**
 * A question prompt outlives the panel that shows it: leaving the session or a
 * reconnect unmounts the panel while the server keeps waiting. These pin that
 * a half-answered prompt is still half-answered when it returns, and that an
 * answer the socket refused does not make the prompt disappear.
 */

const buildRequest = (requestId: string): PendingPermissionRequest => ({
  requestId,
  toolName: 'AskUserQuestion',
  sessionId: 'session-1',
  receivedAt: new Date(),
  input: {
    questions: [
      { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      { question: 'Which cache?', header: 'Cache', multiSelect: false, options: [{ label: 'Redis' }, { label: 'None' }] },
    ],
  },
} as PendingPermissionRequest);

describe('AskUserQuestionPanel', () => {
  it('brings back the step and choices after being unmounted', () => {
    const request = buildRequest('draft-restore');
    const first = render(<AskUserQuestionPanel request={request} onDecision={() => true} />);

    fireEvent.click(screen.getByText('SQLite'));
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Which cache?')).toBeTruthy();
    first.unmount();

    const onDecision = vi.fn(() => true);
    render(<AskUserQuestionPanel request={buildRequest('draft-restore')} onDecision={onDecision} />);

    // Resumes on the second question, and the first answer is still SQLite.
    expect(screen.getByText('Which cache?')).toBeTruthy();
    fireEvent.click(screen.getByText('Redis'));
    fireEvent.click(screen.getByText('Submit'));
    expect(onDecision).toHaveBeenCalledWith('draft-restore', {
      allow: true,
      updatedInput: expect.objectContaining({
        answers: { 'Which database?': 'SQLite', 'Which cache?': 'Redis' },
      }),
    });
  });

  it('keeps the prompt and says so when the answer could not be sent', () => {
    const onDecision = vi.fn(() => false);
    render(<AskUserQuestionPanel request={buildRequest('send-fails')} onDecision={onDecision} />);

    fireEvent.click(screen.getByText('Postgres'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('None'));
    fireEvent.click(screen.getByText('Submit'));

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toBeTruthy();
    // Still answerable, with the choices intact.
    expect(screen.getByText('Submit')).toBeTruthy();
  });

  it('forgets the draft once the answer has been delivered', () => {
    const delivered = render(
      <AskUserQuestionPanel request={buildRequest('delivered')} onDecision={() => true} />,
    );
    fireEvent.click(screen.getByText('Postgres'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Redis'));
    fireEvent.click(screen.getByText('Submit'));
    delivered.unmount();

    // The same id is not offered again after delivery, but if it were, it starts clean.
    render(<AskUserQuestionPanel request={buildRequest('delivered')} onDecision={() => true} />);
    expect(screen.getByText('Which database?')).toBeTruthy();
  });
});
