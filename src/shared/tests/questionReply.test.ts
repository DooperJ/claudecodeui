import { describe, expect, it } from 'vitest';

import { buildQuestionReply, readQuestionReply } from '@/shared/utils';

/** A reply to a question is ordinary message text, so it has to be rebuilt from the text alone. */
describe('question replies', () => {
  it('quotes the question above the answer', () => {
    expect(buildQuestionReply('Which database?', 'SQLite')).toBe('> Which database?\n\nSQLite');
  });

  it('quotes every line of a multi-line question', () => {
    expect(buildQuestionReply('Which one?\n- A\n- B', 'A')).toBe('> Which one?\n> - A\n> - B\n\nA');
  });

  it('reads the answer back from the message', () => {
    const content = buildQuestionReply('Which database?', 'SQLite');
    expect(readQuestionReply(content, 'Which database?')).toBe('SQLite');
  });

  it('does not take a reply to another question, or an ordinary message, for an answer', () => {
    const content = buildQuestionReply('Which database?', 'SQLite');
    expect(readQuestionReply(content, 'Which cache?')).toBeNull();
    expect(readQuestionReply('SQLite', 'Which database?')).toBeNull();
    expect(readQuestionReply(undefined, 'Which database?')).toBeNull();
  });

  it('ignores a quote with no answer under it', () => {
    expect(readQuestionReply('> Which database?\n\n', 'Which database?')).toBeNull();
  });
});
