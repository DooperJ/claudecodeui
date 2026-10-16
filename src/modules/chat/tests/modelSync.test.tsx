import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import '@/modules/i18n';
import ModelLibraryPanel from '@/modules/chat/modals/ModelLibraryPanel';
import type {
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition,
  ProviderModelSyncState,
} from '@/shared/types';

/** Model Library behavior for providers whose catalog is synced from their own runtime. */

afterEach(cleanup);

const syncState = (overrides: Partial<ProviderModelSyncState> = {}): ProviderModelSyncState => ({
  status: 'success',
  lastAttemptAt: '2026-01-01T00:00:00.000Z',
  lastSuccessAt: '2026-01-01T00:00:00.000Z',
  error: null,
  cliVersion: '0.162.1',
  sdkVersion: '0.162.1',
  modelCount: 1,
  ...overrides,
});

const catalog = (sync: ProviderModelSyncState, synced: boolean): ProviderModelsDefinition => ({
  OPTIONS: [{ value: 'gpt-6-sol', label: 'GPT-6 Sol', isCustom: false, origin: synced ? 'synced' : 'builtin' }],
  DEFAULT: 'gpt-6-sol',
  EFFORT_LEVELS: [],
  SYNC: sync,
});

const createActions = (overrides: Partial<ProviderModelActions> = {}): ProviderModelActions => ({
  create: async () => {},
  update: async () => {},
  remove: async () => {},
  setCustomModelsOnly: async () => {},
  sync: async () => {},
  refresh: async () => {},
  ...overrides,
});

test('a synced catalog is labelled as read from the runtime and shows versions', () => {
  render(
    <ModelLibraryPanel
      initialProvider="codex"
      providerModelCatalog={{ codex: catalog(syncState(), true) }}
      actions={createActions()}
    />,
  );

  screen.getByText('Synced models');
  screen.getByText(/CLI 0.162.1 · SDK 0.162.1/);
  assert.ok(screen.getByRole('button', { name: /Sync models/ }));
});

test('the sync button asks the server to sync the selected provider', async () => {
  const calls: LLMProvider[] = [];
  render(
    <ModelLibraryPanel
      initialProvider="codex"
      providerModelCatalog={{ codex: catalog(syncState(), true) }}
      actions={createActions({ sync: async (provider) => { calls.push(provider); } })}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /Sync models/ }));
  await waitFor(() => assert.deepEqual(calls, ['codex']));
});

test('a failed sync shows its reason and says the previous list was kept', () => {
  render(
    <ModelLibraryPanel
      initialProvider="codex"
      providerModelCatalog={{ codex: catalog(syncState({ status: 'error', error: 'codex is not signed in' }), true) }}
      actions={createActions()}
    />,
  );

  screen.getByText(/Sync failed: codex is not signed in/);
});

test('providers that cannot sync show no sync controls', () => {
  render(
    <ModelLibraryPanel
      initialProvider="cursor"
      providerModelCatalog={{
        cursor: { OPTIONS: [{ value: 'auto', label: 'Auto', isCustom: false }], DEFAULT: 'auto' },
      }}
      actions={createActions()}
    />,
  );

  assert.equal(screen.queryByRole('button', { name: /Sync models/ }), null);
});

test('an empty catalog explains how to sync', () => {
  render(
    <ModelLibraryPanel
      initialProvider="codex"
      providerModelCatalog={{
        codex: { OPTIONS: [], DEFAULT: '', SYNC: syncState({ status: 'never', lastSuccessAt: null }) },
      }}
      actions={createActions()}
    />,
  );

  screen.getByText(/No models have been synced yet/);
  screen.getByText('Not synced yet');
});

test('a sync running on the server is polled until it finishes', async () => {
  let refreshes = 0;
  render(
    <ModelLibraryPanel
      initialProvider="codex"
      providerModelCatalog={{ codex: catalog(syncState({ status: 'syncing' }), false) }}
      actions={createActions({ refresh: async () => { refreshes += 1; } })}
    />,
  );

  await waitFor(() => assert.ok(refreshes >= 1), { timeout: 5000 });
});
