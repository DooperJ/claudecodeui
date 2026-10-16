import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeClaudeListedModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { normalizeCodexListedModels } from '@/modules/providers/list/codex/codex-models.provider.js';

test('Codex normalization drops hidden models and duplicates and keeps reported efforts', () => {
  const { models, defaultModelId } = normalizeCodexListedModels([
    {
      model: 'gpt-a',
      displayName: 'GPT A',
      description: 'A',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'low' }],
    },
    { model: 'internal', hidden: true },
    { model: 'gpt-a', displayName: 'Duplicate' },
    { id: 'gpt-b' },
    { displayName: 'no id' },
  ]);

  assert.deepEqual(models, [
    { id: 'gpt-a', name: 'GPT A', description: 'A', effort: ['low', 'medium'], defaultEffort: 'medium' },
    { id: 'gpt-b', name: 'gpt-b', effort: [] },
  ]);
  assert.equal(defaultModelId, 'gpt-a');
});

test('Codex normalization ignores a default effort the model does not list', () => {
  const { models } = normalizeCodexListedModels([
    { model: 'm', defaultReasoningEffort: 'ultra', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
  ]);

  assert.equal(models[0].defaultEffort, undefined);
});

test('Claude normalization shows each resolved model once and adds ultracode only with xhigh', () => {
  const { models, defaultModelId } = normalizeClaudeListedModels([
    { value: 'default', displayName: 'Default (recommended)', description: 'Sonnet', resolvedModel: 'claude-sonnet-x', supportedEffortLevels: ['low', 'high'] },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet', resolvedModel: 'claude-sonnet-x', supportedEffortLevels: ['low', 'high'] },
    { value: 'opus', displayName: 'Opus', description: 'Opus', resolvedModel: 'claude-opus-x', supportedEffortLevels: ['low', 'xhigh'] },
    { value: 'haiku', displayName: 'Haiku', description: 'Haiku' },
  ]);

  assert.deepEqual(models.map((model) => [model.id, model.name, model.effort]), [
    ['claude-sonnet-x', 'Sonnet', ['low', 'high']],
    ['claude-opus-x', 'Opus', ['low', 'xhigh', 'ultracode']],
    ['haiku', 'Haiku', []],
  ]);
  assert.equal(defaultModelId, 'claude-sonnet-x');
});

test('Claude normalization keeps aliases when the SDK reports no resolved model', () => {
  const { models, defaultModelId } = normalizeClaudeListedModels([
    { value: 'default', displayName: 'Default' },
    { value: 'opus', displayName: 'Opus' },
  ]);

  assert.deepEqual(models.map((model) => model.id), ['default', 'opus']);
  assert.equal(defaultModelId, 'default');
});
