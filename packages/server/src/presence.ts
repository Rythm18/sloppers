import type { PresenceState, SessionSnapshot } from '@sloppers/protocol';

/** A collector silent this long is treated as gone. */
export const COLLECTOR_TIMEOUT_MS = 90_000;
/** Machine input within this window counts as "human at the keyboard". */
export const HUMAN_IDLE_THRESHOLD_S = 120;

export interface PresenceInputs {
  /** Any connected browser tab reporting itself focused/recently active. */
  browserPresent: boolean;
  /** Whether any browser tab is connected at all. */
  browserConnected: boolean;
  /** Machine idle seconds from the collector, if it can measure them. */
  machineIdleSeconds: number | undefined;
  /** When the collector last sent anything; undefined if never/unpaired. */
  collectorSeenAt: number | undefined;
  sessions: SessionSnapshot[];
  now: number;
}

/**
 * The one place presence is decided. Priority: a blocked agent outranks
 * everything (that's the "your agent needs you" signal); then whether
 * agents are working and whether the human is around.
 */
export function derivePresence(inputs: PresenceInputs): PresenceState {
  const collectorAlive =
    inputs.collectorSeenAt !== undefined &&
    inputs.now - inputs.collectorSeenAt < COLLECTOR_TIMEOUT_MS;

  if (!inputs.browserConnected && !collectorAlive) return 'offline';

  const sessions = collectorAlive ? inputs.sessions : [];
  const humanPresent =
    inputs.browserPresent ||
    (collectorAlive &&
      inputs.machineIdleSeconds !== undefined &&
      inputs.machineIdleSeconds < HUMAN_IDLE_THRESHOLD_S);

  if (sessions.some((s) => s.state === 'waiting')) return 'needs-attention';
  const working = sessions.some((s) => s.state === 'working');
  if (working) return humanPresent ? 'active' : 'grinding';
  return humanPresent ? 'active' : 'afk';
}
