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

const SESSION_ID = 'ack-session';

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

/** Holds every stub run open until released, so the run stays "processing". */
async function withGateway(
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; runCount: () => number; release: () => void }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-send-ack-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  let runs = 0;
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
          run: async () => { runs += 1; await held; },
          hasBackgroundWork: () => false,
          getPendingApprovalsForSession: () => [],
        } as never,
      },
    );
    await runTest({ socket, runCount: () => runs, release });
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

test('an accepted chat.send is acknowledged and recorded as the run\'s first event', async () => {
  await withGateway(async ({ socket }) => {
    send(socket, { type: 'chat.send', sessionId: SESSION_ID, clientMessageId: 'cm-1', content: 'hello', options: {} });
    await settle();

    const accepted = socket.frames.find((frame) => frame.kind === 'chat_accepted');
    assert.deepEqual(
      { sessionId: accepted?.sessionId, clientMessageId: accepted?.clientMessageId, duplicate: accepted?.duplicate },
      { sessionId: SESSION_ID, clientMessageId: 'cm-1', duplicate: false },
    );

    const userEvent = socket.frames.find((frame) => frame.kind === 'text' && frame.role === 'user');
    assert.equal(userEvent?.id, 'local_cm-1');
    assert.equal(userEvent?.content, 'hello');
    assert.equal(userEvent?.seq, 1);
  });
});

test('a page that subscribes mid-run replays the user message with the rest of the turn', async () => {
  await withGateway(async ({ socket }) => {
    send(socket, { type: 'chat.send', sessionId: SESSION_ID, clientMessageId: 'cm-2', content: 'question', options: {} });
    await settle();

    const refreshedPage = createFakeSocket();
    handleChatConnection(
      refreshedPage as never,
      { user: { id: 1 } } as never,
      { runtime: { hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [] } as never },
    );
    send(refreshedPage, { type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] });
    await settle();

    assert.equal(refreshedPage.frames[0]?.kind, 'chat_subscribed');
    assert.equal(refreshedPage.frames[0]?.isProcessing, true);
    const replayed = refreshedPage.frames.find((frame) => frame.kind === 'text' && frame.role === 'user');
    assert.equal(replayed?.content, 'question');
  });
});

test('retrying an accepted message re-acknowledges it without starting a second turn', async () => {
  await withGateway(async ({ socket, runCount }) => {
    const frame = { type: 'chat.send', sessionId: SESSION_ID, clientMessageId: 'cm-3', content: 'once', options: {} };
    send(socket, frame);
    await settle();
    send(socket, frame);
    await settle();

    const acks = socket.frames.filter((candidate) => candidate.kind === 'chat_accepted');
    assert.equal(acks.length, 2);
    assert.equal(acks[1]?.duplicate, true);
    assert.equal(runCount(), 1);
    assert.equal(socket.frames.filter((candidate) => candidate.kind === 'text').length, 1);
  });
});

test('a refused message reports the failure against its clientMessageId', async () => {
  await withGateway(async ({ socket }) => {
    send(socket, { type: 'chat.send', sessionId: 'no-such-session', clientMessageId: 'cm-4', content: 'x', options: {} });
    await settle();

    const failure = socket.frames.find((frame) => frame.kind === 'protocol_error');
    assert.equal(failure?.code, 'SESSION_NOT_FOUND');
    assert.equal(failure?.clientMessageId, 'cm-4');
  });
});

test('a second message while a run is going is refused with its own clientMessageId', async () => {
  await withGateway(async ({ socket }) => {
    send(socket, { type: 'chat.send', sessionId: SESSION_ID, clientMessageId: 'cm-5', content: 'first', options: {} });
    await settle();
    send(socket, { type: 'chat.send', sessionId: SESSION_ID, clientMessageId: 'cm-6', content: 'second', options: {} });
    await settle();

    const failure = socket.frames.find((frame) => frame.kind === 'protocol_error');
    assert.equal(failure?.code, 'RUN_IN_PROGRESS');
    assert.equal(failure?.clientMessageId, 'cm-6');
  });
});

test('a client without clientMessageId keeps working and gets no server echo', async () => {
  await withGateway(async ({ socket, runCount }) => {
    send(socket, { type: 'chat.send', sessionId: SESSION_ID, content: 'legacy', options: {} });
    await settle();

    assert.equal(runCount(), 1);
    assert.equal(socket.frames.some((frame) => frame.kind === 'chat_accepted'), false);
    assert.equal(socket.frames.some((frame) => frame.kind === 'text'), false);
  });
});
