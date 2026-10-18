import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { findCodexAsyncQuestion } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

/**
 * Codex's async ask-the-user tool reaches the SDK stream as plain text with the
 * options flattened into a list; the structured question is only in the rollout
 * file. These pin that the runtime swaps the text for the structured question
 * when (and only when) the rollout holds it.
 */

const QUESTION_TEXT = 'Which should I do first?\n- A\n- B\n- C';

/** Points `os.homedir()` at a scratch directory holding one running thread's rollout. */
async function withRollout<T>(threadId: string, rows: unknown[], run: () => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = path.join(home, '.codex', 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  await fs.mkdir(day, { recursive: true });
  await fs.writeFile(
    path.join(day, `rollout-2026-10-17T00-00-00-${threadId}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await run();
  } finally {
    process.env.HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  }
}

const asyncQuestionRow = {
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    item: {
      type: 'AgentMessage',
      id: 'call_abc',
      content: [{ type: 'Text', text: QUESTION_TEXT }],
      delivery: 'async',
      questions: [{ title: 'Which should I do first?', options: ['A', 'B', 'C'] }],
    },
  },
};

test('the question just asked is read back structured, with option objects', async () => {
  const found = await withRollout('thread-read', [{ type: 'session_meta' }, asyncQuestionRow], () => (
    findCodexAsyncQuestion('thread-read', QUESTION_TEXT)
  ));

  assert.equal(found?.callId, 'call_abc');
  assert.deepEqual(found?.questions, [{
    title: 'Which should I do first?',
    question: 'Which should I do first?',
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
  }]);
});

test('an ordinary assistant message is not mistaken for a question', async () => {
  const found = await withRollout('thread-plain', [asyncQuestionRow], () => (
    findCodexAsyncQuestion('thread-plain', 'I have finished the refactor.')
  ));

  assert.equal(found, null);
});

test('a thread with no readable rollout falls back to showing the text', async () => {
  const found = await withRollout('thread-other', [asyncQuestionRow], () => (
    findCodexAsyncQuestion('thread-missing', QUESTION_TEXT)
  ));

  assert.equal(found, null);
});

test('the runtime shows the structured question instead of the flattened text', async (t) => {
  const thread = {
    id: 'thread-run',
    async runStreamed() {
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-run' };
        yield { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: QUESTION_TEXT } };
        yield { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'I asked you to choose.' } };
        yield { type: 'turn.completed', usage: {} };
      })() };
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'startThread', () => thread);

  const normalized: Array<Record<string, unknown>> = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: (raw) => {
      normalized.push(raw as Record<string, unknown>);
      return [];
    },
    isProviderInstalled: async () => true,
  };

  await withRollout('thread-run', [asyncQuestionRow], () => codexRuntime.run(
    'ask me',
    { cwd: process.cwd() },
    { isWebSocketWriter: true, send: () => undefined },
    context,
  ));

  const asItems = normalized.filter((raw) => raw.type === 'item');
  assert.deepEqual(asItems.map((raw) => raw.itemType), ['user_question', 'agent_message']);
  assert.equal(asItems[0].itemId, 'call_abc');
});
