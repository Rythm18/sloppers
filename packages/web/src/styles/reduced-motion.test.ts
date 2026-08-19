import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Reduced motion is answered in two stylesheets rather than one, and the
 * reason is pure cascade: landing.css loads after app.css, so a rule written
 * in app.css loses to an equal-specificity rule in landing.css, and a rule
 * written above its target inside landing.css loses to that too. Nothing about
 * a stylesheet says so, and a `@media (prefers-reduced-motion)` block that
 * quietly loses looks exactly like one that works.
 *
 * So these read the files. Cheap, and they catch the one mistake — a
 * well-meaning tidy-up moving the block back to the top of the file, or over
 * to app.css beside the rest of them — that a browser would only show to
 * somebody who had asked for less motion in the first place.
 */

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

const app = read('./app.css');
const landing = read('./landing.css');

/** Where the reduced-motion block starts, or -1. */
const blockAt = (css: string): number => css.indexOf('@media (prefers-reduced-motion: reduce)');

describe('prefers-reduced-motion', () => {
  it('answers the landing page, not only the office', () => {
    // app.css covers `.btn`; these were the landing page's own moving parts,
    // and nothing covered them at all.
    const block = landing.slice(blockAt(landing));
    expect(blockAt(landing)).toBeGreaterThan(-1);
    for (const selector of ['.ticker-track', '.animate-pulse', '.pixel-btn']) {
      expect(block).toContain(selector);
    }
  });

  it('puts the override after every rule it overrides', () => {
    const block = blockAt(landing);
    // `.pixel-btn:hover { transform: … }` and `.pixel-btn { transition: … }`
    // are the rules being turned off. Same specificity, so the later one wins
    // — and "later" is the whole mechanism.
    expect(landing.lastIndexOf('.pixel-btn:hover {')).toBeLessThan(block);
    expect(landing.lastIndexOf('transition:\n    transform')).toBeLessThan(block);
    expect(landing.lastIndexOf('animation: ticker-scroll')).toBeLessThan(block);
  });

  it('keeps the office block where it was, ahead of the landing one', () => {
    // Both files still carry a block: this is a second one, not a move.
    expect(blockAt(app)).toBeGreaterThan(-1);
    expect(app.slice(blockAt(app))).toContain('.btn:hover');
  });
});
