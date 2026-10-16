import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderModelSyncService } from '@/modules/providers/services/provider-model-sync.service.js';
import type {
  LLMProvider,
  ProviderAuthStatus,
  ProviderModelDiscovery,
  StoredProviderModelSyncState,
} from '@/shared/types.js';

const discovery = (ids: string[], cliVersion = '1.0.0'): ProviderModelDiscovery => ({
  models: ids.map((id) => ({ id, name: id, effort: [] })),
  cliVersion,
  sdkVersion: '2.0.0',
});

const signedIn = (email = 'a@example.com'): ProviderAuthStatus => ({
  installed: true,
  provider: 'codex',
  authenticated: true,
  email,
  method: 'oauth',
});

/** Fake store that records what the service persists, with the real success/failure semantics. */
const createStore = () => {
  const state = new Map<LLMProvider, StoredProviderModelSyncState>();
  const replaced: ProviderModelDiscovery[] = [];
  return {
    state,
    replaced,
    replaceSyncedProviderModels(provider: LLMProvider, result: ProviderModelDiscovery, authIdentity: string | null) {
      replaced.push(result);
      const next: StoredProviderModelSyncState = {
        status: 'success',
        lastAttemptAt: '2026-01-01 00:00:00',
        lastSuccessAt: '2026-01-01 00:00:00',
        error: null,
        cliVersion: result.cliVersion,
        sdkVersion: result.sdkVersion,
        modelCount: result.models.length,
        authIdentity,
        defaultModelId: null,
      };
      state.set(provider, next);
      return next;
    },
    getProviderModelSyncState: (provider: LLMProvider) => state.get(provider) ?? null,
    recordProviderModelSyncFailure(provider: LLMProvider, error: string) {
      const previous = state.get(provider);
      state.set(provider, {
        status: 'error',
        lastAttemptAt: '2026-01-01 00:00:00',
        lastSuccessAt: previous?.lastSuccessAt ?? null,
        error,
        cliVersion: previous?.cliVersion ?? null,
        sdkVersion: previous?.sdkVersion ?? null,
        modelCount: previous?.modelCount ?? 0,
        authIdentity: previous?.authIdentity ?? null,
        defaultModelId: previous?.defaultModelId ?? null,
      });
    },
  };
};

const createHarness = (options: {
  discover: () => Promise<ProviderModelDiscovery>;
  status?: () => ProviderAuthStatus;
  cliVersion?: () => string;
}) => {
  const store = createStore();
  let clock = Date.parse('2026-01-01T00:00:00Z');
  let discoverCalls = 0;
  const service = createProviderModelSyncService({
    store,
    now: () => clock,
    resolveProvider: () => ({
      auth: { getStatus: async () => (options.status ?? signedIn)() },
      models: {
        getSupportedModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
        getCurrentActiveModel: async () => ({ model: '' }),
        discoverModels: async () => {
          discoverCalls += 1;
          return options.discover();
        },
        readRuntimeVersions: async () => ({ cliVersion: (options.cliVersion ?? (() => '1.0.0'))(), sdkVersion: '2.0.0' }),
      },
    }) as never,
  });
  return {
    service,
    store,
    advance: (ms: number) => { clock += ms; },
    calls: () => discoverCalls,
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a successful sync persists the catalog and reports success', async () => {
  const { service, store } = createHarness({ discover: async () => discovery(['a', 'b']) });

  const state = await service.syncProvider('codex');

  assert.equal(state.status, 'success');
  assert.equal(state.modelCount, 2);
  assert.equal(store.replaced.length, 1);
});

test('failures and empty answers never replace the stored catalog', async () => {
  let mode: 'ok' | 'fail' | 'empty' = 'ok';
  const { service, store } = createHarness({
    discover: async () => {
      if (mode === 'fail') {
        throw new Error('timeout');
      }
      return discovery(mode === 'empty' ? [] : ['a']);
    },
  });
  await service.syncProvider('codex');

  mode = 'fail';
  const failed = await service.syncProvider('codex');
  mode = 'empty';
  const empty = await service.syncProvider('codex');

  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'timeout');
  assert.ok(failed.lastSuccessAt, 'last success survives a failure');
  assert.equal(empty.status, 'error');
  assert.equal(store.replaced.length, 1, 'only the first, successful sync wrote the catalog');
});

test('a signed-out provider fails the sync without querying the runtime', async () => {
  const { service, calls } = createHarness({
    discover: async () => discovery(['a']),
    status: () => ({ ...signedIn(), authenticated: false }),
  });

  const state = await service.syncProvider('codex');

  assert.equal(state.status, 'error');
  assert.equal(calls(), 0);
});

test('concurrent syncs of one provider share a single query', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { service, calls } = createHarness({
    discover: async () => {
      await gate;
      return discovery(['a']);
    },
  });

  const first = service.syncProvider('codex');
  const second = service.syncProvider('codex');
  await settle();
  assert.equal(service.getState('codex').status, 'syncing');
  release();
  await Promise.all([first, second]);

  assert.equal(calls(), 1);
  assert.equal(service.getState('codex').status, 'success');
});

test('syncIfStale syncs once, then only after the CLI version or the account changes', async () => {
  let version = '1.0.0';
  let email = 'a@example.com';
  const { service, calls, advance } = createHarness({
    discover: async () => discovery(['a'], version),
    status: () => signedIn(email),
    cliVersion: () => version,
  });

  await service.syncIfStale('codex');
  await settle();
  assert.equal(calls(), 1, 'first run syncs');

  advance(60_000);
  await service.syncIfStale('codex');
  await settle();
  assert.equal(calls(), 1, 'unchanged versions and account do not resync');

  version = '1.1.0';
  advance(60_000);
  await service.syncIfStale('codex');
  await settle();
  assert.equal(calls(), 2, 'a new CLI version resyncs');

  email = 'b@example.com';
  advance(60_000);
  await service.syncIfStale('codex');
  await settle();
  assert.equal(calls(), 3, 'a different account (re-login) resyncs');
});

test('syncIfStale backs off after an automatic failure but a manual sync does not', async () => {
  const { service, calls, advance } = createHarness({
    discover: async () => { throw new Error('down'); },
  });

  await service.syncIfStale('codex');
  await settle();
  advance(60_000);
  await service.syncIfStale('codex');
  await settle();
  assert.equal(calls(), 1, 'inside the back-off window');

  await service.syncProvider('codex');
  assert.equal(calls(), 2, 'manual sync ignores the back-off');

  advance(10 * 60_000);
  await service.syncIfStale('codex');
  await settle();
  assert.equal(calls(), 3, 'after the window it retries');
});

test('unsupported providers cannot be synced', () => {
  const service = createProviderModelSyncService({
    store: createStore(),
    resolveProvider: () => ({
      auth: { getStatus: async () => signedIn() },
      models: { getSupportedModels: async () => ({ OPTIONS: [], DEFAULT: '' }), getCurrentActiveModel: async () => ({ model: '' }) },
    }) as never,
  });

  assert.equal(service.isSyncSupported('cursor'), false);
  assert.throws(() => service.syncProvider('cursor'), /does not support model sync/);
});
