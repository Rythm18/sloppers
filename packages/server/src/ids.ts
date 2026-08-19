import { randomBytes, randomInt } from 'node:crypto';

/**
 * A workspace's permanent identity. Random rather than derived from the
 * invite code: the id outlives code rotation, so it must never let someone
 * holding it reconstruct a code — current or retired.
 */
export function workspaceId(): string {
  return `w_${randomBytes(8).toString('hex')}`;
}

export function memberId(): string {
  return `m_${randomBytes(8).toString('hex')}`;
}

export function memberSecret(): string {
  return randomBytes(24).toString('hex');
}

export function deviceKey(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Pairing codes are typed by humans, so: short, no ambiguous characters
 * (0/O, 1/I/L), grouped for readability — e.g. `K4X-P2Q`.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function pairingCode(): string {
  const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const group = () => [pick(), pick(), pick()].join('');
  return `${group()}-${group()}`;
}

/**
 * The random tail of a room code, e.g. the `k4xp2q` in `the-lab-k4xp2q`.
 * Lowercase (it lives in URLs), no ambiguous characters, ~30 bits — with
 * per-IP join rate limiting that makes codes unguessable in practice.
 */
const SUFFIX_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function roomSuffix(): string {
  return Array.from({ length: 6 }, () => SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)]).join(
    '',
  );
}

export function relinkToken(): string {
  return randomBytes(24).toString('hex');
}
