// @vitest-environment jsdom
import type { ServerToWeb } from '@sloppers/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store.js';
import { KnockingScreen } from './KnockingScreen.js';

/**
 * The one thing this screen can get wrong is claiming to know something it
 * doesn't. These tests are about which sentence it shows for which answer
 * from the office, and about following that answer when it changes.
 */

const apply = (msg: ServerToWeb) => act(() => useStore.getState().applyServer(msg));

const NOBODY = /Nobody's around to answer yet/;
const SOMEBODY = /Someone inside can see you waiting/;

describe('KnockingScreen', () => {
  beforeEach(() => useStore.getState().reset());
  afterEach(cleanup);

  it('names the office it is waiting at', () => {
    apply({ type: 'knocking', answerable: true });
    render(<KnockingScreen officeName="the lab" />);

    expect(screen.getByText('the lab')).toBeTruthy();
  });

  it('says nobody is around only when the office said so', () => {
    apply({ type: 'knocking', answerable: false });
    render(<KnockingScreen officeName="the lab" />);

    expect(screen.getByText(NOBODY)).toBeTruthy();
    expect(screen.queryByText(SOMEBODY)).toBeNull();
  });

  it('says somebody can see you when the office said that instead', () => {
    apply({ type: 'knocking', answerable: true });
    render(<KnockingScreen officeName="the lab" />);

    expect(screen.getByText(SOMEBODY)).toBeTruthy();
    expect(screen.queryByText(NOBODY)).toBeNull();
  });

  it('claims neither when the office did not say', () => {
    // An older server: the field is optional on the wire, and guessing at an
    // empty office in somebody's face is exactly what this must not do.
    apply({ type: 'knocking' });
    render(<KnockingScreen officeName="the lab" />);

    expect(screen.queryByText(NOBODY)).toBeNull();
    expect(screen.queryByText(SOMEBODY)).toBeNull();
    expect(screen.getByText(/let you in the moment somebody answers/)).toBeTruthy();
  });

  it('stops saying nobody is around the moment somebody turns up', () => {
    apply({ type: 'knocking', answerable: false });
    render(<KnockingScreen officeName="the lab" />);
    expect(screen.getByText(NOBODY)).toBeTruthy();

    // The office re-sends this, unprompted, when a moderator connects.
    apply({ type: 'knocking', answerable: true });

    expect(screen.queryByText(NOBODY)).toBeNull();
    expect(screen.getByText(SOMEBODY)).toBeTruthy();
  });

  it('falls back to a neutral word when the invite preview never loaded', () => {
    apply({ type: 'knocking', answerable: false });
    render(<KnockingScreen officeName={null} />);

    expect(screen.getByText('the office')).toBeTruthy();
  });
});
