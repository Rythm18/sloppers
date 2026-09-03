import { describe, expect, it } from 'vitest';
import { meansWalkThere, TAP_SLOP_PX } from './tap.js';

/**
 * The office floor and the people standing on it share one surface, and a
 * finger is a blunt instrument. Everything here is about the two taps that
 * must not become a walk: one that was aimed at a teammate, and one that was
 * not a tap at all.
 */
describe('meansWalkThere', () => {
  it('takes a still finger on the floor as a destination', () => {
    expect(meansWalkThere({ travelledPx: 0, onAvatar: false })).toBe(true);
  });

  it('leaves a tap on a teammate to the teammate', () => {
    expect(meansWalkThere({ travelledPx: 0, onAvatar: true })).toBe(false);
  });

  it('reads a drag across the office as nothing at all', () => {
    expect(meansWalkThere({ travelledPx: 140, onAvatar: false })).toBe(false);
  });

  it('forgives the wobble in a real finger', () => {
    expect(meansWalkThere({ travelledPx: TAP_SLOP_PX, onAvatar: false })).toBe(true);
    expect(meansWalkThere({ travelledPx: TAP_SLOP_PX + 1, onAvatar: false })).toBe(false);
  });

  it('still leaves a teammate alone when the finger slid off them', () => {
    expect(meansWalkThere({ travelledPx: 4, onAvatar: true })).toBe(false);
  });
});
