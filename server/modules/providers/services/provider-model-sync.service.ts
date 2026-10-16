import { providerModelsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderAuthStatus,
  ProviderModelSyncState,
  StoredProviderModelSyncState,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Catalog and state persistence the sync needs, narrowed so tests can fake it. */
type ProviderModelSyncStore = Pick<
  typeof providerModelsDb,
  'replaceSyncedProviderModels' | 'getProviderModelSyncState' | 'recordProviderModelSyncFailure'
>;

type ProviderModelSyncDependencies = {
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models' | 'auth'>;
  store?: ProviderModelSyncStore;
  now?: () => number;
};

/** What caused a sync; `manual` ignores the failure back-off. */
export type ProviderModelSyncReason = 'manual' | 'auto';

/** After a failed automatic attempt, wait this long before trying again on its own. */
const AUTO_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/** Auth-status polling can call `syncIfStale` often; re-check a provider at most this often. */
const STALENESS_CHECK_INTERVAL_MS = 30 * 1000;

const SYNCABLE_PROVIDERS: LLMProvider[] = ['claude', 'codex'];

/** SQLite `CURRENT_TIMESTAMP` is UTC without a zone marker; make it a real ISO instant. */
const toIsoTimestamp = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};

const readAuthIdentity = (status: ProviderAuthStatus): string => (
  `${status.method ?? ''}|${status.email ?? ''}`
);

const toPublicState = (
  state: StoredProviderModelSyncState | null,
  syncing: boolean,
): ProviderModelSyncState => ({
  status: syncing ? 'syncing' : state?.status ?? 'never',
  lastAttemptAt: toIsoTimestamp(state?.lastAttemptAt ?? null),
  lastSuccessAt: toIsoTimestamp(state?.lastSuccessAt ?? null),
  error: state?.error ?? null,
  cliVersion: state?.cliVersion ?? null,
  sdkVersion: state?.sdkVersion ?? null,
  modelCount: state?.modelCount ?? 0,
});

/**
 * Creates the model catalog sync service.
 *
 * It queries the runtime CloudCLI actually executes (Claude Agent SDK, Codex
 * app-server), writes the answer through one repository transaction, and keeps
 * the previous catalog whenever a query fails or comes back empty. At most one
 * sync per provider runs at a time; concurrent callers share its result.
 */
export const createProviderModelSyncService = (dependencies: ProviderModelSyncDependencies = {}) => {
  const resolveProvider = dependencies.resolveProvider ?? providerRegistry.resolveProvider;
  const store = dependencies.store ?? providerModelsDb;
  const now = dependencies.now ?? Date.now;
  const inFlight = new Map<LLMProvider, Promise<ProviderModelSyncState>>();
  const lastCheckedAt = new Map<LLMProvider, number>();

  /** Whether this provider's runtime can list its models. */
  const isSyncSupported = (provider: LLMProvider): boolean => (
    typeof resolveProvider(provider).models.discoverModels === 'function'
  );

  const getState = (provider: LLMProvider): ProviderModelSyncState => (
    toPublicState(store.getProviderModelSyncState(provider), inFlight.has(provider))
  );

  const runSync = async (provider: LLMProvider): Promise<void> => {
    const { models, auth } = resolveProvider(provider);
    try {
      const status = await auth.getStatus();
      if (!status.installed) {
        throw new AppError(`The ${provider} CLI is not installed.`, {
          code: 'PROVIDER_NOT_INSTALLED',
          statusCode: 409,
        });
      }
      if (!status.authenticated) {
        throw new AppError(`${provider} is not signed in, so its models cannot be listed.`, {
          code: 'PROVIDER_NOT_AUTHENTICATED',
          statusCode: 401,
        });
      }

      const discovery = await models.discoverModels!();
      // Defense in depth: adapters reject on empty, but replacing the stored
      // catalog with nothing must stay impossible whatever an adapter returns.
      if (discovery.models.length === 0) {
        throw new AppError(`${provider} reported no selectable models.`, {
          code: 'MODEL_DISCOVERY_EMPTY',
          statusCode: 502,
        });
      }

      store.replaceSyncedProviderModels(provider, discovery, readAuthIdentity(status));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[provider-model-sync] ${provider} sync failed: ${message}`);
      store.recordProviderModelSyncFailure(provider, message);
    }
  };

  /**
   * Syncs one provider now and resolves to the resulting state. A failed query
   * does not throw: it is recorded in the state's `error` and the stored
   * catalog is left as it was. Concurrent calls share one in-flight sync.
   */
  const syncProvider = (provider: LLMProvider): Promise<ProviderModelSyncState> => {
    if (!isSyncSupported(provider)) {
      throw new AppError(`${provider} does not support model sync.`, {
        code: 'MODEL_SYNC_NOT_SUPPORTED',
        statusCode: 400,
      });
    }

    const running = inFlight.get(provider);
    if (running) {
      return running;
    }

    const started = (async () => {
      try {
        await runSync(provider);
      } finally {
        inFlight.delete(provider);
      }
      return getState(provider);
    })();
    inFlight.set(provider, started);
    return started;
  };

  /**
   * Starts a background sync when the stored catalog may be out of date:
   * never synced, a different CLI or SDK than last time, or a different
   * account (re-login). Does nothing for providers that are not installed and
   * signed in, while a sync is running, or shortly after an automatic failure.
   * Never throws; callers fire and forget.
   */
  const syncIfStale = async (provider: LLMProvider, knownStatus?: ProviderAuthStatus): Promise<void> => {
    try {
      if (!isSyncSupported(provider) || inFlight.has(provider)) {
        return;
      }
      if (now() - (lastCheckedAt.get(provider) ?? 0) < STALENESS_CHECK_INTERVAL_MS) {
        return;
      }
      lastCheckedAt.set(provider, now());

      const { models, auth } = resolveProvider(provider);
      const status = knownStatus ?? await auth.getStatus();
      if (!status.installed || !status.authenticated) {
        return;
      }

      const stored = store.getProviderModelSyncState(provider);
      if (stored?.status === 'error' && stored.lastAttemptAt) {
        const lastAttempt = Date.parse(`${stored.lastAttemptAt.replace(' ', 'T')}Z`);
        if (now() - lastAttempt < AUTO_RETRY_BACKOFF_MS) {
          return;
        }
      }

      const versions = await models.readRuntimeVersions?.() ?? { cliVersion: null, sdkVersion: null };
      const upToDate = Boolean(stored?.lastSuccessAt)
        && stored?.cliVersion === versions.cliVersion
        && stored?.sdkVersion === versions.sdkVersion
        && stored?.authIdentity === readAuthIdentity(status);
      if (!upToDate) {
        void syncProvider(provider);
      }
    } catch (error) {
      console.error(`[provider-model-sync] ${provider} staleness check failed:`, error);
    }
  };

  /** Runs `syncIfStale` for every syncable provider; used once at server start. */
  const syncStaleProviders = async (): Promise<void> => {
    for (const provider of SYNCABLE_PROVIDERS) {
      await syncIfStale(provider);
    }
  };

  return { isSyncSupported, getState, syncProvider, syncIfStale, syncStaleProviders };
};

/** Shared sync service used by Providers routes, the models service, and server startup. */
export const providerModelSyncService = createProviderModelSyncService();
