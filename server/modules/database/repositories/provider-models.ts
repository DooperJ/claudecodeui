import { getConnection } from '@/modules/database/connection.js';
import type {
  CustomProviderModelEffort,
  CustomProviderModelInput,
  CustomProviderModelRecord,
  LLMProvider,
  ProviderModelDiscovery,
  StoredProviderModelSyncState,
} from '@/shared/types.js';

type CustomProviderModelRow = {
  id: number;
  provider: LLMProvider;
  model_id: string;
  model_name: string;
  sort_order: number;
  effort_values: string | null;
  effort_default: string | null;
  description: string | null;
};

type SyncStateRow = {
  provider: LLMProvider;
  status: StoredProviderModelSyncState['status'];
  last_attempt_at: string | null;
  last_success_at: string | null;
  error: string | null;
  cli_version: string | null;
  sdk_version: string | null;
  auth_identity: string | null;
  default_model_id: string | null;
  model_count: number;
};

const CUSTOM_PROVIDER_MODEL_COLUMNS = `
  id, provider, model_id, model_name, sort_order, effort_values, effort_default, description
`;

/** Row origins in `provider_models.source`; only `manual` rows are user-owned. */
const MANUAL_SOURCE = 'manual';
const SYNCED_SOURCE = 'synced';

/**
 * Decodes the stored effort columns. Anything that is not a non-empty JSON
 * array of strings reads back as "no metadata" rather than failing the whole
 * catalog, so one hand-edited row cannot break every model picker.
 */
const readStoredEffort = (row: CustomProviderModelRow): CustomProviderModelEffort | null => {
  if (!row.effort_values) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.effort_values);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }
  const values = parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (values.length === 0) {
    return null;
  }

  return row.effort_default && values.includes(row.effort_default)
    ? { values, default: row.effort_default }
    : { values };
};

/** Encodes effort metadata into the two nullable columns; no levels means NULL for both. */
const toStoredEffortColumns = (
  effort: CustomProviderModelEffort | null | undefined,
): { values: string | null; defaultValue: string | null } => {
  if (!effort || effort.values.length === 0) {
    return { values: null, defaultValue: null };
  }

  return {
    values: JSON.stringify(effort.values),
    defaultValue: effort.default ?? null,
  };
};

const toCustomProviderModelRecord = (
  row: CustomProviderModelRow,
): CustomProviderModelRecord => ({
  recordId: row.id,
  provider: row.provider,
  modelId: row.model_id,
  model: row.model_name,
  sortOrder: row.sort_order,
  effort: readStoredEffort(row),
  description: row.description,
});

const toSyncState = (row: SyncStateRow): StoredProviderModelSyncState => ({
  status: row.status,
  lastAttemptAt: row.last_attempt_at,
  lastSuccessAt: row.last_success_at,
  error: row.error,
  cliVersion: row.cli_version,
  sdkVersion: row.sdk_version,
  modelCount: row.model_count,
  authIdentity: row.auth_identity,
  defaultModelId: row.default_model_id,
});

const readCustomProviderModelRow = (
  provider: LLMProvider,
  recordId: number,
): CustomProviderModelRow | null => {
  const row = getConnection().prepare(`
    SELECT ${CUSTOM_PROVIDER_MODEL_COLUMNS}
    FROM provider_models
    WHERE provider = ? AND id = ? AND source = '${MANUAL_SOURCE}'
  `).get(provider, recordId) as CustomProviderModelRow | undefined;

  return row ?? null;
};

/**
 * Provider-model persistence API consumed by the Providers module.
 *
 * Rows come in two kinds. `manual` rows are user-created and are the only ones
 * the custom-model methods see or change. `synced` rows are written solely by
 * `replaceSyncedProviderModels` from the provider runtime's own catalog; a
 * sync never touches manual rows. Source-controlled fallback models never enter
 * this table. Model-id changes are propagated
 * to stored sessions, while deletion replaces affected session selections with
 * the predefined default supplied by the Providers service.
 */
