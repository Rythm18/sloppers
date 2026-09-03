import { describe, expect, it } from 'vitest';
import { buildOffice, type OfficeMap } from './map.js';
import { bodyFits, findWalk, type Point } from './path.js';
import { TILE_SIZE } from './tiles.gen.js';

/**
 * A tap is a promise that the avatar will end up over there, and the office
 * is full of desks between here and there. These are about the two ways that
 * promise breaks: a route that walks through furniture, and a route the mover
 * cannot actually follow because it was planned against a different idea of
 * where a body fits.
 */

const office = buildOffice();

/** The middle of a tile, which is where every waypoint lands. */
function at(tx: number, ty: number): Point {
  return { x: tx * TILE_SIZE + TILE_SIZE / 2, y: ty * TILE_SIZE + TILE_SIZE / 2 };
}

/**
 * Walk the route the way the scene does — straight at each waypoint in turn —
 * and fail on the first pixel the body could not occupy. This is the whole
 * contract: the planner may return any route it likes as long as a body can
 * be dragged along it without touching the furniture.
 */
function assertWalkable(map: OfficeMap, from: Point, route: Point[]): void {
  let cursor = from;
  for (const waypoint of route) {
    const dx = waypoint.x - cursor.x;
    const dy = waypoint.y - cursor.y;
    const steps = Math.ceil(Math.hypot(dx, dy));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = cursor.x + dx * t;
      const y = cursor.y + dy * t;
      if (!bodyFits(map, x, y)) {
        throw new Error(`route crosses furniture at ${Math.round(x)},${Math.round(y)}`);
      }
    }
    cursor = waypoint;
  }
}

/** Row 12 runs clear across the office; rows 5 and 9 are desk pods. */
const OPEN_ROW = 12;

describe('bodyFits', () => {
  it('refuses the wall the office is drawn inside', () => {
    expect(bodyFits(office, at(6, 1).x, at(6, 1).y)).toBe(false);
  });

  it('refuses a desk', () => {
    expect(bodyFits(office, at(4, 5).x, at(4, 5).y)).toBe(false);
  });

  it('allows the chair tucked under it — you can stand where you sit', () => {
    expect(bodyFits(office, at(4, 6).x, at(4, 6).y)).toBe(true);
  });

  it('allows open floor', () => {
    expect(bodyFits(office, at(5, OPEN_ROW).x, at(5, OPEN_ROW).y)).toBe(true);
  });
});

describe('findWalk', () => {
  it('crosses open floor in one straight line, not eight little steps', () => {
    const from = at(5, OPEN_ROW);
    const route = findWalk(office, from, at(12, OPEN_ROW));

    expect(route).toEqual([at(12, OPEN_ROW)]);
    assertWalkable(office, from, route);
  });

  it('goes around a desk pod rather than through it', () => {
    // Straight up column 4 from row 8 to row 4 runs into the desk at row 5.
    const from = at(4, 8);
    const route = findWalk(office, from, at(4, 4));

    expect(route.at(-1)).toEqual(at(4, 4));
    expect(route.length).toBeGreaterThan(1);
    assertWalkable(office, from, route);
  });

  it('walks you up to a tapped desk instead of refusing the tap', () => {
    const from = at(5, OPEN_ROW);
    const desk = at(10, 5);
    const route = findWalk(office, from, desk);
    const arrival = route.at(-1);

    expect(arrival).toBeDefined();
    if (!arrival) return;
    expect(bodyFits(office, arrival.x, arrival.y)).toBe(true);
    expect(Math.hypot(arrival.x - desk.x, arrival.y - desk.y)).toBeLessThanOrEqual(TILE_SIZE);
    assertWalkable(office, from, route);
  });

  it('gets as close as the office allows to a tap inside the wall', () => {
    const from = at(5, OPEN_ROW);
    const wall = at(6, 0);
    const route = findWalk(office, from, wall);
    const arrival = route.at(-1);

    expect(arrival).toBeDefined();
    if (!arrival) return;
    expect(bodyFits(office, arrival.x, arrival.y)).toBe(true);
    expect(Math.hypot(arrival.y - wall.y, arrival.x - wall.x)).toBeLessThan(
      Math.hypot(from.y - wall.y, from.x - wall.x),
    );
    assertWalkable(office, from, route);
  });

  it('has nowhere to send you when you tapped the tile under your own feet', () => {
    const from = at(5, OPEN_ROW);
    expect(findWalk(office, from, { x: from.x + 3, y: from.y + 4 })).toEqual([]);
  });

  it('says nothing at all from outside the office grid', () => {
    expect(findWalk(office, { x: -40, y: -40 }, at(5, OPEN_ROW))).toEqual([]);
  });

  it('keeps every waypoint somewhere a body can stand, corner to corner', () => {
    // The far diagonal: past both desk rows, the kitchenette and the rug.
    const from = at(2, 3);
    const route = findWalk(office, from, at(29, 18));

    expect(route.length).toBeGreaterThan(0);
    for (const waypoint of route) {
      expect(bodyFits(office, waypoint.x, waypoint.y)).toBe(true);
    }
    assertWalkable(office, from, route);
  });
});
