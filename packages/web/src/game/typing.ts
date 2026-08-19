/**
 * Whether the letters landing on this window belong to a form rather than to
 * the floor.
 *
 * Phaser tracks key state on the window, so WASD reaches the office whatever
 * has focus — including a text field the UI has put over it. Somebody typing
 * their own name to confirm a deletion is not asking to walk east.
 */
export function isTypingSomewhere(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    // `=== true` because not every environment defines the property, and an
    // answer of `undefined` to a yes/no question is its own small bug.
    (active instanceof HTMLElement && active.isContentEditable === true)
  );
}
