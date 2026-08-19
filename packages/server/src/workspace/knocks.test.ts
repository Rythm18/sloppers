import { describe, expect, it } from 'vitest';
import { KnockRegistry } from './knocks.js';

const fakeSocket = () => ({ readyState: 1, OPEN: 1, send: () => {}, close: () => {} }) as never;

describe('KnockRegistry', () => {
  it('registers a knock and lists it oldest first', () => {
    const knocks = new KnockRegistry();
    const first = knocks.add(fakeSocket(), 'ridham', 'pixel');
    knocks.add(fakeSocket(), 'sam', 'mochi');
    expect(knocks.list()).toHaveLength(2);
    expect(knocks.list()[0]?.id).toBe(first.id);
    expect(knocks.get(first.id)?.displayName).toBe('ridham');
  });

  it('forgets a knock when its socket goes away', () => {
    const knocks = new KnockRegistry();
    const socket = fakeSocket();
    knocks.add(socket, 'ridham', 'pixel');
    knocks.removeBySocket(socket);
    expect(knocks.list()).toHaveLength(0);
  });

  it('forgets only the socket it was asked about', () => {
    const knocks = new KnockRegistry();
    const mine = fakeSocket();
    knocks.add(mine, 'ridham', 'pixel');
    const theirs = knocks.add(fakeSocket(), 'sam', 'mochi');
    knocks.removeBySocket(mine);
    expect(knocks.list().map((k) => k.id)).toEqual([theirs.id]);
  });
});
