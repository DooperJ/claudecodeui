import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import QuestionReplyContext from '@/modules/chat/context/QuestionReplyContext';
import type { QuestionReplyContextValue } from '@/modules/chat/context/QuestionReplyContext';
import { QuestionAnswerContent } from '@/modules/chat/tools/ContentRenderers/QuestionAnswerContent';
import type { Question } from '@/shared/types';

/**
 * Codex's async question is answered by a follow-up message: its options are
 * buttons that send one, and once a later message answers it the card shows
 * that answer instead of the buttons.
 */

const questions: Question[] = [
  { question: 'Which first?', options: [{ label: 'A' }, { label: 'B' }] },
];

function renderCard(value: Partial<QuestionReplyContextValue> = {}, replyMode: string | null = 'message') {
  const context: QuestionReplyContextValue = {
    replyToQuestion: vi.fn(),
    canReply: true,
    findQuestionAnswer: () => null,
    ...value,
  };
  render(
    <QuestionReplyContext.Provider value={context}>
      <QuestionAnswerContent questions={questions} answers={{}} toolId="call-1" replyMode={replyMode ?? undefined} />
    </QuestionReplyContext.Provider>,
  );
  return context;
}

describe('question card answered by message', () => {
  it('sends the clicked option as a reply to that question', () => {
    const context = renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'B' }));

    expect(context.replyToQuestion).toHaveBeenCalledWith('Which first?', 'B');
  });

  it('shows the answer given and no buttons once a message has answered it', () => {
    renderCard({ findQuestionAnswer: (toolId, question) => (toolId === 'call-1' && question === 'Which first?' ? 'A' : null) });

    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'B' })).toBeNull();
  });

  it('keeps the options but does not send while a queued message is waiting', () => {
    const context = renderCard({ canReply: false });

    const button = screen.getByRole('button', { name: 'B' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(context.replyToQuestion).not.toHaveBeenCalled();
  });

  it('draws no reply buttons for a question answered inside the call (Claude)', () => {
    renderCard({}, null);

    expect(screen.queryByRole('button', { name: 'B' })).toBeNull();
  });
});
