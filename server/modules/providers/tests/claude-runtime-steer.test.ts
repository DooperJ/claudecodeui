import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK, steerClaudeSDKSession } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * A message sent while a turn runs goes straight into the CLI's input. The CLI
 * either folds it into the running turn or, when the model has no tool call
 * left, runs it as a turn of its own right after the `result` — so a result
 * must not end the run while such a message may still be on its way.
 * These drive `queryClaudeSDK` with a scripted stream and watch the input.
 */

const SESSION_ID = 'app-steer-session';
const NATIVE_ID = 'native-steer-session';
const GRACE_MS = 40;

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  /** The texts the CLI has read from its input, in order. */
  read: string[];
};

function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  const read: string[] = [];

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    read,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const message of prompt) {
        const content = (message as { message: { content: unknown } }).message.content;
        read.push(typeof content === 'string' ? content : JSON.stringify(content));
      }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, { interrupt: async () => {} });
  };

  return { createQuery, script };
}

async function withRun(
  runTest: (context: { script: Scripted; sent: NormalizedMessage[] }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-steer-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
    steerGraceMs: GRACE_MS,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    await runTest({ script, sent });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await wait(10);
  }
  assert.ok(condition(), 'condition never became true');
}

const completes = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'complete').length;
const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const assistantText = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'done', duration_ms: 1, num_turns: 1 });

test('a steering message reaches the CLI while the turn is running', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    await waitFor(() => script.read.length === 1);

    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'also mention tests', {}), true);

    await waitFor(() => script.read.length === 2);
    assert.equal(script.read[1], 'also mention tests');
  });
});

test('there is nothing to steer once the process has been let go', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(result());
    await waitFor(() => script.released());
    assert.equal(completes(sent), 1);

    assert.equal(await steerClaudeSDKSession(SESSION_ID, 'too late', {}), false);
  });
  assert.equal(await steerClaudeSDKSession('no-such-session', 'hello', {}), false);
});

test('a turn without steering still ends at its result', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(result());

    await waitFor(() => script.released());
    assert.equal(completes(sent), 1);
  });
});

test('a steered turn waits briefly, then ends when no turn of its own follows', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    await waitFor(() => script.read.length === 1);
    await steerClaudeSDKSession(SESSION_ID, 'fold this in', {});

    // The CLI took the message between tool calls: only one result comes.
    script.emit(result());
    await wait(GRACE_MS / 2);
    assert.equal(completes(sent), 0, 'not announced while a turn of its own may still start');
    assert.equal(script.released(), false);

    await waitFor(() => script.released());
    assert.equal(completes(sent), 1);
  });
});

test('a steered message that starts its own turn is not cut off by the first result', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    await waitFor(() => script.read.length === 1);
    await steerClaudeSDKSession(SESSION_ID, 'run this next', {});

    // No tool call was left, so the CLI answers it in a second turn.
    script.emit(result());
    script.emit(init());
    script.emit(assistantText('second turn'));
    await wait(GRACE_MS * 2);
    assert.equal(completes(sent), 0, 'the first result did not end the run');
    assert.equal(script.released(), false, 'the input stays open for the second turn');

    script.emit(result());
    await waitFor(() => script.released());
    assert.equal(completes(sent), 1, 'one completion for the whole run');
  });
});
