import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import '@/modules/i18n';
import { renderTranscriptPane } from '@/modules/chat/tests/renderTranscriptPane';
import type { ChatMessage, LiveActivity } from '@/shared/types';

/**
 * While a turn runs, the last row of the transcript says what the session is
 * doing right now. It is not a message: it follows the rows that have arrived and
 * is gone when the turn ends.
 */

const userMessage: ChatMessage = { type: 'user', content: 'fix it', timestamp: '2026-01-01T00:00:00.000Z' };

const activity = (stage: LiveActivity['stage']): LiveActivity => ({ stage, startedAt: Date.now(), tasks: [] });

test('a running turn shows a thinking line after the last message', () => {
  render(renderTranscriptPane([userMessage], { liveActivity: activity({ kind: 'thinking' }) }));

  const status = screen.getByRole('status');
  expect(status.textContent).toContain('Thinking');
  expect(status.getAttribute('data-live-activity')).toBe('thinking');
});

test('a tool in progress names what it works on', () => {
  render(renderTranscriptPane([userMessage], {
    liveActivity: activity({ kind: 'tool', tool: 'Read', target: 'src/app.ts' }),
  }));

  const status = screen.getByRole('status');
  expect(status.textContent).toContain('Reading');
  expect(status.textContent).toContain('src/app.ts');
});

test('a request waiting for approval says which tool needs it', () => {
  render(renderTranscriptPane([userMessage], { liveActivity: activity({ kind: 'permission', tool: 'Bash' }) }));

  expect(screen.getByRole('status').textContent).toContain('Waiting for your approval: Bash');
});

test('the line follows the stage as new rows arrive, and goes when the turn ends', () => {
  const { rerender } = render(renderTranscriptPane([userMessage], { liveActivity: activity({ kind: 'thinking' }) }));
  expect(screen.getByRole('status').textContent).toContain('Thinking');

  rerender(renderTranscriptPane([userMessage], { liveActivity: activity({ kind: 'toolResult' }) }));
  expect(screen.getByRole('status').textContent).toContain('Reading the result');

  rerender(renderTranscriptPane([userMessage], { liveActivity: null }));
  expect(screen.queryByRole('status')).toBeNull();
});

test('nothing is drawn for an idle session', () => {
  render(renderTranscriptPane([userMessage]));

  expect(screen.queryByRole('status')).toBeNull();
});
