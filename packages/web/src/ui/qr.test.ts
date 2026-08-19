import { describe, expect, it } from 'vitest';
import { type QrPath, qrPath } from './qr.js';

/**
 * A QR code that does not scan is worse than no QR code, and nothing on
 * screen tells you which one you have. These tests read the path back into a
 * grid and check the parts a scanner looks for first — which is also the only
 * way the run-length packing in `qrPath` gets checked at all.
 */

/** The four-module light border the spec requires around a code. */
const QUIET_ZONE = 4;

function grid(code: QrPath): boolean[][] {
  const cells = Array.from({ length: code.size }, () => Array<boolean>(code.size).fill(false));
  for (const run of code.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const x = Number(run[1]);
    const y = Number(run[2]);
    const length = Number(run[3]);
    for (let i = 0; i < length; i++) {
      const row = cells[y];
      if (!row) throw new Error(`run at row ${y} falls outside a ${code.size}-module code`);
      if (x + i >= code.size) throw new Error(`run at row ${y} runs off the right-hand edge`);
      row[x + i] = true;
    }
  }
  return cells;
}

/** The 7×7 eye a scanner hunts for: dark ring, light ring, dark core. */
function isFinder(cells: boolean[][], top: number, left: number): boolean {
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 7; col++) {
      const ring = row === 0 || row === 6 || col === 0 || col === 6;
      const core = row >= 2 && row <= 4 && col >= 2 && col <= 4;
      if (cells[top + row]?.[left + col] !== (ring || core)) return false;
    }
  }
  return true;
}

const LINK = 'https://sloppers.example.com/?room=the-lab-k4xp2q#relink=0a1b2c3d4e5f60718293a4b5';

describe('qrPath', () => {
  it('puts a finder pattern in three corners and not the fourth', () => {
    const code = qrPath(LINK);
    const cells = grid(code);
    const far = code.size - QUIET_ZONE - 7;

    expect(isFinder(cells, QUIET_ZONE, QUIET_ZONE)).toBe(true);
    expect(isFinder(cells, QUIET_ZONE, far)).toBe(true);
    expect(isFinder(cells, far, QUIET_ZONE)).toBe(true);
    // A fourth eye would make the code unorientable — the missing corner is
    // how a scanner knows which way up it is.
    expect(isFinder(cells, far, far)).toBe(false);
  });

  it('leaves the quiet zone the spec asks for on every side', () => {
    const cells = grid(qrPath(LINK));
    const coords: number[] = [];
    for (const [y, row] of cells.entries()) {
      for (const [x, on] of row.entries()) if (on) coords.push(y, x);
    }

    expect(Math.min(...coords)).toBe(QUIET_ZONE);
    expect(Math.max(...coords)).toBe(cells.length - QUIET_ZONE - 1);
  });

  it('sizes itself to a real QR version, with room for the border', () => {
    const modules = qrPath(LINK).size - QUIET_ZONE * 2;
    // Versions run 21, 25, 29… — anything else is not a QR code.
    expect(modules).toBeGreaterThanOrEqual(21);
    expect((modules - 21) % 4).toBe(0);
  });

  it('grows rather than truncating when there is more to say', () => {
    expect(qrPath(`${LINK}${LINK}${LINK}`).size).toBeGreaterThan(qrPath(LINK).size);
  });

  it('encodes what it was given: same string same code, different string different code', () => {
    expect(qrPath(LINK)).toEqual(qrPath(LINK));
    // One character apart — the relink token differing in its last digit is
    // exactly the mistake a QR built from the wrong variable would make.
    expect(qrPath(`${LINK}5`).path).not.toBe(qrPath(LINK).path);
    expect(qrPath(LINK.replace('https', 'http')).path).not.toBe(qrPath(LINK).path);
  });
});
