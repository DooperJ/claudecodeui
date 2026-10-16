import { readFile } from 'node:fs/promises';
import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import spawn from 'cross-spawn';

import { sessionsDb } from '@/modules/database/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  DiscoveredProviderModel,
  ProviderCurrentActiveModel,
  ProviderModelDiscovery,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  AppError,
  buildDefaultProviderCurrentActiveModel,
  isPlaceholderProviderModel,
  readInstalledPackageVersion,
  readOptionalString,
  stripAnsiSequences,
} from '@/shared/utils.js';

/**
 * Ultracode is not one of the SDK's reasoning-effort levels. Selecting it runs the turn at
 * `xhigh` effort with standing dynamic-workflow orchestration, which the Claude runtime
 * translates into the session-scoped `ultracode` setting. It is therefore only offered on
 * models this catalog already marks as xhigh-capable.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

const ULTRACODE_EFFORT_OPTION = {
  value: CLAUDE_ULTRACODE_EFFORT,
  description: 'Highest effort plus standing workflow orchestration.',
};

export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable 5 when available, otherwise the latest Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable 5',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Latest Opus model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient Claude model for simple tasks.',
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Use Opus while planning, then switch to Sonnet for execution.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
/** How long the catalog query may take before the Claude subprocess is closed. */
const CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS = 60_000;

/**
 * One `supportedModels()` entry. `resolvedModel` is only present on newer SDKs,
 * so it is read defensively; every field is untrusted runtime output.
 */
type ClaudeListedModel = {
  value?: unknown;
  displayName?: unknown;
  description?: unknown;
  resolvedModel?: unknown;
  supportedEffortLevels?: unknown;
};

/**
 * Collapses aliases of one real model into a single discovered model.
 *
 * Entries sharing a `resolvedModel` (for example `default` and `sonnet`) become
 * one row whose id is that real model. Without `resolvedModel` the alias value
 * is the id. The row is named after a non-`default` alias when there is one,
 * and its effort levels are those the runtime reported; `ultracode` is added
 * only where `xhigh` is reported, matching how the runtime expands it. The
 * runtime's `default` entry decides the catalog default. Exported for tests.
 */
export function normalizeClaudeListedModels(listed: ClaudeListedModel[]): {
  models: DiscoveredProviderModel[];
  defaultModelId?: string;
} {
  const groups = new Map<string, ClaudeListedModel[]>();
  const idByAlias = new Map<string, string>();
  for (const entry of listed) {
    const value = readOptionalString(entry.value);
    if (!value) {
      continue;
    }
    const id = readOptionalString(entry.resolvedModel) ?? value;
    idByAlias.set(value, id);
    groups.set(id, [...(groups.get(id) ?? []), entry]);
  }

  const models: DiscoveredProviderModel[] = [];
  for (const [id, entries] of groups) {
    const preferred = entries.find((entry) => entry.value !== 'default') ?? entries[0];
    const withEffort = entries.find((entry) => (
      Array.isArray(entry.supportedEffortLevels) && entry.supportedEffortLevels.length > 0
    ));
    const effort = Array.isArray(withEffort?.supportedEffortLevels)
      ? withEffort.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
      : [];
    if (effort.includes('xhigh')) {
      effort.push(CLAUDE_ULTRACODE_EFFORT);
    }

    models.push({
      id,
      name: readOptionalString(preferred.displayName) ?? id,
      ...(readOptionalString(preferred.description)
        ? { description: readOptionalString(preferred.description) }
        : {}),
      effort,
    });
  }

  const defaultModelId = idByAlias.get('default');
  return { models, ...(defaultModelId ? { defaultModelId } : {}) };
}

/**
 * Asks the real Claude Code subprocess for its model list without running a
 * turn. The prompt stream never yields, so no request reaches the API, and
 * `persistSession: false` plus a neutral `cwd` keep the query from writing a
 * transcript that would show up as a project or session.
 */
async function queryClaudeSupportedModels(): Promise<ClaudeListedModel[]> {
  const abortController = new AbortController();
  // An async iterable whose first read waits until the query is aborted, then ends.
  const neverPrompt: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<never>>((resolve) => {
        abortController.signal.addEventListener(
          'abort',
          () => resolve({ done: true, value: undefined }),
          { once: true },
        );
      }),
    }),
  };

  const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  const claudeQuery = query({
    prompt: neverPrompt,
    options: {
      abortController,
      persistSession: false,
      cwd: os.tmpdir(),
      env: { ...process.env },
      // User settings carry gateway/env configuration that decides which
      // models the account is offered; project and local ones do not.
      settingSources: ['user'],
      ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
    },
  });

  const timer = setTimeout(() => abortController.abort(), CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS);
  try {
    const supported = await Promise.race([
      claudeQuery.supportedModels(),
      new Promise<never>((_, reject) => {
        abortController.signal.addEventListener('abort', () => {
          reject(new AppError('Claude did not return its model list in time.', {
            code: 'MODEL_DISCOVERY_TIMEOUT',
            statusCode: 504,
          }));
        }, { once: true });
      }),
    ]);
    return supported as ClaudeListedModel[];
  } finally {
    clearTimeout(timer);
    claudeQuery.close();
    abortController.abort();
  }
}

type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderProviderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderProviderModel(messageModel) ? messageModel : null;
};

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsiSequences(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderProviderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderProviderModel(modelTag) ? modelTag : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

export class ClaudeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // Source-controlled fallback. The real catalog comes from `discoverModels`
    // (persistence-free, so it creates no jsonl session) via the model sync.
    return CLAUDE_PREDEFINED_MODELS;
  }

  async readRuntimeVersions(): Promise<{ cliVersion: string | null; sdkVersion: string | null }> {
    // The CLI is the executable the runtime hands the SDK (CLAUDE_CLI_PATH or
    // `claude` on PATH), not whatever else is installed on the machine.
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude';
    let cliVersion: string | null = null;
    try {
      const result = spawn.sync(cliPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
      cliVersion = /\d+\.\d+\.\d+\S*/.exec(String(result.stdout ?? ''))?.[0] ?? null;
    } catch {
      cliVersion = null;
    }

    return {
      cliVersion,
      sdkVersion: readInstalledPackageVersion('@anthropic-ai/claude-agent-sdk'),
    };
  }

  async discoverModels(): Promise<ProviderModelDiscovery> {
    const { models, defaultModelId } = normalizeClaudeListedModels(await queryClaudeSupportedModels());
    if (models.length === 0) {
      throw new AppError('Claude reported no selectable models.', {
        code: 'MODEL_DISCOVERY_EMPTY',
        statusCode: 502,
      });
    }

    return { models, defaultModelId, ...(await this.readRuntimeVersions()) };
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
