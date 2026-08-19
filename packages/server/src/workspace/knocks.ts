import { randomBytes } from 'node:crypto';
import type { KnockView } from '@sloppers/protocol';
import type { WebSocket } from 'ws';
import type { MemberRecord } from './manager.js';

/**
 * What the waiting connection does the moment the door is answered: the
 * member if they were let in, or `null` if the office refused them at the
 * last moment (their name was taken while they waited, or it filled up) and
 * they are free to knock again.
 *
 * It rides on the knock because only that socket's own message handler can
 * act on either outcome: the state that `move`, `activity` and `admin` read —
 * and the state that decides whether a fresh `join` is allowed — is
 * per-connection and invisible from here. Without it an admitted knocker
 * would be in the world but deaf, a second `join` on that socket would mint
 * them all over again, and a refused one could never try another name.
 */
export type AdmitHandler = (member: MemberRecord | null) => void;

export interface Knock extends KnockView {
  ws: WebSocket;
  admit: AdmitHandler;
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

  add(ws: WebSocket, displayName: string, avatar: string, admit: AdmitHandler): KnockView {
    const knock: Knock = {
      id: `k_${randomBytes(8).toString('hex')}`,
      displayName,
      avatar,
      requestedAt: Date.now(),
      ws,
      admit,
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
