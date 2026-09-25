// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardInset } from './viewport.js';

/**
 * The one thing about a phone that no media query and no CSS unit answers.
 *
 * A software keyboard is not browser chrome: it slides over the page without
 * changing the layout viewport, so `dvh` does not move and a panel pinned to
 * the bottom edge ends up underneath the keys somebody is about to press.
 * `visualViewport` is the only thing that can see it happen.
 */

/** A stand-in for the browser's own, with a handle to move it. */
function fakeViewport(height: number) {
  const listeners = new Set<() => void>();
  return {
    height,
    offsetTop: 0,
    addEventListener(_type: string, fn: () => void) {
      listeners.add(fn);
    },
    removeEventListener(_type: string, fn: () => void) {
      listeners.delete(fn);
    },
    /** What a keyboard opening looks like from here. */
    move(nextHeight: number, nextOffsetTop = 0) {
      this.height = nextHeight;
      this.offsetTop = nextOffsetTop;
      for (const fn of listeners) fn();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

describe('useKeyboardInset', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('answers zero where nothing can tell it otherwise', () => {
    // No `visualViewport` at all: older browsers, and every test environment.
    // Zero is the desktop answer, which changes nothing.
    vi.stubGlobal('visualViewport', undefined);
    expect(renderHook(() => useKeyboardInset()).result.current).toBe(0);
  });

  it('measures the keyboard as it opens and closes', () => {
    const viewport = fakeViewport(window.innerHeight);
    vi.stubGlobal('visualViewport', viewport);

    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);

    act(() => viewport.move(window.innerHeight - 300));
    expect(result.current).toBe(300);

    act(() => viewport.move(window.innerHeight));
    expect(result.current).toBe(0);
  });

  it('allows for the shift iOS makes when a field near the bottom takes focus', () => {
    // The keyboard's top edge is at `offsetTop + height`, not at `height`. A
    // panel lifted by 300 here would float forty pixels above the keys — and
    // this shift only happens when a text field is focused, which is the only
    // time anything is reading this at all.
    const viewport = fakeViewport(window.innerHeight);
    vi.stubGlobal('visualViewport', viewport);
    const { result } = renderHook(() => useKeyboardInset());

    act(() => viewport.move(window.innerHeight - 300, 40));
    expect(result.current).toBe(260);
  });

  it('never reports a negative inset, and lets go of its listeners', () => {
    const viewport = fakeViewport(window.innerHeight);
    vi.stubGlobal('visualViewport', viewport);
    const { result, unmount } = renderHook(() => useKeyboardInset());

    // Pinch-zoom can make the visual viewport taller than the layout one.
    // There is no such thing as a keyboard of minus sixty pixels.
    act(() => viewport.move(window.innerHeight + 60));
    expect(result.current).toBe(0);

    expect(viewport.listenerCount).toBeGreaterThan(0);
    unmount();
    expect(viewport.listenerCount).toBe(0);
  });
});
