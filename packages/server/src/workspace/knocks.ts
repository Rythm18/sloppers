import { randomBytes } from 'node:crypto';
import type { KnockView } from '@sloppers/protocol';
import type { WebSocket } from 'ws';

export interface Knock extends KnockView {
  ws: WebSocket;
}

/**
 * Whether anyone is still behind this knock. A closed tab stays in the
 * registry until its socket's close handler runs, so admitting one without
 * asking would mint a member nobody is holding.
 */
export function knockIsLive(knock: Knock): boolean {
  return knock.ws.readyState === knock.ws.OPEN;
}

/**
 * People waiting at the door of a knock-mode workspace. Deliberately
 * in-memory and tied to the waiting socket: close the tab and the knock is
 * gone, which needs no table, no expiry sweep, and no cleanup path. The
 * connection budget already caps how many can exist.
 */
export class KnockRegistry {
  private knocks = new Map<string, Knock>();

  add(ws: WebSocket, displayName: string, avatar: string): KnockView {
    const knock: Knock = {
      id: `k_${randomBytes(8).toString('hex')}`,
      displayName,
      avatar,
      requestedAt: Date.now(),
      ws,
    };
    this.knocks.set(knock.id, knock);
    return { id: knock.id, displayName, avatar, requestedAt: knock.requestedAt };
  }

  get(id: string): Knock | undefined {
    return this.knocks.get(id);
  }

  remove(id: string): void {
    this.knocks.delete(id);
  }

  removeBySocket(ws: WebSocket): void {
    for (const [id, knock] of this.knocks) {
      if (knock.ws === ws) this.knocks.delete(id);
    }
  }

  list(): KnockView[] {
    return [...this.knocks.values()]
      .map(({ id, displayName, avatar, requestedAt }) => ({ id, displayName, avatar, requestedAt }))
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }
}
