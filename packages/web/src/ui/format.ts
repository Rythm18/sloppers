import type { PresenceState, SessionSnapshot, TokenTotals } from '@sloppers/protocol';
import { billedTokens } from '@sloppers/protocol';

/** 1234 → "1.2k", 5_400_000 → "5.4M" — leaderboard-friendly. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(n);
}

function trim(n: number): string {
  const fixed = n >= 100 ? n.toFixed(0) : n.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

export function burned(tokens: TokenTotals): string {
  return formatTokens(billedTokens(tokens));
}

export const PRESENCE_LABEL: Record<PresenceState, string> = {
  active: 'at the desk',
  grinding: 'agents cooking',
  'needs-attention': 'agent needs input',
  afk: 'afk',
  offline: 'offline',
};

export const PRESENCE_VAR: Record<PresenceState, string> = {
  active: 'var(--p-active)',
  grinding: 'var(--p-grinding)',
  'needs-attention': 'var(--p-attention)',
  afk: 'var(--p-afk)',
  offline: 'var(--p-offline)',
};

export function harnessLabel(id: string): string {
  if (id === 'claude-code') return 'claude';
  return id;
}

export function sessionLine(session: SessionSnapshot): string {
  if (session.title) return session.title;
  if (session.project) return session.project;
  return `${harnessLabel(session.harness)} session`;
}

export function sessionAge(session: SessionSnapshot, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - session.startedAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
