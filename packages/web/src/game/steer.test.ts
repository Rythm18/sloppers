// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Point } from './path.js';
import { frameHeading, type Held, keyHeading, WALK_STALL_MS, Walk } from './steer.js';

/**
 * The input rules the office cannot afford to get wrong.
 *
 * Phaser reads the keyboard off the window, so every W typed anywhere on the
 * page is a step west unless something says otherwise — and the panel that
 * deletes your seat asks you to type your own name first. And a walk a tap
 * asked for has to end: waypoints that never retire look exactly like an
 * avatar shivering in place, and there is no frame of a diff where that is
 * visible.
 */

const STILL: Held = { left: false, right: false, up: false, down: false };

function held(...directions: (keyof Held)[]): Held {
  return { ...STILL, ...Object.fromEntries(directions.map((d) => [d, true])) };
}

function focusAField(): void {
  document.body.innerHTML = '<input aria-label="your name" />';
  const field = document.body.firstElementChild;
  if (field instanceof HTMLElement) field.focus();
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
    focusAField();
    expect(keyHeading(held('left', 'down'))).toEqual({ vx: 0, vy: 0 });
  });

  it('hands them straight back when the field is done with them', () => {
    document.body.innerHTML = '<input aria-label="your name" /><button type="button">Ban</button>';
    const button = document.body.lastElementChild;
    if (button instanceof HTMLElement) button.focus();

    expect(keyHeading(held('left'))).toEqual({ vx: -1, vy: 0 });
  });
});

/** One tick of a 110px/s walk at 60fps, which is what the scene passes. */
const STEP = 1.83;
const TICK_MS = 16;

/**
 * Pace a walk out the way the scene does — steer, then move by the heading —
 * and report where it ended up and how long it took. `ticks: -1` means it
 * never ended, which is the failure this whole file exists for.
 */
function pace(walk: Walk, from: Point, limit = 4000): { x: number; y: number; ticks: number } {
  let { x, y } = from;
  for (let tick = 1; tick <= limit; tick++) {
    const { vx, vy } = walk.steer(tick * TICK_MS, x, y, STEP);
    if (vx === 0 && vy === 0) return { x, y, ticks: tick };
    x += vx * STEP;
    y += vy * STEP;
  }
  return { x, y, ticks: -1 };
}

describe('Walk', () => {
  it('has nothing to say before anybody taps', () => {
    const walk = new Walk();
    expect(walk.pending).toBe(0);
    expect(walk.steer(0, 0, 0, STEP)).toEqual({ vx: 0, vy: 0 });
  });

  it('heads for the next waypoint', () => {
    const walk = new Walk();
    walk.begin([{ x: 0, y: 100 }], 0);

    const { vx, vy } = walk.steer(TICK_MS, 0, 0, STEP);
    expect(vx).toBeCloseTo(0);
    expect(vy).toBeCloseTo(1);
    expect(walk.pending).toBe(1);
  });

  // The one that matters. Drop the arrival test and every other assertion in
  // this file still passes while the avatar shivers on the spot until the
  // stall detector puts it out of its misery.
  it('retires a waypoint once it is within a tick of it', () => {
    const walk = new Walk();
    walk.begin([{ x: 0, y: 10 }], 0);
    walk.steer(TICK_MS, 0, 0, 2);
    expect(walk.pending).toBe(1);

    expect(walk.steer(2 * TICK_MS, 0, 9, 2)).toEqual({ vx: 0, vy: 0 });
    expect(walk.pending).toBe(0);
  });

  it('walks a whole route and stops, at the end of it and not at the start', () => {
    const walk = new Walk();
    const destination = { x: 64, y: 64 };
    walk.begin([{ x: 0, y: 64 }, destination], 0);

    const ended = pace(walk, { x: 0, y: 0 });

    expect(ended.ticks).toBeGreaterThan(0);
    expect(walk.pending).toBe(0);
    // Where it stopped is what tells arriving apart from giving up. Without
    // the arrival test above, the avatar dithers on the first waypoint until
    // the stall detector drops the errand — `pending` still ends at 0, and it
    // is standing at (0, 64) rather than here.
    expect(Math.hypot(ended.x - destination.x, ended.y - destination.y)).toBeLessThanOrEqual(STEP);
    // 128px of route at 1.83 a tick is about 70 of them. Much more than that
    // is time spent going back and forth rather than across.
    expect(ended.ticks).toBeLessThan(90);
  });

  it('keeps going for as long as it is getting closer', () => {
    const walk = new Walk();
    walk.begin([{ x: 4000, y: 0 }], 0);

    // Far further than the stall window, but closing the whole way.
    const ended = pace(walk, { x: 0, y: 0 }, 200);

    expect(ended.ticks).toBe(-1);
    expect(walk.pending).toBe(1);
    expect(ended.x).toBeGreaterThan(300);
  });

  it('gives up on an errand that has stopped getting anywhere', () => {
    const walk = new Walk();
    walk.begin([{ x: 100, y: 0 }], 0);
    // Wedged: the same spot, frame after frame, going nowhere.
    walk.steer(0, 0, 0, STEP);
    walk.steer(WALK_STALL_MS, 0, 0, STEP);
    expect(walk.pending).toBe(1);

    expect(walk.steer(WALK_STALL_MS + 1, 0, 0, STEP)).toEqual({ vx: 0, vy: 0 });
    expect(walk.pending).toBe(0);
  });

  it('drops what it was doing when a new tap arrives', () => {
    const walk = new Walk();
    walk.begin([{ x: 0, y: 100 }], 0);
    walk.begin([{ x: 50, y: 0 }], TICK_MS);

    expect(walk.pending).toBe(1);
    expect(walk.steer(2 * TICK_MS, 0, 0, STEP).vx).toBeCloseTo(1);
  });
});

describe('frameHeading', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('walks the errand when no hand is on the keys', () => {
    const walk = new Walk();
    walk.begin([{ x: 0, y: 100 }], 0);

    const { vy } = frameHeading(walk, STILL, { now: TICK_MS, x: 0, y: 0, step: STEP });

    expect(vy).toBeCloseTo(1);
    expect(walk.pending).toBe(1);
  });

  it('hands the avatar back the instant a key is touched, dropping the errand', () => {
    const walk = new Walk();
    walk.begin([{ x: 0, y: 100 }], 0);

    const heading = frameHeading(walk, held('left'), { now: TICK_MS, x: 0, y: 0, step: STEP });

    expect(heading).toEqual({ vx: -1, vy: 0 });
    expect(walk.pending).toBe(0);
  });

  // The composition, which is where this could go wrong without either half
  // being wrong: typing "wander" into the office name is not a hand on the
  // keys, and must not cancel a walk somebody asked for.
  it('does not mistake typing for a hand on the keys', () => {
    focusAField();
    const walk = new Walk();
    walk.begin([{ x: 0, y: 100 }], 0);

    const { vy } = frameHeading(walk, held('left', 'down'), {
      now: TICK_MS,
      x: 0,
      y: 0,
      step: STEP,
    });

    expect(walk.pending).toBe(1);
    expect(vy).toBeCloseTo(1);
  });
});
