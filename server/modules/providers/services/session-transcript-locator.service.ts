import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

/** How often a freshly started session is probed for its transcript file. */
const TRANSCRIPT_POLL_INTERVAL_MS = 400;

/** Give up probing after this long; the filesystem watcher remains the fallback. */
const TRANSCRIPT_POLL_TIMEOUT_MS = 30_000;

/**
 * Provider-native ids become part of a file name, so only characters a real id
 * can contain are accepted. Anything else is refused rather than joined into a path.
 */
const SAFE_PROVIDER_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** Providers whose history is read from a per-session JSONL file that can be located by id. */
function hasLocatableTranscript(provider: string): provider is 'claude' | 'codex' {
  return provider === 'claude' || provider === 'codex';
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isFile();
  } catch {
    return false;
  }
}

/** Claude keeps `<id>.jsonl` directly inside one directory per project. */
async function findClaudeTranscript(homeDir: string, providerSessionId: string): Promise<string | null> {
  const projectsRoot = path.join(homeDir, '.claude', 'projects');
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(projectsRoot, entry.name, `${providerSessionId}.jsonl`);
    if (await isFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Codex partitions rollouts by date (`YYYY/MM/DD/rollout-<time>-<id>.jsonl`).
 * Walking newest-first finds a session that was just started almost at once.
 */
async function findCodexTranscript(directory: string, providerSessionId: string): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  entries.sort((left, right) => right.name.localeCompare(left.name));
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findCodexTranscript(entryPath, providerSessionId);
      if (nested) {
        return nested;
      }
    } else if (entry.name.endsWith('.jsonl') && entry.name.includes(providerSessionId)) {
      return entryPath;
    }
  }

  return null;
}

/**
 * Finds the transcript file a provider wrote for a provider-native session id,
 * or null when it has not been created yet (or the provider has no such file).
 *
 * Used by the session transcript locator below and exported for its tests.
 */
export async function locateTranscriptFile(
  provider: LLMProvider,
  providerSessionId: string,
  homeDir: string = os.homedir(),
): Promise<string | null> {
  if (!hasLocatableTranscript(provider) || !SAFE_PROVIDER_SESSION_ID.test(providerSessionId)) {
    return null;
  }

  return provider === 'claude'
    ? findClaudeTranscript(homeDir, providerSessionId)
    : findCodexTranscript(path.join(homeDir, '.codex', 'sessions'), providerSessionId);
}

/** One in-flight indexing attempt per session, so concurrent history reads share it. */
const indexingInFlight = new Map<string, Promise<boolean>>();

/** Sessions currently being probed by `indexWhenAvailable`, so one run starts one probe. */
const sessionsBeingProbed = new Set<string>();

async function indexSessionTranscript(sessionId: string): Promise<boolean> {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session?.provider_session_id || !hasLocatableTranscript(session.provider)) {
    return false;
  }

  if (session.jsonl_path && await isFile(session.jsonl_path)) {
    return true;
  }

  const filePath = await locateTranscriptFile(session.provider, session.provider_session_id);
  if (!filePath) {
    return false;
  }

  const result = await sessionSynchronizerService.synchronizeProviderFile(session.provider, filePath);
  if (!result.indexed) {
    // The file exists but its first lines are not written yet.
    return false;
  }

  void broadcastSessionUpserted(sessionId).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[SessionTranscriptLocator] Failed to broadcast indexed session', { sessionId, error: message });
  });
  return true;
}

/**
 * Makes a session's transcript path known without waiting for the filesystem
 * watcher, which polls every few seconds.
 *
 * Until `jsonl_path` is on the session row the history endpoint has nothing to
 * read, so a page refreshed in that window shows an empty conversation. Looking
 * the file up by its provider-native id closes the window.
 */
export const sessionTranscriptLocatorService = {
  /**
   * Indexes the session's transcript if it exists and is not indexed yet.
   * Resolves true when the session has a readable transcript path afterwards.
   * Used by the sessions service before reading history for a session whose row has no path.
   */
  ensureIndexed(sessionId: string): Promise<boolean> {
    const existing = indexingInFlight.get(sessionId);
    if (existing) {
      return existing;
    }

    const attempt = indexSessionTranscript(sessionId).finally(() => {
      indexingInFlight.delete(sessionId);
    });
    indexingInFlight.set(sessionId, attempt);
    return attempt;
  },

  /**
   * Probes for the transcript until it appears (or the timeout passes).
   * Called by the server composition root when a run learns its provider id,
   * which is the moment the CLI starts creating the file.
   */
  indexWhenAvailable(sessionId: string): void {
    if (sessionsBeingProbed.has(sessionId)) {
      return;
    }
    sessionsBeingProbed.add(sessionId);

    const deadline = Date.now() + TRANSCRIPT_POLL_TIMEOUT_MS;
    const probe = async (): Promise<void> => {
      try {
        if (await this.ensureIndexed(sessionId)) {
          sessionsBeingProbed.delete(sessionId);
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[SessionTranscriptLocator] Probe failed', { sessionId, error: message });
      }

      if (Date.now() >= deadline) {
        sessionsBeingProbed.delete(sessionId);
        return;
      }

      // Never keep the process alive just to look for a file.
      setTimeout(() => void probe(), TRANSCRIPT_POLL_INTERVAL_MS).unref?.();
    };

    void probe();
  },
};
