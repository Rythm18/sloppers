import type { HarnessAdapter } from '../core/types.js';
import { createClaudeCodeAdapter } from './claude-code.js';
import { createCodexAdapter } from './codex.js';

/**
 * Every harness the collector understands. Adding a harness means writing
 * one adapter file and listing it here — see CONTRIBUTING.md.
 */
export function builtinAdapters(home?: string): HarnessAdapter[] {
  return [createClaudeCodeAdapter(home), createCodexAdapter(home)];
}

export { createClaudeCodeAdapter, createCodexAdapter };
