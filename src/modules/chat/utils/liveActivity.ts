import type { ChatMessage, LiveStage } from '@/shared/types';

/** Longest target shown in the status line before it is cut with an ellipsis. */
const MAX_TARGET_LENGTH = 70;

/** Input fields that name what a tool is working on, most telling first. */
const TARGET_FIELDS = [
  'file_path',
  'notebook_path',
  'path',
  'command',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
] as const;

function parseToolInput(toolInput: unknown): Record<string, unknown> | null {
  if (typeof toolInput === 'string') {
    try {
      const parsed: unknown = JSON.parse(toolInput);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return toolInput && typeof toolInput === 'object' ? toolInput as Record<string, unknown> : null;
}

/** The part of a path a reader recognises: its last two segments. */
function shortenPath(value: string): string {
  const segments = value.split('/').filter(Boolean);
  return segments.length > 2 ? segments.slice(-2).join('/') : value;
}

/**
 * What a tool call is working on, in a few words: the file, command, pattern or
 * address its input names. Null when the input names nothing recognisable.
 */
export function readToolTarget(toolInput: unknown): string | null {
  const input = parseToolInput(toolInput);
  if (!input) {
    return null;
  }

  for (const field of TARGET_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string' || !value.trim()) {
      continue;
    }

    const firstLine = value.trim().split('\n')[0];
    const text = field.endsWith('path') ? shortenPath(firstLine) : firstLine;
    return text.length > MAX_TARGET_LENGTH ? `${text.slice(0, MAX_TARGET_LENGTH - 1)}…` : text;
  }
  return null;
}

/**
 * Works out the current stage of a running turn from what has already arrived.
 *
 * A request waiting for the user's approval wins over everything, then
 * background-only work. Otherwise the newest row decides: a tool call without
 * its result is that tool working, a tool result means the model is reading it,
 * and anything else (the user's message, thinking, a reply that may be followed
 * by more) is the model thinking.
 */
export function describeLiveStage(
  messages: ChatMessage[],
  options: { background: boolean; pendingPermissionTool: string | null },
): LiveStage {
  if (options.pendingPermissionTool) {
    return { kind: 'permission', tool: options.pendingPermissionTool };
  }
  if (options.background) {
    return { kind: 'background' };
  }

  const latest = messages[messages.length - 1];
  if (latest?.isToolUse && latest.toolName) {
    return latest.toolResult
      ? { kind: 'toolResult' }
      : { kind: 'tool', tool: latest.toolName, target: readToolTarget(latest.toolInput) };
  }
  return { kind: 'thinking' };
}
