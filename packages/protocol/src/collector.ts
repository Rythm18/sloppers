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

/**
 * `member-removed` is the one code here that is not about the device.
 * `unknown-device` says the key means nothing — the honest answer to a
 * pairing that was erased, and one a collector rightly responds to by
 * forgetting it. Being kicked or banned is the opposite: the key is good and
 * the office knows exactly whose it is, so a collector that hears this keeps
 * everything it has and simply stops.
 *
 * Additive on purpose. `sloppers@0.1.x` is in the wild and its copy of this
 * enum has four codes, so a message carrying the fifth fails its parse and is
 * dropped — the socket closes behind it and that collector reconnects on its
 * usual backoff, which is worse than being told and much better than deleting
 * its own configuration over a sentence that was never true.
 */
export const collectorErrorSchema = z.object({
  type: z.literal('error'),
  code: z.enum(['unknown-device', 'superseded', 'bad-message', 'server-error', 'member-removed']),
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

/**
 * Relink: a paired collector rescues a browser identity. The daemon's
 * device key mints a one-shot token; opening the URL that carries it makes
 * a fresh browser become the member again — cleared storage and second
 * devices recover without any login system.
 */
export const relinkMintRequestSchema = z.object({
  deviceKey: z.string().min(16).max(128),
});
export const relinkMintResponseSchema = z.object({
  token: z.string(),
  roomCode: z.string(),
  expiresAt: z.number().int().positive(),
});
export type RelinkMintResponse = z.infer<typeof relinkMintResponseSchema>;

export const relinkRedeemRequestSchema = z.object({
  token: z.string().trim().min(8).max(128),
});
export const relinkRedeemResponseSchema = z.object({
  memberId: z.string(),
  memberSecret: z.string(),
  roomCode: z.string(),
  displayName: z.string(),
});
export type RelinkRedeemResponse = z.infer<typeof relinkRedeemResponseSchema>;

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
