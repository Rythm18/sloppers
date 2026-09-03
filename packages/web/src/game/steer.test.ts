// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { type Held, keyHeading } from './steer.js';

/**
 * The one input rule the office cannot afford to get wrong. Phaser reads the
 * keyboard off the window, so every W typed anywhere on the page is a step
 * west unless something says otherwise — and the panel that deletes your seat
 * asks you to type your own name first.
 */

const STILL: Held = { left: false, right: false, up: false, down: false };

function held(...directions: (keyof Held)[]): Held {
  return { ...STILL, ...Object.fromEntries(directions.map((d) => [d, true])) };
}

describe('keyHeading', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('stands still with nothing pressed', () => {
    expect(keyHeading(STILL)).toEqual({ vx: 0, vy: 0 });
  });

  it('walks the way the key points', () => {
    expect(keyHeading(held('left'))).toEqual({ vx: -1, vy: 0 });
    expect(keyHeading(held('up'))).toEqual({ vx: 0, vy: -1 });
  });

  it('cancels out when both ends of an axis are held', () => {
    expect(keyHeading(held('left', 'right'))).toEqual({ vx: 0, vy: 0 });
  });

  it('shortens a diagonal so the corner route is no quicker', () => {
    const { vx, vy } = keyHeading(held('right', 'down'));
    expect(Math.hypot(vx, vy)).toBeCloseTo(1);
  });

  it('gives the office nothing while a text field has the letters', () => {
    document.body.innerHTML = '<input aria-label="your name" />';
    const field = document.body.firstElementChild;
    if (field instanceof HTMLElement) field.focus();

    expect(keyHeading(held('left', 'down'))).toEqual({ vx: 0, vy: 0 });
  });

  it('hands them straight back when the field is done with them', () => {
    document.body.innerHTML = '<input aria-label="your name" /><button type="button">Ban</button>';
    const button = document.body.lastElementChild;
    if (button instanceof HTMLElement) button.focus();

    expect(keyHeading(held('left'))).toEqual({ vx: -1, vy: 0 });
  });
});
