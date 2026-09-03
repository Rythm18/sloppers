import type { Point } from './path.js';
import { isTypingSomewhere } from './typing.js';

/**
 * Where the avatar is asked to go this frame, and everything that decides it.
 *
 * The scene owns a sprite, a camera and a socket; none of that has an opinion
 * about steering, and all of it needs a canvas to exist. So the opinions live
 * here instead, in plain numbers — which is the only reason the walk
 * lifecycle can be held to account by a test at all.
 */

/** The four ways a keyboard can be pressing, WASD and arrows already merged. */
export interface Held {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

export interface Heading {
  vx: number;
  vy: number;
}

/** Not going anywhere. Fresh each time — callers are free to mutate it. */
function still(): Heading {
  return { vx: 0, vy: 0 };
}

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
 *
 * A unit-ish heading: whole steps on an axis, and a diagonal shortened so
 * that crossing the office corner to corner is no faster than crossing it
 * along a wall.
 */
export function keyHeading(held: Held): Heading {
  if (isTypingSomewhere()) return still();
  let vx = (held.left ? -1 : 0) + (held.right ? 1 : 0);
  let vy = (held.up ? -1 : 0) + (held.down ? 1 : 0);
  if (vx !== 0 && vy !== 0) {
    vx *= Math.SQRT1_2;
    vy *= Math.SQRT1_2;
  }
  return { vx, vy };
}

/**
 * How long a tapped walk may make no headway before it is abandoned. The
 * planner and the mover agree about the furniture, so this should never
 * fire — but "should never" is how an avatar ends up grinding against a desk
 * forever, sending a position update every tick, until the tab is closed.
 */
export const WALK_STALL_MS = 700;

/** Headway smaller than this is not headway; it is floating-point noise. */
const PROGRESS_PX = 0.5;

/**
 * The walk a tap asked for, as it is paced out.
 *
 * Waypoints retire as they are reached, and the whole errand is dropped if it
 * stops closing on the one it is heading for. Both of those are the kind of
 * thing that looks fine in a diff and shows up as an avatar shivering in
 * place, so they are here, where numbers alone can prove them.
 */
export class Walk {
  private waypoints: Point[] = [];
  /** The closest we have come to the current waypoint, and when. */
  private closest = Number.POSITIVE_INFINITY;
  private closestAt = 0;

  /** How many waypoints are left; zero when nobody is walking anywhere. */
  get pending(): number {
    return this.waypoints.length;
  }

  /** Take up a new errand, dropping whatever was underway. */
  begin(waypoints: Point[], now: number): void {
    this.waypoints = [...waypoints];
    this.freshLeg(now);
  }

  /** Drop the errand, wherever it had got to. */
  abandon(): void {
    this.waypoints.length = 0;
  }

  private freshLeg(now: number): void {
    this.closest = Number.POSITIVE_INFINITY;
    this.closestAt = now;
  }

  /**
   * The heading that carries a body at (`x`, `y`) along this walk, given how
   * far it travels in one tick. Zero once there is nowhere left to be.
   */
  steer(now: number, x: number, y: number, step: number): Heading {
    while (this.waypoints.length > 0) {
      const next = this.waypoints[0];
      if (!next) break;
      const dx = next.x - x;
      const dy = next.y - y;
      const gap = Math.hypot(dx, dy);
      // Within one tick's travel is arrival. Insisting on exactness here only
      // buys a jitter as the avatar steps back and forth across the spot.
      if (gap <= step) {
        this.waypoints.shift();
        this.freshLeg(now);
        continue;
      }
      if (gap < this.closest - PROGRESS_PX) {
        this.closest = gap;
        this.closestAt = now;
      } else if (now - this.closestAt > WALK_STALL_MS) {
        this.abandon();
        break;
      }
      return { vx: dx / gap, vy: dy / gap };
    }
    return still();
  }
}

/** Where the body is and how fast, for one frame. */
export interface Frame {
  now: number;
  x: number;
  y: number;
  step: number;
}

/**
 * The keys if a hand is on them, and otherwise whatever is left of the walk a
 * tap asked for.
 *
 * A hand on the keys outranks an errand still being paced out: taking hold of
 * the avatar has to work the instant you touch a key, not once it finishes
 * what it was doing. A key swallowed by a text field is not a hand on the
 * keys, which is why this reads what `keyHeading` returns and never the raw
 * presses — typing "wander" into the office name must not cancel the walk.
 */
export function frameHeading(walk: Walk, held: Held, frame: Frame): Heading {
  const keys = keyHeading(held);
  if (keys.vx !== 0 || keys.vy !== 0) {
    walk.abandon();
    return keys;
  }
  return walk.steer(frame.now, frame.x, frame.y, frame.step);
}
