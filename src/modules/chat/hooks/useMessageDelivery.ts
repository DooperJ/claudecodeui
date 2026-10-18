import { useCallback, useEffect, useRef } from 'react';

import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { MarkSessionIdle, MarkSessionProcessing, ServerEvent } from '@/shared/types';

/** How long a sent message may go unacknowledged before it is shown as not delivered. */
const DELIVERY_ACK_TIMEOUT_MS = 10_000;

/**
 * One message that went to the socket and has not been confirmed by the server.
 * `refused` marks a message the server answered with an error: it is retried
 * only when the user asks, never on reconnect.
 */
type PendingSend = {
  frame: Record<string, unknown>;
  sessionId: string;
  timer: ReturnType<typeof setTimeout> | null;
  refused: boolean;
};

type UseMessageDeliveryArgs = {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  sendMessage: (message: unknown) => boolean;
  sessionStore: SessionStore;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  /**
   * Told when the server could not hand a steering message to a running turn
   * (it ended a moment ago). The message is not failed: the caller puts it
   * back in the queue, where it is sent the ordinary way.
   */
  onSteerRefused?: (clientMessageId: string) => void;
};

/**
 * Follows every sent user message from the socket write to the server's
 * `chat_accepted` acknowledgement, so a message that never arrived is shown as
 * not delivered instead of looking like a reply that is merely slow.
 *
 * - No acknowledgement within a few seconds, or a refusal from the server: the
 *   row is marked `failed`, the spinner stops, and the row offers a retry.
 * - The socket reconnecting resends whatever was never acknowledged. The server
 *   recognizes an id it already took, so the resend cannot run a turn twice.
 */
export function useMessageDelivery({
  subscribe,
  sendMessage,
  sessionStore,
  onSessionProcessing,
  onSessionIdle,
  onSteerRefused,
}: UseMessageDeliveryArgs) {
  // Unacknowledged sends by clientMessageId. A ref because the socket listener
  // and timers read it synchronously and nothing renders from it; the visible
  // state lives on the transcript row's `deliveryStatus`.
  const pendingRef = useRef(new Map<string, PendingSend>());

  // The latest callbacks, so the long-lived listener and timers never act on a
  // stale closure.
  const latestRef = useRef({ sendMessage, sessionStore, onSessionProcessing, onSessionIdle, onSteerRefused });
  latestRef.current = { sendMessage, sessionStore, onSessionProcessing, onSessionIdle, onSteerRefused };

  const patchRow = useCallback((clientMessageId: string, sessionId: string, deliveryStatus: 'sending' | 'failed' | undefined) => {
    latestRef.current.sessionStore.patchRealtimeMessage(sessionId, `local_${clientMessageId}`, { deliveryStatus });
  }, []);

  const markFailed = useCallback((clientMessageId: string, refused: boolean) => {
    const pending = pendingRef.current.get(clientMessageId);
    if (!pending) return;

    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    pending.refused = refused;
    patchRow(clientMessageId, pending.sessionId, 'failed');
    latestRef.current.onSessionIdle?.(pending.sessionId);
  }, [patchRow]);

  const armTimer = useCallback((clientMessageId: string) => {
    const pending = pendingRef.current.get(clientMessageId);
    if (!pending) return;

    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => markFailed(clientMessageId, false), DELIVERY_ACK_TIMEOUT_MS);
  }, [markFailed]);

  /** Starts following a frame the composer has just written to the socket. */
  const trackSend = useCallback((frame: Record<string, unknown>, sessionId: string) => {
    const clientMessageId = frame.clientMessageId;
    if (typeof clientMessageId !== 'string') return;

    pendingRef.current.set(clientMessageId, { frame, sessionId, timer: null, refused: false });
    armTimer(clientMessageId);
  }, [armTimer]);

  const resend = useCallback((clientMessageId: string): boolean => {
    const pending = pendingRef.current.get(clientMessageId);
    if (!pending) return false;

    if (!latestRef.current.sendMessage(pending.frame)) {
      return false;
    }

    pending.refused = false;
    patchRow(clientMessageId, pending.sessionId, 'sending');
    latestRef.current.onSessionProcessing?.(pending.sessionId, { statusText: null, canInterrupt: true });
    armTimer(clientMessageId);
    return true;
  }, [armTimer, patchRow]);

  useEffect(() => {
    const pendingSends = pendingRef.current;

    const unsubscribe = subscribe((event) => {
      const clientMessageId = typeof event.clientMessageId === 'string' ? event.clientMessageId : null;

      if (event.kind === 'chat_accepted' && clientMessageId) {
        const pending = pendingSends.get(clientMessageId);
        if (!pending) return;

        if (pending.timer) clearTimeout(pending.timer);
        pendingSends.delete(clientMessageId);
        patchRow(clientMessageId, pending.sessionId, undefined);
        // A late acknowledgement revives a row that had already been shown as
        // failed. A repeat answer to a retry says nothing new about whether the
        // run is still going; the subscribe ack decides that.
        if (event.duplicate !== true) {
          latestRef.current.onSessionProcessing?.(pending.sessionId, { statusText: null, canInterrupt: true });
        }
        return;
      }

      if (event.kind === 'protocol_error' && clientMessageId && pendingSends.has(clientMessageId)) {
        const pending = pendingSends.get(clientMessageId);
        if (event.code === 'STEER_UNAVAILABLE' && pending) {
          // Not a failure: the turn it was meant for is gone. The run state is
          // whatever it is, so the session is left alone.
          if (pending.timer) clearTimeout(pending.timer);
          pendingSends.delete(clientMessageId);
          latestRef.current.sessionStore.removeRealtimeMessage(pending.sessionId, `local_${clientMessageId}`);
          latestRef.current.onSteerRefused?.(clientMessageId);
          return;
        }
        markFailed(clientMessageId, true);
        return;
      }

      if (event.kind === 'websocket_reconnected') {
        for (const [pendingId, pending] of pendingSends) {
          if (!pending.refused) {
            resend(pendingId);
          }
        }
      }
    });

    return () => {
      unsubscribe();
      for (const pending of pendingSends.values()) {
        if (pending.timer) clearTimeout(pending.timer);
      }
    };
  }, [markFailed, patchRow, resend, subscribe]);

  /** Sends a failed message again with the id it already has. Returns false while the socket is down. */
  const retrySend = useCallback((clientMessageId: string): boolean => resend(clientMessageId), [resend]);

  return { trackSend, retrySend };
}
