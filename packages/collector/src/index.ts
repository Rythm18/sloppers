/**
 * Programmatic surface of the collector, exported for tests and for anyone
 * embedding session discovery elsewhere. The CLI in cli.ts is the intended
 * front door.
 */
export { builtinAdapters, createClaudeCodeAdapter, createCodexAdapter } from './adapters/index.js';
export {
  addPairing,
  type CollectorConfig,
  configPath,
  isCatchAll,
  loadConfig,
  matchesPairing,
  newConfig,
  type PairingConfig,
  saveConfig,
} from './config.js';
export { deriveSessionState } from './core/state.js';
export { newCursor, readAppended } from './core/tailer.js';
export { SessionTracker } from './core/tracker.js';
export type {
  HarnessAdapter,
  LastEventKind,
  RoutableSession,
  SessionAccumulator,
} from './core/types.js';
export { applyVisibility } from './core/visibility.js';
export { seedTracker, watchSessions } from './core/watcher.js';
export { routeSessions, routingOrder, startDaemon, unroutedSessions } from './daemon.js';
export { parseShareTarget, redeemPairingCode, wsUrlFor } from './net/pair.js';
