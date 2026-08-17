import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { TailCursor } from './types.js';

const CHUNK = 64 * 1024;
const NEWLINE = 0x0a;

export function newCursor(): TailCursor {
  return { offset: 0, partial: Buffer.alloc(0) };
}

/**
 * Read every complete line appended since `cursor`, returning the advanced
 * cursor. A shrunken file (rotation/truncation) resets to the start. The
 * final line is only surfaced once its newline arrives; until then its bytes
 * ride along in `cursor.partial` — as bytes, so a multi-byte character split
 * across reads is never decoded mid-character.
 */
export function readAppended(
  filePath: string,
  cursor: TailCursor,
): { lines: string[]; cursor: TailCursor } {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    let { offset, partial } = cursor;
    if (size < offset) {
      offset = 0;
      partial = Buffer.alloc(0);
    }
    if (size === offset) {
      return { lines: [], cursor: { offset, partial } };
    }

    const chunks: Buffer[] = [partial];
    const buf = Buffer.alloc(CHUNK);
    while (offset < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - offset), offset);
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      offset += n;
    }

    const all = Buffer.concat(chunks);
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < all.length; i++) {
      if (all[i] === NEWLINE) {
        if (i > start) lines.push(all.toString('utf8', start, i));
        start = i + 1;
      }
    }
    const nextPartial = Buffer.from(all.subarray(start));
    return { lines, cursor: { offset, partial: nextPartial } };
  } finally {
    closeSync(fd);
  }
}