export const providerModelsDb = {
  listCustomProviderModels(provider: LLMProvider): CustomProviderModelRecord[] {
    const rows = getConnection().prepare(`
      SELECT ${CUSTOM_PROVIDER_MODEL_COLUMNS}
      FROM provider_models
      WHERE provider = ? AND source = '${MANUAL_SOURCE}'
      ORDER BY sort_order ASC, lower(model_name) ASC, id ASC
    `).all(provider) as CustomProviderModelRow[];

    return rows.map(toCustomProviderModelRecord);
  },

  getCustomProviderModel(
    provider: LLMProvider,
    recordId: number,
  ): CustomProviderModelRecord | null {
    const row = readCustomProviderModelRow(provider, recordId);
    return row ? toCustomProviderModelRecord(row) : null;
  },

  findCustomProviderModelByModelId(
    provider: LLMProvider,
    modelId: string,
  ): CustomProviderModelRecord | null {
    const row = getConnection().prepare(`
      SELECT ${CUSTOM_PROVIDER_MODEL_COLUMNS}
      FROM provider_models
      WHERE provider = ? AND model_id = ? AND source = '${MANUAL_SOURCE}'
    `).get(provider, modelId) as CustomProviderModelRow | undefined;

    return row ? toCustomProviderModelRecord(row) : null;
  },

  createCustomProviderModel(
    provider: LLMProvider,
    input: CustomProviderModelInput,
  ): CustomProviderModelRecord {
    const db = getConnection();
    const nextOrder = db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
      FROM provider_models
      WHERE provider = ? AND source = '${MANUAL_SOURCE}'
    `).get(provider) as { next_order: number };

    const effort = toStoredEffortColumns(input.effort);
    const result = db.prepare(`
      INSERT INTO provider_models (
        provider, model_id, model_name, sort_order, effort_values, effort_default
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      provider,
      input.id,
      input.model,
      nextOrder.next_order,
      effort.values,
      effort.defaultValue,
    );

    const row = readCustomProviderModelRow(provider, Number(result.lastInsertRowid));
    if (!row) {
      throw new Error('Created provider model could not be read back.');
    }

    return toCustomProviderModelRecord(row);
  },

  updateCustomProviderModel(
    provider: LLMProvider,
    recordId: number,
    input: CustomProviderModelInput,
  ): CustomProviderModelRecord | null {
    const db = getConnection();
    const update = db.transaction(() => {
      const previous = readCustomProviderModelRow(provider, recordId);
      if (!previous) {
        return null;
      }

      db.prepare(`
        UPDATE provider_models
        SET model_id = ?, model_name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE provider = ? AND id = ? AND source = '${MANUAL_SOURCE}'
      `).run(input.id, input.model, provider, recordId);

      // An omitted `effort` keeps the stored levels so clients that only edit
      // the name or id cannot wipe them; `null` explicitly clears them.
      if (input.effort !== undefined) {
        const effort = toStoredEffortColumns(input.effort);
        db.prepare(`
          UPDATE provider_models
          SET effort_values = ?, effort_default = ?
          WHERE provider = ? AND id = ?
        `).run(effort.values, effort.defaultValue, provider, recordId);
      }

      if (previous.model_id !== input.id) {
        db.prepare(`
          UPDATE sessions
          SET model = ?, updated_at = CURRENT_TIMESTAMP
          WHERE provider = ? AND model = ?
        `).run(input.id, provider, previous.model_id);
      }

      return readCustomProviderModelRow(provider, recordId);
    });

    const row = update();
    return row ? toCustomProviderModelRecord(row) : null;
  },

  deleteCustomProviderModel(
    provider: LLMProvider,
    recordId: number,
    fallbackModelId: string,
  ): CustomProviderModelRecord | null {
    const db = getConnection();
    const remove = db.transaction(() => {
      const row = readCustomProviderModelRow(provider, recordId);
      if (!row) {
        return null;
      }

      // The effort is cleared alongside the model because it was chosen for the
      // deleted model; replaced sessions resume on the fallback model's default.
      db.prepare(`
        UPDATE sessions
        SET model = ?, effort = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE provider = ? AND model = ?
      `).run(fallbackModelId, provider, row.model_id);

      db.prepare(`
        DELETE FROM provider_models
        WHERE provider = ? AND id = ? AND source = '${MANUAL_SOURCE}'
      `).run(provider, recordId);

      return row;
    });

    const row = remove();
    return row ? toCustomProviderModelRecord(row) : null;
  },
  /** Synced models the runtime still reports, in the order it reported them. */
  listAvailableSyncedProviderModels(provider: LLMProvider): CustomProviderModelRecord[] {
    const rows = getConnection().prepare(`
      SELECT ${CUSTOM_PROVIDER_MODEL_COLUMNS}
      FROM provider_models
      WHERE provider = ? AND source = '${SYNCED_SOURCE}' AND is_available = 1
      ORDER BY sort_order ASC, id ASC
    `).all(provider) as CustomProviderModelRow[];

    return rows.map(toCustomProviderModelRecord);
  },

  /**
   * Applies one complete, successful catalog query in a single transaction.
   *
   * Reported models are inserted or refreshed (name, description, effort) and
   * marked available; synced rows the runtime no longer reports are kept but
   * marked unavailable so history and ids survive. A reported id that a user
   * already added manually is skipped: the manual row keeps its own settings.
   * Sessions are never modified.
   */
  replaceSyncedProviderModels(
    provider: LLMProvider,
    discovery: ProviderModelDiscovery,
    authIdentity: string | null,
  ): StoredProviderModelSyncState {
    const db = getConnection();
    const apply = db.transaction(() => {
      const manualIds = new Set(
        (db.prepare(`
          SELECT model_id FROM provider_models WHERE provider = ? AND source = '${MANUAL_SOURCE}'
        `).all(provider) as { model_id: string }[]).map((row) => row.model_id),
      );

      db.prepare(`
        UPDATE provider_models SET is_available = 0, updated_at = CURRENT_TIMESTAMP
        WHERE provider = ? AND source = '${SYNCED_SOURCE}'
      `).run(provider);

      const upsert = db.prepare(`
        INSERT INTO provider_models (
          provider, model_id, model_name, sort_order, effort_values, effort_default,
          source, is_available, description
        )
        VALUES (?, ?, ?, ?, ?, ?, '${SYNCED_SOURCE}', 1, ?)
        ON CONFLICT(provider, model_id) DO UPDATE SET
          model_name = excluded.model_name,
          sort_order = excluded.sort_order,
          effort_values = excluded.effort_values,
          effort_default = excluded.effort_default,
          description = excluded.description,
          is_available = 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE provider_models.source = '${SYNCED_SOURCE}'
      `);

      let storedCount = 0;
      discovery.models.forEach((model, index) => {
        if (manualIds.has(model.id)) {
          return;
        }
        const effort = toStoredEffortColumns(
          model.effort.length > 0
            ? { values: model.effort, ...(model.defaultEffort ? { default: model.defaultEffort } : {}) }
            : null,
        );
        upsert.run(
          provider,
          model.id,
          model.name,
          index,
          effort.values,
          effort.defaultValue,
          model.description ?? null,
        );
        storedCount += 1;
      });

      const defaultModelId = discovery.defaultModelId && !manualIds.has(discovery.defaultModelId)
        ? discovery.defaultModelId
        : null;
      db.prepare(`
        INSERT INTO provider_model_sync_state (
          provider, status, last_attempt_at, last_success_at, error,
          cli_version, sdk_version, auth_identity, default_model_id, model_count
        )
        VALUES (?, 'success', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, ?, ?, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          status = 'success',
          last_attempt_at = CURRENT_TIMESTAMP,
          last_success_at = CURRENT_TIMESTAMP,
          error = NULL,
          cli_version = excluded.cli_version,
          sdk_version = excluded.sdk_version,
          auth_identity = excluded.auth_identity,
          default_model_id = excluded.default_model_id,
          model_count = excluded.model_count
      `).run(
        provider,
        discovery.cliVersion,
        discovery.sdkVersion,
        authIdentity,
        defaultModelId,
        storedCount,
      );
    });

    apply();
    return this.getProviderModelSyncState(provider) as StoredProviderModelSyncState;
  },

  getProviderModelSyncState(provider: LLMProvider): StoredProviderModelSyncState | null {
    const row = getConnection().prepare(`
      SELECT provider, status, last_attempt_at, last_success_at, error, cli_version,
             sdk_version, auth_identity, default_model_id, model_count
      FROM provider_model_sync_state
      WHERE provider = ?
    `).get(provider) as SyncStateRow | undefined;

    return row ? toSyncState(row) : null;
  },

  /**
   * Records a failed attempt. The synced rows, `last_success_at`, and the
   * versions and account of the last good sync are left exactly as they were.
   */
  recordProviderModelSyncFailure(provider: LLMProvider, error: string): void {
    getConnection().prepare(`
      INSERT INTO provider_model_sync_state (provider, status, last_attempt_at, error)
      VALUES (?, 'error', CURRENT_TIMESTAMP, ?)
      ON CONFLICT(provider) DO UPDATE SET
        status = 'error',
        last_attempt_at = CURRENT_TIMESTAMP,
        error = excluded.error
    `).run(provider, error);
  },
};
