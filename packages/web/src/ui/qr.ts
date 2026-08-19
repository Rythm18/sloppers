import qrcode from 'qrcode-generator';

/**
 * A QR code as one SVG path, drawn entirely in the browser.
 *
 * No image service and no CDN: this project is meant to be self-hosted
 * behind whatever CSP its owner likes, and the thing being encoded here is a
 * one-shot credential that has no business leaving the page it was minted
 * for.
 */

/**
 * The light border a scanner needs to find the code. Four modules is what
 * the spec asks for, and shrinking it is the first thing that makes a code
 * flaky on a phone held at an angle.
 */
const QUIET_ZONE = 4;

/**
 * Error correction level. `M` recovers ~15% and costs one version step over
 * `L` at these lengths — cheap insurance against a screen's glare and the
 * moiré a camera makes of pixels photographing pixels.
 */
const CORRECTION = 'M';

export interface QrPath {
  /** Modules across, quiet zone included — use it as the SVG viewBox. */
  size: number;
  /** Every dark module, as one path in a `size`×`size` coordinate space. */
  path: string;
}

/**
 * Encode `text` for display. Modules are emitted as horizontal runs rather
 * than one square each, which keeps the path a few hundred bytes instead of
 * a few thousand for no visual difference.
 */
export function qrPath(text: string): QrPath {
  // 0 picks the smallest version the data fits in.
  const code = qrcode(0, CORRECTION);
  code.addData(text, 'Byte');
  code.make();

  const modules = code.getModuleCount();
  const runs: string[] = [];
  for (let row = 0; row < modules; row++) {
    let run = 0;
    // One past the end closes a run that reaches the right-hand edge.
    for (let col = 0; col <= modules; col++) {
      if (col < modules && code.isDark(row, col)) {
        run += 1;
        continue;
      }
      if (run > 0) {
        runs.push(`M${col - run + QUIET_ZONE} ${row + QUIET_ZONE}h${run}v1h-${run}z`);
        run = 0;
      }
    }
  }

  return { size: modules + QUIET_ZONE * 2, path: runs.join('') };
}
