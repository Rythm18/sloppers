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
 *
 * This must stay word for word the same as the stacking block in
 * `styles/app.css`. It is the same question asked in two languages, and the
 * only thing that reads wrong when they disagree is a board that opens over
 * an office it was supposed to sit beside.
 */
const STACKED = '(max-width: 720px) and (min-height: 500px)';

/**
 * Asked of `globalThis` rather than `window` on purpose: this is read at
 * module load by the store, and the store is loaded by tests that have no
 * `window` at all. A missing `matchMedia` answers no, which is the desktop
 * answer, which is the one that changes nothing.
 */
function ask(query: string): boolean {
  if (typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia(query).matches;
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
 * How many pixels of the window an on-screen keyboard is currently covering.
 *
 * The one thing about a phone that no media query and no CSS unit answers.
 * `dvh` is the viewport as the *browser* chrome leaves it, which is what it
 * was added for and is why every height cap in `app.css` uses it — but a
 * software keyboard is not browser chrome. It slides over the page without
 * changing the layout viewport at all, so a panel pinned to `bottom: 0` with
 * a text field in it puts that field squarely underneath the keys somebody is
 * about to press.
 *
 * `visualViewport` is what knows: it reports the part of the page actually on
 * screen, and the difference between that and `innerHeight` is the keyboard.
 * Absent on older browsers and in jsdom, where the answer is zero — which is
 * the desktop answer, which changes nothing.
 *
 * Clamped at zero, and against `offsetTop` as well as height: iOS scrolls the
 * visual viewport up when a field is focused near the bottom, and reading the
 * height alone would under-report the inset by exactly that scroll.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = globalThis.visualViewport;
    if (!viewport) return;
    const measure = () => {
      setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    };
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
    };
  }, []);

  return inset;
}

/**
 * `isTouchSession`, but the component asking is re-rendered when it changes.
 * Plugging in a mouse must not leave a phone's wording on the screen.
 */
export function useTouchSession(): boolean {
  const [touch, setTouch] = useState(isTouchSession);

  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return;
    const list = globalThis.matchMedia(TOUCH);
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
