import { type RefObject, useEffect, useRef } from 'react';

/**
 * Modal manners, shared by every dialog that takes the whole screen: focus
 * starts inside, Tab cannot leave — from within or from without — Escape
 * leaves, whatever had focus before gets it back, and the office behind is
 * made unreachable rather than merely announced as such.
 *
 * It lives here because two dialogs needing subtly different copies of this
 * is how one of them ends up leaking focus.
 */

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href]';

export function useModalManners(
  scrimRef: RefObject<HTMLDivElement | null>,
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  // Held in a ref so an inline `onClose` cannot re-run the effect below:
  // re-running it re-focuses the dialog, which would yank focus back out of
  // whatever the person had just tabbed to, on every render.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const restoreTo = document.activeElement;
    dialog?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const stops = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = stops[0];
      const last = stops.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      // Anywhere but here — the address bar, a stray click that landed
      // outside, whatever the page did behind our back — is pulled in. A trap
      // that only wraps its own ends leaves every other way out open.
      if (!(active instanceof Node) || !dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (restoreTo instanceof HTMLElement) restoreTo.focus();
    };
  }, [dialogRef]);

  // `aria-modal` is a promise that the rest of the page is unavailable, and a
  // promise is all it is — the office behind the dialog stays clickable and
  // readable to a screen reader unless something says otherwise. `inert` is
  // the something: the scrim's siblings are the whole world behind it.
  useEffect(() => {
    const scrim = scrimRef.current;
    const behind: HTMLElement[] = [];
    for (const sibling of scrim?.parentElement?.children ?? []) {
      if (sibling !== scrim && sibling instanceof HTMLElement) behind.push(sibling);
    }
    for (const element of behind) element.setAttribute('inert', '');
    return () => {
      for (const element of behind) element.removeAttribute('inert');
    };
  }, [scrimRef]);
}
