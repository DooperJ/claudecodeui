import { createContext, useContext } from 'react';

/** What a question card needs to let the user answer with a follow-up message and to show an answer already given. */
export type QuestionReplyContextValue = {
  /** Sends `answer` as a new message that quotes `question`. */
  replyToQuestion: (question: string, answer: string) => void;
  /** False while a queued message already waits for the running turn, which a reply would replace. */
  canReply: boolean;
  /** The answer already given to `question`, asked by tool call `toolId`, or null while it is open. */
  findQuestionAnswer: (toolId: string, question: string) => string | null;
};

const QuestionReplyContext = createContext<QuestionReplyContextValue | null>(null);

export function useQuestionReply(): QuestionReplyContextValue | null {
  return useContext(QuestionReplyContext);
}

export default QuestionReplyContext;
