import { expect, test } from 'vitest';

import { describeLiveStage, readToolTarget } from '@/modules/chat/utils/liveActivity';
import type { ChatMessage } from '@/shared/types';

const idle = { background: false, pendingPermissionTool: null };

const toolCall = (toolName: string, toolInput: unknown, withResult = false): ChatMessage => ({
  type: 'tool',
  content: '',
  timestamp: '2026-01-01T00:00:00.000Z',
  isToolUse: true,
  toolName,
  toolInput,
  ...(withResult ? { toolResult: { content: 'ok', isError: false } } : {}),
});

const text = (type: 'user' | 'assistant'): ChatMessage => ({ type, content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' });

test('a new turn with nothing back yet is thinking', () => {
  expect(describeLiveStage([text('user')], idle)).toEqual({ kind: 'thinking' });
  expect(describeLiveStage([], idle)).toEqual({ kind: 'thinking' });
});

test('a tool call still waiting for its result names the tool and what it works on', () => {
  const stage = describeLiveStage([text('user'), toolCall('Read', JSON.stringify({ file_path: '/repo/src/app/main.ts' }))], idle);
  expect(stage).toEqual({ kind: 'tool', tool: 'Read', target: 'app/main.ts' });
});

test('a tool call that has its result means the model is reading it', () => {
  expect(describeLiveStage([toolCall('Bash', { command: 'ls' }, true)], idle)).toEqual({ kind: 'toolResult' });
});

test('a reply that has arrived is followed by thinking again, not by a stale tool stage', () => {
  const stage = describeLiveStage([toolCall('Read', {}, true), text('assistant')], idle);
  expect(stage).toEqual({ kind: 'thinking' });
});

test('a request waiting for approval outranks the newest row, and background work outranks the rows', () => {
  const rows = [toolCall('Bash', { command: 'rm -rf x' })];
  expect(describeLiveStage(rows, { background: false, pendingPermissionTool: 'Bash' })).toEqual({ kind: 'permission', tool: 'Bash' });
  expect(describeLiveStage(rows, { background: true, pendingPermissionTool: null })).toEqual({ kind: 'background' });
});

test('the target comes from the first field that names something, cut when long', () => {
  expect(readToolTarget({ command: 'npm test\nsecond line' })).toBe('npm test');
  expect(readToolTarget({ pattern: 'TODO', path: '/a/b/c' })).toBe('b/c');
  expect(readToolTarget({ command: 'x'.repeat(200) })?.length).toBe(70);
  expect(readToolTarget({ unrelated: 1 })).toBe(null);
  expect(readToolTarget('not json')).toBe(null);
  expect(readToolTarget(undefined)).toBe(null);
});
