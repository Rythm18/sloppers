import { describe, expect, it } from 'vitest';
import { type Gesture, meansWalkThere, TAP_SLOP_PX } from './tap.js';

/**
 * The office floor and the people standing on it share one surface, and a
 * finger is a blunt instrument. Everything here is about the taps that must
 * not become a walk: one aimed at a teammate, one that was not a tap at all,
 * and one that was not a finger.
 */

const TAP: Gesture = { fromTouch: true, travelledPx: 0, onAvatar: false };

describe('meansWalkThere', () => {
  it('takes a still finger on the floor as a destination', () => {
    expect(meansWalkThere(TAP)).toBe(true);
  });

  it('leaves a tap on a teammate to the teammate', () => {
    expect(meansWalkThere({ ...TAP, onAvatar: true })).toBe(false);
  });

  it('reads a drag across the office as nothing at all', () => {
    expect(meansWalkThere({ ...TAP, travelledPx: 140 })).toBe(false);
  });

  it('forgives the wobble in a real finger', () => {
    expect(meansWalkThere({ ...TAP, travelledPx: TAP_SLOP_PX })).toBe(true);
    expect(meansWalkThere({ ...TAP, travelledPx: TAP_SLOP_PX + 1 })).toBe(false);
  });

  it('still leaves a teammate alone when the finger slid off them', () => {
    expect(meansWalkThere({ ...TAP, travelledPx: 4, onAvatar: true })).toBe(false);
  });

  // Desktop already walks on the keys and peeks on a click, and did not ask
  // for a third way to drive the avatar. Somebody clicking bare floor to put
  // a bubble away should not find themselves halfway across the office.
  it('is not a click: a mouse on bare floor still does nothing', () => {
    expect(meansWalkThere({ ...TAP, fromTouch: false })).toBe(false);
  });

  // Asked of the event, not of the hardware: a touchscreen laptop reports a
  // fine pointer for the trackpad it mostly uses and still takes real taps.
  it('answers a finger on a machine that also has a mouse', () => {
    expect(meansWalkThere({ fromTouch: true, travelledPx: 2, onAvatar: false })).toBe(true);
  });
});
