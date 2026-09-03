/**
 * What a finger lifting off the office floor means.
 *
 * Three things have to be true, and none of them is about where the pointer
 * ended up.
 *
 * It has to have been a finger. A mouse click on bare floor did nothing
 * before and does nothing now — desktop already has two ways to drive the
 * avatar and did not ask for a third, and somebody clicking the floor to
 * dismiss a bubble should not find themselves walking. This is asked of the
 * event rather than of the screen on purpose: a laptop with a touchscreen
 * reports a fine pointer and still gets real taps, and the question worth
 * answering is what *this* interaction was, not what the hardware mostly is.
 *
 * It must not have travelled. A drag across the office is somebody looking
 * around or a stray swipe, and answering it by sending the avatar to wherever
 * the finger stopped is the single worst thing tap-to-walk can do.
 *
 * And nothing may have been under it. An avatar under the finger owns that
 * tap: peeking at a teammate is the more specific request, and walking over
 * to where they stand is not a substitute for it.
 *
 * Deliberately no time limit. A press held while somebody reads the room and
 * then released still walks; the alternative is a careful, deliberate tap
 * that silently does nothing, which is the worse of the two surprises.
 */

/** How far a finger may travel and still have meant one spot. */
export const TAP_SLOP_PX = 14;

export interface Gesture {
  /** Whether this pointer release came from a touchscreen. */
  fromTouch: boolean;
  travelledPx: number;
  onAvatar: boolean;
}

export function meansWalkThere(gesture: Gesture): boolean {
  return gesture.fromTouch && !gesture.onAvatar && gesture.travelledPx <= TAP_SLOP_PX;
}
