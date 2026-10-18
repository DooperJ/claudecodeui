import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Issue #582: when the chat socket dropped, nothing in the UI changed, so a
 * message typed during the outage was lost without the user noticing. The
 * provider now reports `connectionStatus`, which tells a lost connection
 * (`disconnected`) apart from the first handshake (`connecting`, which must not
 * flash a warning on every page load) and from the socket it swaps on purpose
 * when the auth token is refreshed (which must not read as lost either).
 */

type FakeAuth = { user: { id: number } | null; token: string | null; isLoading: boolean };

// Mutable so a test can hand the provider a refreshed token or sign the user
// out. `user` keeps one identity throughout; a fresh object would rebuild
// `connect` on every render.
const AUTH = vi.hoisted(() => {
  const user = { id: 1 };
  return { user, current: { user, token: 'token-1', isLoading: false } as FakeAuth };
});

vi.mock('@/modules/auth', () => ({
  useAuth: () => AUTH.current,
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send() {}

  // A real socket closed by the page still fires `close`; firing it here means
  // a swap that forgot to detach its handler would be caught.
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  serverOpens() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** The network or the server ends the socket (or refuses the handshake). */
  serverDrops() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const { WebSocketProvider, useWebSocket } = await import('@/shared/context/WebSocketContext');

/** Every status the provider rendered, in order, so a one-render flash is caught too. */
let seen: string[] = [];
let isConnected: boolean | null = null;

function RecordStatus() {
  const value = useWebSocket();
  seen.push(String(value.connectionStatus));
  useEffect(() => {
    isConnected = value.isConnected;
  });
  return null;
}

const renderProvider = () => render(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
const socket = (index: number) => FakeWebSocket.instances[index] as FakeWebSocket;
const lastStatus = () => seen[seen.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  seen = [];
  isConnected = null;
  AUTH.current = { user: AUTH.user, token: 'token-1', isLoading: false };
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('the first handshake reads as connecting, never as a lost connection', () => {
  renderProvider();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false);

  act(() => socket(0).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.equal(isConnected, true);
  assert.ok(!seen.includes('disconnected'), `statuses seen: ${seen.join(', ')}`);
});

test('a dropped socket reads as disconnected through every failed retry, until one opens', () => {
  renderProvider();
  act(() => socket(0).serverOpens());

  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');
  assert.equal(isConnected, false);

  // The retry is still handshaking: the connection is not back yet.
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(lastStatus(), 'disconnected');

  // The server is still unreachable.
  act(() => socket(1).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 3);
  act(() => socket(2).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.equal(isConnected, true);
});

test('a first attempt that fails reads as disconnected', () => {
  renderProvider();
  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  act(() => { vi.advanceTimersByTime(3000); });
  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
});

test('a token refresh swaps the socket without ever reading as a lost connection', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());

  AUTH.current = { ...AUTH.current, token: 'token-2' };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);

  assert.equal(FakeWebSocket.instances.length, 2, 'the refreshed token opened a new socket');
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED, 'the old-token socket was closed');
  assert.match(socket(1).url, /token=token-2/);
  // The new socket is still handshaking: not live yet, but not lost either.
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false);

  // No reconnect was scheduled for the socket closed on purpose.
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2);

  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.ok(!seen.includes('disconnected'), `statuses seen: ${seen.join(', ')}`);
});

test('signing out while the socket is down does not carry the drop into the next sign-in', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());
  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  // The session expires (or the user signs out) during the outage.
  AUTH.current = { user: null, token: null, isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(lastStatus(), 'connecting', 'no connection is lost while nobody is signed in');
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect while signed out');

  // Signing in again starts a fresh handshake, which must not read as lost.
  seen = [];
  AUTH.current = { user: AUTH.user, token: 'token-2', isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.ok(!seen.includes('disconnected'), `statuses seen after sign-in: ${seen.join(', ')}`);
  assert.equal(lastStatus(), 'connecting');

  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
});

test('signing out while connected stops reporting a live connection', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());
  assert.equal(isConnected, true);

  AUTH.current = { user: null, token: null, isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED, 'the socket was closed on sign-out');
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false, 'isConnected no longer reports the closed socket as live');
});

/**
 * Sending on a socket that is down: `sendMessage` says whether the frame went
 * out, and `waitForConnection` lets a send ride out a reconnect that is already
 * on its way instead of failing during the few seconds it takes.
 */
type SocketApi = ReturnType<typeof useWebSocket>;

function renderWithApi() {
  const api: { current: SocketApi | null } = { current: null };
  function Capture() {
    api.current = useWebSocket();
    return null;
  }
  render(<WebSocketProvider><Capture /></WebSocketProvider>);
  return () => api.current as SocketApi;
}

test('sendMessage reports whether the frame reached an open socket', () => {
  const getApi = renderWithApi();
  assert.equal(getApi().sendMessage({ type: 'x' }), false, 'still handshaking');

  act(() => socket(0).serverOpens());
  assert.equal(getApi().sendMessage({ type: 'x' }), true);

  act(() => socket(0).serverDrops());
  assert.equal(getApi().sendMessage({ type: 'x' }), false, 'dropped');
});

test('waitForConnection replaces a dropped socket at once and resolves when it opens', async () => {
  const getApi = renderWithApi();
  act(() => socket(0).serverOpens());
  act(() => socket(0).serverDrops());
  assert.equal(FakeWebSocket.instances.length, 1);

  let result: boolean | null = null;
  act(() => { void getApi().waitForConnection(6000).then((connected) => { result = connected; }); });

  // No 3 second retry timer: the wait itself starts the new socket.
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(result, null);

  await act(async () => { socket(1).serverOpens(); });
  assert.equal(result, true);
});

test('waitForConnection gives up with false when the socket does not come back in time', async () => {
  const getApi = renderWithApi();
  act(() => socket(0).serverOpens());
  act(() => socket(0).serverDrops());

  let result: boolean | null = null;
  act(() => { void getApi().waitForConnection(6000).then((connected) => { result = connected; }); });
  await act(async () => { vi.advanceTimersByTime(6000); });

  assert.equal(result, false);
});

test('waitForConnection resolves immediately on an open socket', async () => {
  const getApi = renderWithApi();
  act(() => socket(0).serverOpens());

  let result: boolean | null = null;
  await act(async () => { result = await getApi().waitForConnection(6000); });

  assert.equal(result, true);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('a page back from a long stay in the background replaces its socket', () => {
  renderWithApi();
  act(() => socket(0).serverOpens());

  const setVisibility = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  act(() => setVisibility('hidden'));
  act(() => { vi.advanceTimersByTime(20_000); });
  act(() => setVisibility('visible'));

  assert.equal(FakeWebSocket.instances.length, 2, 'the socket that may have died silently is replaced');
});

test('a short trip to another tab keeps the socket', () => {
  renderWithApi();
  act(() => socket(0).serverOpens());

  const setVisibility = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  act(() => setVisibility('hidden'));
  act(() => { vi.advanceTimersByTime(3_000); });
  act(() => setVisibility('visible'));

  assert.equal(FakeWebSocket.instances.length, 1);
});
