/**
 * The sloppers wire contract. Anything that speaks these schemas can replace
 * any component: a Rust collector, a TUI office, a native client.
 *
 * Compatibility: the server accepts messages from collectors within the same
 * major protocol version and ignores unknown object keys, so adding optional
 * fields is non-breaking.
 */
export const PROTOCOL_VERSION = 1;

export * from './core.js';
export * from './collector.js';
export * from './web.js';
