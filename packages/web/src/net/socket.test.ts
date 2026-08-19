import type { AdminOp } from '@sloppers/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store.js';
import { OfficeSocket, sendAdmin } from './socket.js';

/**
 * `OfficeSocket` talks to real browser globals (WebSocket, window, document,
 * localStorage) that don't exist in vitest's default node environment.
 * These are the minimal stand-ins needed to drive `start()` through a real
 * connect/open/message/close cycle without a jsdom dependency.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Test helper: simulate the connection completing. */
  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper: simulate a server message. */
  triggerMessage(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** Test helper: simulate the server (or network) closing the socket. */
  triggerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const storageData = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (key: string) => storageData.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storageData.set(key, value);
  },
  removeItem: (key: string) => {
    storageData.delete(key);
  },
};

// biome-ignore lint/suspicious/noExplicitAny: minimal browser-global shims for a node test environment
(globalThis as any).WebSocket = FakeWebSocket;
// biome-ignore lint/suspicious/noExplicitAny: same
(globalThis as any).location = { protocol: 'http:', host: 'localhost' };
// biome-ignore lint/suspicious/noExplicitAny: same
(globalThis as any).window = {
  setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
  clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  addEventListener: () => {},
  removeEventListener: () => {},
};
// biome-ignore lint/suspicious/noExplicitAny: same
(globalThis as any).document = {
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
};
// biome-ignore lint/suspicious/noExplicitAny: same
(globalThis as any).localStorage = fakeLocalStorage;

describe('OfficeSocket', () => {
  let socket: OfficeSocket | null = null;

  beforeEach(() => {
    useStore.getState().reset();
    FakeWebSocket.instances.length = 0;
    storageData.clear();
  });

  afterEach(() => {
    socket?.stop();
    socket = null;
  });

  function startAndOpen(): FakeWebSocket {
    socket = new OfficeSocket({
      kind: 'create',
      roomName: 'test office',
      displayName: 'ridham',
      avatar: 'pixel',
    });
    socket.start();
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error('expected a socket to have been created');
    ws.triggerOpen();
    ws.sent.length = 0; // discard the join message; tests only care about what comes after
    return ws;
  }

  it('sendAdmin forwards the op to the live connection, so UI never touches the socket', () => {
    const ws = startAndOpen();
    const op: AdminOp = { kind: 'roster' };

    sendAdmin(op);

    expect(ws.sent).toHaveLength(1);
    const [sent] = ws.sent;
    if (!sent) throw new Error('expected a message to have been sent');
    expect(JSON.parse(sent)).toEqual({ type: 'admin', op });
  });

  it('sendAdmin is a no-op once the socket has stopped', () => {
    const ws = startAndOpen();
    socket?.stop();

    sendAdmin({ kind: 'roster' });

    expect(ws.sent).toHaveLength(0);
  });

  it('closes the connection on stop, which is what takes a knocker off the door', () => {
    // Giving up at the door has no message of its own: the office drops the
    // knock in its socket close handler and pushes the shortened queue. So
    // the whole withdrawal rests on `stop()` really closing, and on it not
    // reconnecting afterwards and rejoining the queue.
    const ws = startAndOpen();

    socket?.stop();

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    const opened = FakeWebSocket.instances.length;
    ws.triggerClose();
    expect(FakeWebSocket.instances).toHaveLength(opened);
  });

  it('leaves the connection state alone after removal, instead of reopening a reconnect loop', () => {
    const ws = startAndOpen();

    ws.triggerMessage({ type: 'removed', reason: 'banned' });
    expect(useStore.getState().connection).toBe('idle');

    // The server closes the socket right after telling us we're removed —
    // this used to flip the store back to 'reconnecting' and schedule a
    // retry with now-invalid credentials.
    ws.triggerClose();

    expect(useStore.getState().connection).toBe('idle');
    expect(useStore.getState().removed).toBe('banned');
    expect(useStore.getState().phase).toBe('join');
  });
});
