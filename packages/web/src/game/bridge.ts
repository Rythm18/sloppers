import type { MemberView, Position, ServerToWeb } from '@sloppers/protocol';

/**
 * The seam between the three worlds — network, Phaser, React — kept as one
 * tiny typed emitter so none of them import each other.
 *
 * High-frequency data (positions, screen-space anchors) flows through here
 * and through direct DOM mutation, never through React state; React only
 * re-renders on meaningful changes (presence, sessions, membership).
 */

interface BridgeEvents {
  /** Server world received; Phaser (re)builds the population. */
  world: { you: string; members: MemberView[] };
  member: MemberView;
  'member-left': string;
  presence: { memberId: string; presence: MemberView['presence'] };
  pos: { memberId: string; position: Position };
  /** Local player moved; the socket relays it. */
  'self-move': Position;
  /** Member ids near the player, for ambient bubbles. */
  nearby: string[];
  /** Player clicked an avatar. */
  'avatar-click': string;
}

type Handler<T> = (payload: T) => void;

class Bridge {
  private handlers = new Map<keyof BridgeEvents, Set<Handler<never>>>();

  on<K extends keyof BridgeEvents>(event: K, handler: Handler<BridgeEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set?.delete(handler as Handler<never>);
  }

  emit<K extends keyof BridgeEvents>(event: K, payload: BridgeEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) (handler as Handler<BridgeEvents[K]>)(payload);
  }
}

export const bridge = new Bridge();

/**
 * Screen-space anchors for the bubble layer: React registers a DOM element
 * per member; the scene writes transforms straight to the elements every
 * frame. No React involvement per frame.
 */
const anchors = new Map<string, HTMLElement>();

export function registerAnchor(memberId: string, el: HTMLElement | null): void {
  if (el) anchors.set(memberId, el);
  else anchors.delete(memberId);
}

export function positionAnchor(memberId: string, x: number, y: number, visible: boolean): void {
  const el = anchors.get(memberId);
  if (!el) return;
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  el.style.visibility = visible ? 'visible' : 'hidden';
}

export function routeServerMessage(msg: ServerToWeb): void {
  switch (msg.type) {
    case 'world':
      bridge.emit('world', { you: msg.you.memberId, members: msg.members });
      break;
    case 'member':
      bridge.emit('member', msg.member);
      break;
    case 'member-left':
      bridge.emit('member-left', msg.memberId);
      break;
    case 'presence':
      bridge.emit('presence', { memberId: msg.memberId, presence: msg.presence });
      break;
    case 'pos':
      bridge.emit('pos', { memberId: msg.memberId, position: msg.position });
      break;
    default:
      break;
  }
}
