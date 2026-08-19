import { z } from 'zod';

const count = z.number().int().nonnegative();

/**
 * Usage as the harness reported it, bucketed by the day and model the work
 * actually happened on. Cumulative *per bucket*: re-sending is a no-op, so
 * restarts and reconnects cost nothing and can never inflate a total.
 */
export const usageBucketSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  model: z.string().min(1).max(120),
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
});
export type UsageBucket = z.infer<typeof usageBucketSchema>;

/**
 * Which minutes of a day had agent activity, as a base64 1440-bit bitmap.
 *
 * `minutes` is only charset-checked here, not length-checked against the
 * expected 180-byte bitmap: `decodeMinutes` is deliberately tolerant of
 * short, long, or otherwise malformed input (it never throws and always
 * returns a full-length buffer), so a value from an older or slightly
 * different collector still decodes instead of failing the whole snapshot.
 * The regex only rejects payloads that aren't base64 at all — free text,
 * JSON, etc — which would otherwise decode to silent, meaningless junk.
 */
export const minuteReportSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  minutes: z
    .string()
    .max(300)
    .regex(/^[A-Za-z0-9+/]*=*$/, 'must be base64'),
});
export type MinuteReport = z.infer<typeof minuteReportSchema>;

/**
 * Local calendar day, YYYY-MM-DD, using the *collector's* local clock.
 *
 * Deliberately local time, not UTC and not server time: the server may run
 * in a different timezone than the person doing the work (this deployment
 * runs in Singapore), so a day computed on the server would silently file
 * activity under the wrong date for everyone else. Every caller of this
 * function must run on the collector, not the server.
 */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Minute-of-day index (0-1439) in local time, for the activity bitmap. */
export function minuteOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

export const MINUTES_PER_DAY = 1440;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup: base64 character -> 6-bit value. */
const BASE64_REVERSE: Record<string, number> = {};
for (let i = 0; i < BASE64_ALPHABET.length; i++) {
  BASE64_REVERSE[BASE64_ALPHABET.charAt(i)] = i;
}

/**
 * Base64 encode without `Buffer`: this module is imported by the browser
 * bundle as well as Node, and `Buffer` is a Node-only global.
 */
function base64Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += BASE64_ALPHABET.charAt(b0 >> 2);
    out += BASE64_ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    out += BASE64_ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6));
    out += BASE64_ALPHABET.charAt(b2 & 0x3f);
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b0 = bytes[i] ?? 0;
    out += BASE64_ALPHABET.charAt(b0 >> 2);
    out += BASE64_ALPHABET.charAt((b0 & 0x03) << 4);
    out += '==';
  } else if (remaining === 2) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    out += BASE64_ALPHABET.charAt(b0 >> 2);
    out += BASE64_ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    out += BASE64_ALPHABET.charAt((b1 & 0x0f) << 2);
    out += '=';
  }
  return out;
}

/**
 * Base64 decode without `Buffer`. Never throws: unrecognized characters
 * (including stray padding) are simply skipped, so malformed or truncated
 * input degrades to whatever bytes its valid characters carry rather than
 * raising. Callers that need a fixed-size buffer (e.g. `decodeMinutes`)
 * still have to clamp the result themselves — this only guarantees a safe,
 * in-bounds decode of however many bytes the input actually encodes.
 */
function base64Decode(encoded: string): Uint8Array {
  const sextets: number[] = [];
  for (const ch of encoded) {
    const value = BASE64_REVERSE[ch];
    if (value !== undefined) sextets.push(value);
  }
  const byteCount = Math.floor((sextets.length * 6) / 8);
  const out = new Uint8Array(byteCount);
  let bitBuffer = 0;
  let bitCount = 0;
  let outIndex = 0;
  for (const sextet of sextets) {
    bitBuffer = (bitBuffer << 6) | sextet;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIndex++] = (bitBuffer >> bitCount) & 0xff;
    }
  }
  return out;
}

export function encodeMinutes(minutes: Iterable<number>): string {
  const bytes = new Uint8Array(MINUTES_PER_DAY / 8);
  for (const m of minutes) {
    if (m < 0 || m >= MINUTES_PER_DAY) continue;
    bytes[m >> 3] = (bytes[m >> 3] ?? 0) | (1 << (m & 7));
  }
  return base64Encode(bytes);
}

/**
 * Always returns a full 180-byte (1440-bit) buffer, whatever the input's
 * actual length or validity: short input is zero-padded, long input is
 * truncated, and non-base64 characters are dropped rather than rejected.
 */
export function decodeMinutes(encoded: string): Uint8Array {
  const decoded = base64Decode(encoded);
  const out = new Uint8Array(MINUTES_PER_DAY / 8);
  out.set(decoded.subarray(0, out.length));
  return out;
}

export function countMinutes(bitmap: Uint8Array): number {
  let total = 0;
  for (const byte of bitmap) {
    let b = byte;
    while (b) {
      total += b & 1;
      b >>= 1;
    }
  }
  return total;
}
