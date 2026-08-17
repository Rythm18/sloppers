/**
 * Programmatic surface of the collector, exported for tests and for anyone
 * embedding session discovery elsewhere. The CLI in cli.ts is the intended
 * front door.
 */
export { builtinAdapters, createClaudeCodeAdapter, createCodexAdapter } from './adapters/index.js';
export { configPath, loadConfig, newConfig, saveConfig } from './config.js';
export { deriveSessionState } from './core/state.js';
export { newCursor, readAppended } from './core/tailer.js';
export { SessionTracker } from './core/tracker.js';
export type { HarnessAdapter, LastEventKind, SessionAccumulator } from './core/types.js';
export { applyVisibility } from './core/visibility.js';
export { seedTracker, watchSessions } from './core/watcher.js';
export { startDaemon } from './daemon.js';
export { parseShareTarget, redeemPairingCode, wsUrlFor } from './net/pair.js';
