/**
 * Whether this person is done being told their avatar has nothing to show.
 *
 * Keyed by member id, deliberately. The other thing this browser keeps is an
 * identity filed under the office's invite code (`net/socket.ts`), and that
 * key moves when the invite is rotated. The member id inside it never moves,
 * and travels intact through `sloppers relink` onto a second browser as well
 * — so the dismissal follows the person rather than the door they came in by.
 *
 * Clearing site data is the one thing that does bring it back, and that is
 * right: the identity went with it, so the office is meeting a stranger.
 *
 * Two ways to get here, and both are permanent. Dismissing it says "I know,
 * and I am not going to" — a perfectly good answer that must not be asked
 * again. Actually sharing settles it too, and that is the half `sharing` on
 * the wire can no longer carry on its own: it means a collector is connected
 * *now*, so it falls again the moment a laptop shuts. Whether somebody has
 * ever answered the question is a different fact from whether their machine
 * is awake, and only the first one belongs here.
 */

const KEY = 'sloppers:share-nudge:';

/**
 * localStorage is not always there to be had — Safari's private mode has
 * historically thrown on write, an iframe can be denied storage outright —
 * and none of that is worth an exception thrown out of a render. The failure
 * mode of guessing wrong is one extra nudge, so both directions guess "not
 * settled" and carry on.
 */
export function nudgeSettled(memberId: string): boolean {
  try {
    return localStorage.getItem(KEY + memberId) !== null;
  } catch {
    return false;
  }
}

export function settleNudge(memberId: string): void {
  try {
    localStorage.setItem(KEY + memberId, String(Date.now()));
  } catch {
    // Nothing to do about it, and nothing worth breaking the office over.
  }
}
