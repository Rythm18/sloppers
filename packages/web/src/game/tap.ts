/**
 * What a finger lifting off the office floor means.
 *
 * Two things have to be true before a pointer release is a destination, and
 * both of them are about what the pointer was doing rather than where it
 * ended up. It must not have travelled — a drag across the office is somebody
 * looking around, or a stray swipe, and answering it by teleporting the
 * avatar to wherever the finger stopped is the single worst thing tap-to-walk
 * can do. And nothing may have been under it: an avatar under the finger owns
 * that tap, because peeking at a teammate is the more specific request and
 * walking to where they stand is not a substitute for it.
 *
 * Deliberately no time limit. A press held while somebody reads the room and
 * then released still walks; the alternative is a careful, deliberate tap
 * that silently does nothing, which is the worse of the two surprises.
 */

/** How far a finger may travel and still have meant one spot. */
export const TAP_SLOP_PX = 14;

export function meansWalkThere(gesture: { travelledPx: number; onAvatar: boolean }): boolean {
  return !gesture.onAvatar && gesture.travelledPx <= TAP_SLOP_PX;
}
