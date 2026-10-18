import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { locateTranscriptFile } from '@/modules/providers/services/session-transcript-locator.service.js';

async function withHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'transcript-locator-'));
  try {
    await run(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test('locateTranscriptFile finds a Claude transcript in any project directory', async () => {
  await withHome(async (homeDir) => {
    const projectDir = path.join(homeDir, '.claude', 'projects', '-work-app');
    await mkdir(projectDir, { recursive: true });
    await mkdir(path.join(homeDir, '.claude', 'projects', '-other'), { recursive: true });
    const transcript = path.join(projectDir, 'abc-123.jsonl');
    await writeFile(transcript, '{}\n');

    assert.equal(await locateTranscriptFile('claude', 'abc-123', homeDir), transcript);
    assert.equal(await locateTranscriptFile('claude', 'missing', homeDir), null);
  });
});

test('locateTranscriptFile finds a Codex rollout inside the date partitions', async () => {
  await withHome(async (homeDir) => {
    const dayDir = path.join(homeDir, '.codex', 'sessions', '2026', '10', '17');
    await mkdir(dayDir, { recursive: true });
    const rollout = path.join(dayDir, 'rollout-2026-10-17T10-00-00-thread-9.jsonl');
    await writeFile(rollout, '{}\n');

    assert.equal(await locateTranscriptFile('codex', 'thread-9', homeDir), rollout);
  });
});

test('locateTranscriptFile refuses ids that could escape the transcript directory', async () => {
  await withHome(async (homeDir) => {
    assert.equal(await locateTranscriptFile('claude', '../../etc/passwd', homeDir), null);
    assert.equal(await locateTranscriptFile('claude', 'a/b', homeDir), null);
  });
});

test('locateTranscriptFile reports nothing for providers without a locatable transcript', async () => {
  await withHome(async (homeDir) => {
    assert.equal(await locateTranscriptFile('opencode', 'abc', homeDir), null);
    assert.equal(await locateTranscriptFile('cursor', 'abc', homeDir), null);
  });
});
