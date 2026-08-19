import type { SessionSnapshot, Visibility } from '@sloppers/protocol';

/**
 * Enforce the owner's visibility settings. This runs in the collector, at
 * the source: a hidden field never leaves the machine at all.
 */
export function applyVisibility(snapshot: SessionSnapshot, vis: Visibility): SessionSnapshot {
  const out: SessionSnapshot = {
    id: snapshot.id,
    harness: snapshot.harness,
    state: snapshot.state,
    startedAt: snapshot.startedAt,
    lastActivityAt: snapshot.lastActivityAt,
  };
  if (vis.title && snapshot.title) out.title = snapshot.title;
  if (vis.project && snapshot.project) out.project = snapshot.project;
  if (vis.branch && snapshot.branch) out.branch = snapshot.branch;
  if (vis.model && snapshot.model) out.model = snapshot.model;
  // All three ride the one `tokens` switch. `usage` is the same spend broken
  // out by day and model — the field the server's ledger now actually banks,
  // so omitting it would silently zero a sharing member — and `activeMinutes`
  // is minute-resolution presence derived from the same token stream. A
  // member who turned token sharing off must not start leaking any of it
  // through the newer fields.
  if (vis.tokens) {
    if (snapshot.tokens) out.tokens = snapshot.tokens;
    if (snapshot.usage) out.usage = snapshot.usage;
    if (snapshot.activeMinutes) out.activeMinutes = snapshot.activeMinutes;
  }
  return out;
}
