import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import LiveActivityRow from '@/modules/chat/transcript/LiveActivityRow';
import type { BackgroundTaskSummary, LiveActivity, SessionActivity } from '@/shared/types';

/**
 * A turn that ended while the agents, workflows or commands it launched still
 * run keeps a status line at the end of the transcript, named for the work and
 * in the purple of the workflow and agent cards. Nothing is responding and the
 * composer can send, so the Stop tab above the input is not drawn for it.
 */

const task = (overrides: Partial<BackgroundTaskSummary> = {}): BackgroundTaskSummary => ({
  taskId: 'wxkj4kcvd',
  toolUseId: 'toolu_workflow_1',
  taskType: 'local_workflow',
  description: 'Audit the frontend',
  workflowName: 'frontend-architecture-audit',
  startedAt: Date.now() - 65_000,
  ...overrides,
});

const backgroundActivity = (tasks: BackgroundTaskSummary[]): LiveActivity => ({
  stage: { kind: 'background' },
  startedAt: Math.min(...tasks.map((entry) => entry.startedAt)),
  tasks,
});

const sessionActivityFor = (overrides: Partial<SessionActivity>): SessionActivity => ({
  statusText: null,
  canInterrupt: true,
  startedAt: Date.now(),
  ...overrides,
});

test('a background-only session names its workflow, counts from its start and the Stop tab stays away', () => {
  const onAbort = vi.fn();
  const { container } = render(<LiveActivityRow activity={backgroundActivity([task()])} />);

  assert.match(container.textContent ?? '', /Background work…/);
  assert.match(container.textContent ?? '', /Workflow frontend-architecture-audit/);
  assert.match(container.textContent ?? '', /1m 5s/, 'elapsed since the task started, not since the line mounted');
  assert.ok(container.querySelector('.bg-purple-500'), 'the dot is the cards\' purple, not the primary colour');

  const tab = render(
    <ActivityIndicator
      activity={sessionActivityFor({ canInterrupt: false, background: true, tasks: [task()] })}
      onAbort={onAbort}
    />,
  );
  assert.equal(tab.container.textContent, '', 'nothing responding, so nothing to stop');
});

test('an agent and a command are named by what they were asked to do; several tasks by their count', () => {
  const agent = render(
    <LiveActivityRow activity={backgroundActivity([task({ taskType: 'local_agent', description: 'Survey the repo', workflowName: undefined })])} />,
  );
  assert.match(agent.container.textContent ?? '', /Agent Survey the repo/);
  agent.unmount();

  const command = render(
    <LiveActivityRow activity={backgroundActivity([task({ taskType: 'local_bash', description: 'npm test', workflowName: undefined })])} />,
  );
  assert.match(command.container.textContent ?? '', /Command npm test/);
  command.unmount();

  const several = render(
    <LiveActivityRow activity={backgroundActivity([task(), task({ taskId: 'b5xsbzu5k', toolUseId: 'toolu_bash_1', taskType: 'local_bash' })])} />,
  );
  assert.match(several.container.textContent ?? '', /2 tasks/);
  several.unmount();

  // A workflow agent's own backgrounded command is listed (it can be stopped)
  // but it is the agent's business, not a second task of the session's.
  const nested = render(
    <LiveActivityRow activity={backgroundActivity([task(), task({ taskId: 'b5xsbzu5k', toolUseId: 'toolu_bash_1', taskType: 'local_bash', nested: true })])} />,
  );
  assert.match(nested.container.textContent ?? '', /Workflow frontend-architecture-audit/);
  assert.doesNotMatch(nested.container.textContent ?? '', /2 tasks/);
});

test('a response in flight keeps the Stop button above the input and no status text there', () => {
  const onAbort = vi.fn();
  const { container } = render(
    <ActivityIndicator activity={sessionActivityFor({ statusText: 'Thinking' })} onAbort={onAbort} />,
  );

  screen.getByRole('button', { name: 'Stop' }).click();
  assert.equal(onAbort.mock.calls.length, 1);
  assert.doesNotMatch(container.textContent ?? '', /Thinking|\ds/, 'what it is doing and how long is the transcript line\'s job');
});
