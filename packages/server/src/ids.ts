import { randomBytes, randomInt } from 'node:crypto';

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
