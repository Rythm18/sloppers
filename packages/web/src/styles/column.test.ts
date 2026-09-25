import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The board and chat share the right-hand column, and nothing in a test can
 * see them collide.
 *
 * jsdom has no layout engine, so a board whose rows run past where chat
 * begins renders perfectly in every component test here and reads as two
 * panels drawn on top of each other in a real browser — on a short window, in
 * an office with enough people in it, which is nobody's development machine.
 * The arithmetic that prevents it is `--column-share` in the stylesheet, so
 * this reads the stylesheet: both of the parts that grow with their contents
 * have to be capped against it, and a third panel added to the column later
 * has to join them.
 */

const css = readFileSync(fileURLToPath(new URL('./app.css', import.meta.url)), 'utf8');

/** Every `max-height` declared for one selector, in source order. */
function capsFor(selector: string): string[] {
  const rules = [...css.matchAll(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'g'))];
  return rules.flatMap((rule) =>
    [...(rule[1] ?? '').matchAll(/max-height:\s*([^;]+);/g)].map((m) => (m[1] ?? '').trim()),
  );
}

describe('the right-hand column', () => {
  it('pays for the fixed furniture before splitting what is left', () => {
    expect(css).toMatch(/--column-share:\s*max\(\s*\d+px,\s*calc\(\(100dvh - \d+px\) \/ 2\)\s*\)/);
    // Declared on both panels, so either can read it wherever it sits.
    expect(css).toMatch(/\.chat,\n\.leaderboard \{\n\s*--column-share:/);
  });

  it('caps chat’s log against the share wherever they sit side by side', () => {
    const caps = capsFor('\\.chat-log');
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) {
      // The one exception is the bottom sheet, which is alone on its edge —
      // the stacked block hides the board behind it outright.
      if (cap.includes('var(--column-share)')) continue;
      expect(cap).toBe('34dvh');
    }
  });

  it('caps the board against the share once chat is under it', () => {
    // And only then: with chat shut there is nothing below to run into, and
    // the board keeps the whole of its own cap.
    expect(capsFor('\\.app:has\\(\\.chat\\) \\.leaderboard-rows')).toEqual([
      'min(44dvh, var(--column-share))',
    ]);
  });
});
