import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * `chat.steer` hands a message to the turn that is running instead of
 * queueing it. It is accepted like `chat.send` (receipt plus a run event) when
 * a running turn takes it, and refused with STEER_UNAVAILABLE otherwise so the
 * client can send it the ordinary way.
 */

const SESSION_ID = 'steer-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

type SteerCall = { provider: string; sessionId: string; command: string; options: Record<string, unknown> };

async function withGateway(
  steerResult: boolean,
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    steers: SteerCall[];
    release: () => void;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-steer-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const steers: SteerCall[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    const socket = createFakeSocket();
    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: async () => { await held; },
          steer: async (provider: string, sessionId: string, command: string, options: Record<string, unknown>) => {
            steers.push({ provider, sessionId, command, options });
            return steerResult;
          },
          hasBackgroundWork: () => false,
          getPendingApprovalsForSession: () => [],
        } as never,
      },
    );
    await runTest({ socket, steers, release });
  } finally {
    release();
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const send = (socket: ReturnType<typeof createFakeSocket>, frame: Record<string, unknown>) =>
  socket.emit('message', JSON.stringify(frame));

const startTurn = async (socket: ReturnType<typeof createFakeSocket>) => {
  send(socket, { type: 'chat.send', sessionId: SESSION_ID, clientMessageId: 'cm-turn', content: 'start', options: {} });
  await settle();
};

test('a steering message is handed to the running turn, acknowledged and recorded as a run event', async () => {
  await withGateway(true, async ({ socket, steers }) => {
    await startTurn(socket);

    send(socket, { type: 'chat.steer', sessionId: SESSION_ID, clientMessageId: 'cm-steer', content: 'also add tests', options: {} });
    await settle();

    assert.equal(steers.length, 1);
    assert.deepEqual(
      { provider: steers[0].provider, sessionId: steers[0].sessionId, command: steers[0].command },
      { provider: 'claude', sessionId: SESSION_ID, command: 'also add tests' },
    );

    const accepted = socket.frames.filter((frame) => frame.kind === 'chat_accepted' && frame.clientMessageId === 'cm-steer');
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].duplicate, false);

    const echo = socket.frames.find((frame) => frame.kind === 'text' && frame.role === 'user' && frame.content === 'also add tests');
    assert.equal(echo?.id, 'local_cm-steer', 'the sending page folds it into its own row');
  });
});

test('a session with no running turn refuses to steer', async () => {
  await withGateway(true, async ({ socket, steers }) => {
    send(socket, { type: 'chat.steer', sessionId: SESSION_ID, clientMessageId: 'cm-idle', content: 'hello', options: {} });
    await settle();

    const failure = socket.frames.find((frame) => frame.kind === 'protocol_error');
    assert.equal(failure?.code, 'STEER_UNAVAILABLE');
    assert.equal(failure?.clientMessageId, 'cm-idle');
    assert.equal(steers.length, 0);
  });
});

test('a runtime that cannot take the message makes the client send it normally', async () => {
  await withGateway(false, async ({ socket }) => {
    await startTurn(socket);

    send(socket, { type: 'chat.steer', sessionId: SESSION_ID, clientMessageId: 'cm-late', content: 'late', options: {} });
    await settle();

    const failure = socket.frames.find((frame) => frame.kind === 'protocol_error');
    assert.equal(failure?.code, 'STEER_UNAVAILABLE');
    assert.equal(failure?.clientMessageId, 'cm-late');
    assert.equal(socket.frames.some((frame) => frame.kind === 'chat_accepted' && frame.clientMessageId === 'cm-late'), false);
    assert.equal(socket.frames.some((frame) => frame.content === 'late'), false, 'no echo for a message that was not taken');
  });
});

test('retrying an accepted steering message does not steer twice', async () => {
  await withGateway(true, async ({ socket, steers }) => {
    await startTurn(socket);
    const frame = { type: 'chat.steer', sessionId: SESSION_ID, clientMessageId: 'cm-once', content: 'once', options: {} };

    send(socket, frame);
    await settle();
    send(socket, frame);
    await settle();

    assert.equal(steers.length, 1);
    const acks = socket.frames.filter((candidate) => candidate.kind === 'chat_accepted' && candidate.clientMessageId === 'cm-once');
    assert.equal(acks.length, 2);
    assert.equal(acks[1].duplicate, true);
  });
});

test('a steering message needs text and a session', async () => {
  await withGateway(true, async ({ socket, steers }) => {
    await startTurn(socket);

    send(socket, { type: 'chat.steer', clientMessageId: 'cm-nosession', content: 'x', options: {} });
    send(socket, { type: 'chat.steer', sessionId: SESSION_ID, clientMessageId: 'cm-empty', content: '   ', options: {} });
    await settle();

    const codes = socket.frames.filter((frame) => frame.kind === 'protocol_error').map((frame) => frame.code);
    assert.deepEqual(codes, ['SESSION_ID_REQUIRED', 'STEER_UNAVAILABLE']);
    assert.equal(steers.length, 0);
  });
});
