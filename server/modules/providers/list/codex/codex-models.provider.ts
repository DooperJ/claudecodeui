import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { CodexListedModel } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  DiscoveredProviderModel,
  ProviderCurrentActiveModel,
  ProviderModelDiscovery,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  AppError,
  buildDefaultProviderCurrentActiveModel,
  readInstalledPackageVersion,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/** Curated Codex catalog shipped as immutable CloudCLI defaults. */
export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: 'Our most capable model for complex, demanding work.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-sol',
      label: 'GPT-6 Sol',
      description: 'Workhorse model for coding and everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      description: 'Fast and affordable model for easier tasks.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: 'Latest frontier agentic coding model.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fast and affordable agentic coding model.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.5',
      label: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4',
      label: 'GPT-5.4',
      description: 'Strong model for everyday coding.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

/**
 * Converts `model/list` entries into discovered models: hidden entries are
 * dropped, ids are de-duplicated (first wins), and effort levels are exactly
 * what the runtime reported. Exported for tests.
 */
export function normalizeCodexListedModels(listed: CodexListedModel[]): {
  models: DiscoveredProviderModel[];
  defaultModelId?: string;
} {
  const models: DiscoveredProviderModel[] = [];
  const seen = new Set<string>();
  let defaultModelId: string | undefined;

  for (const entry of listed) {
    const id = readOptionalString(entry.model) ?? readOptionalString(entry.id);
    if (!id || entry.hidden === true || seen.has(id)) {
      continue;
    }
    seen.add(id);

    const effort: string[] = [];
    if (Array.isArray(entry.supportedReasoningEfforts)) {
      for (const item of entry.supportedReasoningEfforts) {
        const level = readOptionalString(readObjectRecord(item)?.reasoningEffort);
        if (level && !effort.includes(level)) {
          effort.push(level);
        }
      }
    }
    const defaultEffort = readOptionalString(entry.defaultReasoningEffort);

    models.push({
      id,
      name: readOptionalString(entry.displayName) ?? id,
      ...(readOptionalString(entry.description) ? { description: readOptionalString(entry.description) } : {}),
      effort,
      ...(defaultEffort && effort.includes(defaultEffort) ? { defaultEffort } : {}),
    });
    if (entry.isDefault === true && !defaultModelId) {
      defaultModelId = id;
    }
  }

  return { models, ...(defaultModelId ? { defaultModelId } : {}) };
}

const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

/** Provider registry model adapter for Codex predefined models and active config. */
export class CodexProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return CODEX_PREDEFINED_MODELS;
  }

  async readRuntimeVersions(): Promise<{ cliVersion: string | null; sdkVersion: string | null }> {
    // The app-server launcher and the conversation SDK both come from these
    // two packages, so their manifests identify what actually runs.
    return {
      cliVersion: readInstalledPackageVersion('@openai/codex', '@openai/codex/bin/codex.js'),
      sdkVersion: readInstalledPackageVersion('@openai/codex-sdk'),
    };
  }

  async discoverModels(): Promise<ProviderModelDiscovery> {
    const listed = await codexAppServer.listModels();
    const { models, defaultModelId } = normalizeCodexListedModels(listed);
    if (models.length === 0) {
      throw new AppError('Codex reported no selectable models.', {
        code: 'MODEL_DISCOVERY_EMPTY',
        statusCode: 502,
      });
    }

    return { models, defaultModelId, ...(await this.readRuntimeVersions()) };
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }
}
