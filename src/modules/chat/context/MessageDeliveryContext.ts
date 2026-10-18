import { createContext, useContext } from 'react';

type MessageDeliveryContextValue = {
  /** Sends a not-delivered message again; returns false while the connection is down. */
  retrySend: (clientMessageId: string) => boolean;
};

/**
 * Lets a user message row in the transcript retry its own send.
 *
 * The row is several components below ChatInterface, which owns the delivery
 * tracking; the context saves threading a callback through the pane, the
 * virtual list and the tool groups. Absent outside a live chat (an exported
 * document), where there is nothing to retry.
 */
export const MessageDeliveryContext = createContext<MessageDeliveryContextValue | null>(null);

/** The retry function for a not-delivered message, or null outside a live chat. */
export function useRetryMessage(): ((clientMessageId: string) => boolean) | null {
  return useContext(MessageDeliveryContext)?.retrySend ?? null;
}
