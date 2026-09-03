import { isTypingSomewhere } from './typing.js';

/**
 * Which way the keys are asking to go.
 *
 * The typing guard lives inside this rather than beside it, and that is the
 * whole point of the function existing. Phaser watches the keyboard at the
 * window, so W reaches the office from wherever it was typed — including the
 * field asking somebody to type their own name before their seat is deleted.
 * A caller that has to remember to ask about that is a caller that will one
 * day forget, and the bug is silent: the office walks, the letters arrive,
 * and nobody notices until an avatar is found parked in a wall.
 */

/** The four ways a keyboard can be pressing, WASD and arrows already merged. */
export interface Held {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

/**
 * A unit-ish heading: whole steps on an axis, and a diagonal shortened so
 * that crossing the office corner to corner is no faster than crossing it
 * along a wall.
 */
export function keyHeading(held: Held): { vx: number; vy: number } {
  if (isTypingSomewhere()) return { vx: 0, vy: 0 };
  let vx = (held.left ? -1 : 0) + (held.right ? 1 : 0);
  let vy = (held.up ? -1 : 0) + (held.down ? 1 : 0);
  if (vx !== 0 && vy !== 0) {
    vx *= Math.SQRT1_2;
    vy *= Math.SQRT1_2;
  }
  return { vx, vy };
}
