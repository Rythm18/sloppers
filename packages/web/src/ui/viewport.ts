import { useEffect, useState } from 'react';

/**
 * What the office is being looked at through.
 *
 * Both questions are put to the browser rather than guessed from a user
 * agent string, because both have answers that change under us: a tablet
 * gains a keyboard, a laptop has a touchscreen nobody uses, a phone is turned
 * sideways mid-session. `matchMedia` is the only thing that knows, and it
 * says so again when the answer changes.
 */

/** A finger, not a mouse — where "click" is not a word anybody would use. */
const TOUCH = '(pointer: coarse)';

/**
 * Narrow, with the height to stack in. The office chrome sits beside the
 * floor until both are true; a phone turned sideways fails the second and
 * keeps the side-by-side layout, which is the right one for a shape that is
 * all width and no height.
 */
const STACKED = '(max-width: 720px) and (min-height: 480px)';

function ask(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/** Whether this session is driven by a finger. */
export function isTouchSession(): boolean {
  return ask(TOUCH);
}

/** Whether the chrome is stacked over the office rather than sat beside it. */
export function isStackedLayout(): boolean {
  return ask(STACKED);
}

/**
 * `isTouchSession`, but the component asking is re-rendered when it changes.
 * Plugging in a mouse must not leave a phone's wording on the screen.
 */
export function useTouchSession(): boolean {
  const [touch, setTouch] = useState(isTouchSession);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(TOUCH);
    const onChange = () => setTouch(list.matches);
    // Re-read on the way in as well: the query could have flipped between the
    // first render and this effect, and the listener only hears what happens
    // after it is attached.
    onChange();
    if (typeof list.addEventListener !== 'function') return;
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);

  return touch;
}
