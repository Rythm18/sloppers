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
  if (vis.tokens && snapshot.tokens) out.tokens = snapshot.tokens;
  return out;
}
