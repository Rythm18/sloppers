// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemovalReason } from '../store.js';
import { RemovedScreen } from './RemovedScreen.js';

/**
 * Three ways to lose a seat, and they are not the same thing to the person
 * who lost it. These tests are about which card each reason gets and — the
 * part that matters — who is offered a way back in.
 */

function show(reason: RemovalReason) {
  const onJoinAgain = vi.fn();
  const onLeave = vi.fn();
  render(
    <RemovedScreen
      reason={reason}
      officeName="the lab"
      onJoinAgain={onJoinAgain}
      onLeave={onLeave}
    />,
  );
  return { onJoinAgain, onLeave };
}

const joinAgain = () => screen.queryByRole('button', { name: 'Join again' });
const leave = () => screen.getByRole('button', { name: /Back to sloppers/ });

describe('RemovedScreen', () => {
  afterEach(cleanup);

  it('tells a kicked member the door is only closed, not locked', () => {
    show('kicked');

    expect(screen.getByText('Shown the door')).toBeTruthy();
    expect(screen.getByText(/removed you from the lab/)).toBeTruthy();
    expect(screen.getByText(/invite link still works/)).toBeTruthy();
  });

  it('tells a banned member it was a decision about them', () => {
    show('banned');

    expect(screen.getByText('Banned')).toBeTruthy();
    expect(screen.getByText(/banned you from the lab/)).toBeTruthy();
    expect(screen.getByText(/ask whoever runs the office to lift it/)).toBeTruthy();
  });

  it('tells a deleted member what was actually erased', () => {
    show('deleted');

    expect(screen.getByText('Deleted')).toBeTruthy();
    expect(screen.getByText(/Your seat in the lab is gone/)).toBeTruthy();
    expect(screen.getByText(/no stats, no history/)).toBeTruthy();
  });

  it('offers a kicked member a way back in', () => {
    const { onJoinAgain } = show('kicked');
    const button = joinAgain();
    if (!button) throw new Error('a kicked member can walk back in');

    fireEvent.click(button);

    expect(onJoinAgain).toHaveBeenCalledTimes(1);
  });

  it('offers a deleted member a way back in', () => {
    const { onJoinAgain } = show('deleted');
    const button = joinAgain();
    if (!button) throw new Error('a deleted member may start over');

    fireEvent.click(button);

    expect(onJoinAgain).toHaveBeenCalledTimes(1);
  });

  it('offers a banned member no way back in', () => {
    // The office refuses them by name. A button that fires an op the server
    // will not honour is a worse answer than no button.
    show('banned');

    expect(joinAgain()).toBeNull();
  });

  it('gives every one of them the way back to the landing page', () => {
    for (const reason of ['kicked', 'banned', 'deleted'] as const) {
      const { onLeave } = show(reason);
      fireEvent.click(leave());
      expect(onLeave).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it('says "the office" rather than an empty gap when the name never arrived', () => {
    render(<RemovedScreen reason="kicked" officeName="" onJoinAgain={vi.fn()} onLeave={vi.fn()} />);

    expect(screen.getByText(/removed you from the office\./)).toBeTruthy();
  });
});
