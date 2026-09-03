import { describe, expect, it } from 'vitest';
import { type Gesture, meansWalkThere, TAP_SLOP_PX } from './tap.js';

/**
 * The office floor and the people standing on it share one surface, and a
 * finger is a blunt instrument. Everything here is about the taps that must
 * not become a walk: one aimed at a teammate, one that was not a tap at all,
 * and one that was not a finger.
 */

const TAP: Gesture = { fromTouch: true, onCanvas: true, travelledPx: 0, onAvatar: false };

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
    expect(meansWalkThere({ ...TAP, travelledPx: 2 })).toBe(true);
  });

  // Every panel in the React overlay rests on this. Phaser listens for touch
  // on the *window* and filters by target, so DOM stacking is not what keeps
  // a tap off the office — a gate inside Phaser is, and it is an internal we
  // reach through a caret range. Restated here so it is ours to keep.
  it('ignores a finger that came off a panel laid over the office', () => {
    expect(meansWalkThere({ ...TAP, onCanvas: false })).toBe(false);
  });

  it('ignores it however still and however clear of an avatar it was', () => {
    expect(
      meansWalkThere({ fromTouch: true, onCanvas: false, travelledPx: 0, onAvatar: false }),
    ).toBe(false);
  });
});
