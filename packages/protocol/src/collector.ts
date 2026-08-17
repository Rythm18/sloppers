import { z } from 'zod';
import { sessionSnapshotSchema } from './core.js';

/**
 * Messages between a collector daemon and the server, over `WS /ws/collector`.
 * The collector authenticates with the device key it received when a pairing
 * code was redeemed, then streams full-state snapshots.
 */

export const collectorHelloSchema = z.object({
  type: z.literal('hello'),
  deviceKey: z.string().min(16).max(128),
  collectorVersion: z.string().max(32),
});
export type CollectorHello = z.infer<typeof collectorHelloSchema>;

/**
 * The complete current state of one machine: every live agent session, plus
 * machine-level signals. Sent debounced on change and as a keepalive. Fields
 * the owner has hidden are already stripped.
 */
export const collectorSnapshotSchema = z.object({
  type: z.literal('snapshot'),
  sessions: z.array(sessionSnapshotSchema).max(64),
  machine: z.object({
    /** Seconds since last human input, when the platform can tell us. */
    idleSeconds: z.number().nonnegative().optional(),
  }),
});
export type CollectorSnapshot = z.infer<typeof collectorSnapshotSchema>;

export const collectorToServerSchema = z.discriminatedUnion('type', [
  collectorHelloSchema,
  collectorSnapshotSchema,
]);
export type CollectorToServer = z.infer<typeof collectorToServerSchema>;

export const collectorHelloOkSchema = z.object({
  type: z.literal('hello-ok'),
  memberId: z.string(),
  displayName: z.string(),
  roomCode: z.string(),
});
export type CollectorHelloOk = z.infer<typeof collectorHelloOkSchema>;

export const collectorErrorSchema = z.object({
  type: z.literal('error'),
  code: z.enum(['unknown-device', 'bad-message', 'server-error']),
  message: z.string(),
});
export type CollectorError = z.infer<typeof collectorErrorSchema>;

export const serverToCollectorSchema = z.discriminatedUnion('type', [
  collectorHelloOkSchema,
  collectorErrorSchema,
]);
export type ServerToCollector = z.infer<typeof serverToCollectorSchema>;

/**
 * Pairing REST payloads. The browser mints a short-lived pairing code for its
 * member; `sloppers share <code>` redeems it exactly once for a device key.
 */

export const pairMintRequestSchema = z.object({
  memberId: z.string(),
  memberSecret: z.string(),
});
export const pairMintResponseSchema = z.object({
  pairingCode: z.string(),
  expiresAt: z.number().int().positive(),
});
export type PairMintResponse = z.infer<typeof pairMintResponseSchema>;

export const pairRedeemRequestSchema = z.object({
  pairingCode: z.string().trim().min(4).max(32),
});
export const pairRedeemResponseSchema = z.object({
  deviceKey: z.string(),
  memberId: z.string(),
  displayName: z.string(),
  roomCode: z.string(),
  /** WebSocket URL the collector should connect to. */
  wsUrl: z.string(),
});
export type PairRedeemResponse = z.infer<typeof pairRedeemResponseSchema>;
