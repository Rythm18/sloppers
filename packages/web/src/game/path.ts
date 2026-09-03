import { isBlocked, MAP_H, MAP_W, type OfficeMap } from './map.js';
import { TILE_SIZE } from './tiles.gen.js';

/**
 * Getting from where you are standing to where you tapped.
 *
 * A finger has no arrow keys, so a tap has to mean "walk there" — and "there"
 * is usually on the far side of a desk. Walking straight at it wedges the
 * avatar against the furniture, so the route is planned on the office grid
 * first: a breadth-first sweep out from the player's feet, then a straight
 * line pulled through the corners so the walk reads as a person crossing a
 * room rather than a piece on a board.
 *
 * The sweep covers the whole reachable floor (704 tiles) on every tap, which
 * costs nothing and buys the answer to the more common question: a tap that
 * lands *on* a desk, a wall, or a teammate's chair. Rather than refuse it,
 * the walk ends at the reachable tile closest to where the finger went down —
 * you asked to go to the coffee machine and you end up standing at it.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * The player's body: the four corners of the 10×4 box around its feet.
 *
 * Movement and route-planning both ask this same question, so a tile the
 * planner calls walkable is a tile the mover can actually stand on. When
 * those two disagree the avatar walks confidently into a wall and stays
 * there.
 */
const BODY = [
  [-5, -1],
  [5, -1],
  [-5, 3],
  [5, 3],
] as const;

/** Whether the player's body clears the furniture standing at this spot. */
export function bodyFits(office: OfficeMap, x: number, y: number): boolean {
  for (const [ox, oy] of BODY) {
    if (isBlocked(office, x + ox, y + oy)) return false;
  }
  return true;
}

/** World coordinates of a tile's middle — where a route's waypoints sit. */
function centre(tx: number, ty: number): Point {
  return { x: tx * TILE_SIZE + TILE_SIZE / 2, y: ty * TILE_SIZE + TILE_SIZE / 2 };
}

const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Sentinels in the `prev` array: not reached yet, and reached first. */
const UNVISITED = -2;
const ROOT = -1;

/** How finely a straight line is sampled when testing it for furniture. */
const LINE_SAMPLE_PX = 3;

/**
 * Whether the body can travel the straight line from `a` to `b` untouched.
 * Sampled rather than swept: at three pixels a step, nothing thinner than a
 * third of a tile can slip between two samples, and the office has nothing
 * thinner than a tile.
 */
function clearLine(office: OfficeMap, a: Point, b: Point): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const steps = Math.ceil(Math.hypot(dx, dy) / LINE_SAMPLE_PX);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!bodyFits(office, a.x + dx * t, a.y + dy * t)) return false;
  }
  return true;
}

/**
 * Pull the grid route straight: keep reaching for the furthest waypoint still
 * in plain sight, and only turn where the furniture forces a turn. Without
 * this the avatar walks the staircase the grid handed it, which looks like a
 * rook and not like a person.
 */
function pullStraight(office: OfficeMap, from: Point, route: Point[]): Point[] {
  const out: Point[] = [];
  let cursor = from;
  let i = 0;
  while (i < route.length) {
    let furthest = i;
    for (;;) {
      const ahead = route[furthest + 1];
      if (!ahead || !clearLine(office, cursor, ahead)) break;
      furthest += 1;
    }
    const corner = route[furthest];
    // Unreachable in practice — `furthest` indexes inside the route — but the
    // compiler cannot see that, and an empty step would loop forever.
    if (!corner) break;
    out.push(corner);
    cursor = corner;
    i = furthest + 1;
  }
  return out;
}

/**
 * The waypoints to walk from `from` to `to`, in world coordinates. Empty when
 * there is nowhere to go: the tap landed on the tile already underfoot, or
 * the player is somewhere the office grid does not describe.
 */
export function findWalk(office: OfficeMap, from: Point, to: Point): Point[] {
  const startX = Math.floor(from.x / TILE_SIZE);
  const startY = Math.floor(from.y / TILE_SIZE);
  if (startX < 0 || startY < 0 || startX >= MAP_W || startY >= MAP_H) return [];

  const start = startY * MAP_W + startX;
  const prev = new Int32Array(MAP_W * MAP_H).fill(UNVISITED);
  prev[start] = ROOT;
  const queue = [start];

  // The best answer so far to "how close can I actually get?". The tile
  // underfoot is in the running, so a tap on the desk you are already leaning
  // against correctly means stay put.
  let nearest = start;
  let nearestGap = Number.POSITIVE_INFINITY;

  for (let head = 0; head < queue.length; head++) {
    const index = queue[head] ?? 0;
    const tx = index % MAP_W;
    const ty = (index - tx) / MAP_W;
    const here = centre(tx, ty);
    const gap = (here.x - to.x) ** 2 + (here.y - to.y) ** 2;
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = index;
    }
    for (const [dx, dy] of STEPS) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      const next = ny * MAP_W + nx;
      if (prev[next] !== UNVISITED) continue;
      const step = centre(nx, ny);
      if (!bodyFits(office, step.x, step.y)) continue;
      prev[next] = index;
      queue.push(next);
    }
  }

  if (nearest === start) return [];

  const route: Point[] = [];
  for (let index = nearest; index !== start; ) {
    const tx = index % MAP_W;
    route.push(centre(tx, (index - tx) / MAP_W));
    const back = prev[index];
    if (back === undefined || back === ROOT || back === UNVISITED) break;
    index = back;
  }
  route.reverse();
  return pullStraight(office, from, route);
}
