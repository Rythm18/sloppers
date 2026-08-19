import {
  AVATAR_IDS,
  type Direction,
  type MemberView,
  type Position,
  type PresenceState,
} from '@sloppers/protocol';
import Phaser from 'phaser';
import { useStore } from '../store.js';
import { bridge, positionAnchor } from './bridge.js';
import { buildOffice, isBlocked, type OfficeMap, WORLD_H, WORLD_W } from './map.js';
import { TILE_SIZE } from './tiles.gen.js';
import { isTypingSomewhere } from './typing.js';

const SPEED = 110;
const REMOTE_SPEED = 130;
const NEARBY_RADIUS = 88;
const MAX_NEARBY = 3;
const HEAD_OFFSET = 26;

const PRESENCE_TINT: Record<PresenceState, number> = {
  active: 0x7de0a6,
  grinding: 0xffb454,
  'needs-attention': 0xff6b81,
  afk: 0x8a80a5,
  offline: 0x4a4458,
};

const DIR_ROW: Record<Direction, number> = { down: 0, left: 1, right: 2, up: 3 };

function walkKey(avatar: string, dir: Direction): string {
  return `${avatar}-walk-${dir}`;
}

/** One rendered person: sprite + name label + presence pip. */
class AvatarActor {
  sprite: Phaser.GameObjects.Sprite;
  private label: Phaser.GameObjects.Text;
  private pip: Phaser.GameObjects.Rectangle;
  private target: Position;
  private avatar: string;

  constructor(
    scene: Phaser.Scene,
    public view: MemberView,
  ) {
    this.avatar = view.avatar;
    this.target = view.position;
    this.sprite = scene.add
      .sprite(
        view.position.x,
        view.position.y,
        `char-${view.avatar}`,
        DIR_ROW[view.position.dir] * 4,
      )
      .setOrigin(0.5, 0.85);
    this.sprite.setInteractive({ useHandCursor: true });
    this.sprite.on('pointerdown', () => bridge.emit('avatar-click', view.id));
    this.label = scene.add
      .text(view.position.x, view.position.y, view.displayName, {
        fontFamily: 'Silkscreen, monospace',
        fontSize: '8px',
        color: '#f3ebdd',
      })
      .setResolution(4)
      .setOrigin(0.5, 1);
    this.pip = scene.add.rectangle(0, 0, 3, 3, PRESENCE_TINT[view.presence]);
    this.applyView(view);
  }

  applyView(view: MemberView): void {
    this.view = view;
    this.applyPresence(view.presence);
    if (view.avatar !== this.avatar) {
      this.avatar = view.avatar;
      this.sprite.setTexture(`char-${view.avatar}`, DIR_ROW[this.target.dir] * 4);
    }
  }

  applyPresence(presence: PresenceState): void {
    this.view = { ...this.view, presence };
    this.pip.fillColor = PRESENCE_TINT[presence];
    this.sprite.setAlpha(presence === 'offline' ? 0.45 : 1);
    this.label.setAlpha(presence === 'offline' ? 0.5 : 0.9);
  }

  setTarget(position: Position): void {
    this.target = position;
  }

  update(dtMs: number): void {
    const { sprite, target } = this;
    const dx = target.x - sprite.x;
    const dy = target.y - sprite.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 60) {
      // Teleport rather than glide across the office after a hiccup.
      sprite.setPosition(target.x, target.y);
    } else if (dist > 1) {
      const step = (REMOTE_SPEED * dtMs) / 1000;
      const t = Math.min(1, step / dist);
      sprite.setPosition(sprite.x + dx * t, sprite.y + dy * t);
    }
    const moving = dist > 2 || target.moving;
    if (moving) sprite.anims.play(walkKey(this.avatar, target.dir), true);
    else {
      sprite.anims.stop();
      sprite.setFrame(DIR_ROW[target.dir] * 4);
    }
    this.syncOverlays();
  }

  syncOverlays(): void {
    this.sprite.setDepth(this.sprite.y);
    this.label.setPosition(this.sprite.x + 3, this.sprite.y - HEAD_OFFSET + 2).setDepth(10_000);
    this.pip
      .setPosition(this.label.x - this.label.width / 2 - 4, this.label.y - 5)
      .setDepth(10_000);
  }

  destroy(): void {
    this.sprite.destroy();
    this.label.destroy();
    this.pip.destroy();
  }
}

export class OfficeScene extends Phaser.Scene {
  private office!: OfficeMap;
  private player: AvatarActor | null = null;
  private actors = new Map<string, AvatarActor>();
  private keys!: Record<
    'up' | 'down' | 'left' | 'right' | 'w' | 'a' | 's' | 'd',
    Phaser.Input.Keyboard.Key
  >;
  private lastSent: Position | null = null;
  private nearbyAt = 0;
  private unsubscribes: (() => void)[] = [];

  constructor() {
    super('office');
  }

  preload(): void {
    this.load.spritesheet('tiles', '/assets/tiles.png', {
      frameWidth: TILE_SIZE,
      frameHeight: TILE_SIZE,
    });
    const avatars = new Set(Object.values(useStore.getState().members).map((m) => m.avatar));
    // Load every cast sheet up front; twelve tiny PNGs.
    for (const id of AVATAR_IDS) avatars.add(id);
    for (const id of avatars) {
      this.load.spritesheet(`char-${id}`, `/assets/char-${id}.png`, {
        frameWidth: 16,
        frameHeight: 20,
      });
    }
  }

  create(): void {
    this.office = buildOffice();
    this.buildTilemap();
    this.buildAnimations();

    const cam = this.cameras.main;
    cam.setBounds(0, 0, WORLD_W, WORLD_H);
    cam.setRoundPixels(true);

    const state = useStore.getState();
    const you = state.you;
    for (const view of Object.values(state.members)) {
      if (view.id === you) this.ensurePlayer(view);
      else this.actors.set(view.id, new AvatarActor(this, view));
    }
    // If our own member view raced the world message, the 'member' bridge
    // handler below creates the player when it arrives.

    this.applyZoom();
    this.scale.on('resize', () => this.applyZoom());

    const keyboard = this.input.keyboard;
    if (keyboard) {
      // Capture off (the `false`): Phaser's default is to preventDefault every
      // key it watches, anywhere on the page — which silently eats w, a, s and
      // d from any text field the UI puts over the office. There is nothing to
      // protect the arrows from either; the body does not scroll.
      this.keys = keyboard.addKeys('up,down,left,right,w,a,s,d', false) as OfficeScene['keys'];
    }

    this.unsubscribes.push(
      bridge.on('pos', ({ memberId, position }) => {
        this.actors.get(memberId)?.setTarget(position);
      }),
      bridge.on('member', (view) => {
        if (view.id === useStore.getState().you) {
          if (this.player) this.player.applyView(view);
          else this.ensurePlayer(view);
          return;
        }
        const existing = this.actors.get(view.id);
        if (existing) existing.applyView(view);
        else this.actors.set(view.id, new AvatarActor(this, view));
      }),
      bridge.on('member-left', (memberId) => {
        this.actors.get(memberId)?.destroy();
        this.actors.delete(memberId);
      }),
      bridge.on('presence', ({ memberId, presence }) => {
        if (memberId === useStore.getState().you) this.player?.applyPresence(presence);
        else this.actors.get(memberId)?.applyPresence(presence);
      }),
      bridge.on('world', ({ you: youId, members }) => {
        // Reconnect: rebuild the population in place.
        for (const actor of this.actors.values()) actor.destroy();
        this.actors.clear();
        for (const view of members) {
          if (view.id === youId) {
            if (this.player) this.player.applyView(view);
            else this.ensurePlayer(view);
          } else {
            this.actors.set(view.id, new AvatarActor(this, view));
          }
        }
        // The server respawned us at a default position; re-assert where we
        // actually stand so others don't see us parked at spawn.
        if (this.player && this.lastSent) bridge.emit('self-move', this.lastSent);
      }),
    );
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    });
  }

  /** Create the local player (possibly late, if the world message raced). */
  private ensurePlayer(view: MemberView): void {
    if (this.player) return;
    // Clicking yourself opens your own card — a mirror of what you share.
    this.player = new AvatarActor(this, view);
    this.cameras.main.startFollow(this.player.sprite, true);
  }

  private buildTilemap(): void {
    const map = this.make.tilemap({
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
      width: this.office.floor[0]?.length ?? 0,
      height: this.office.floor.length,
    });
    const tileset = map.addTilesetImage('tiles', 'tiles', TILE_SIZE, TILE_SIZE);
    if (!tileset) throw new Error('tileset failed to load');
    const floorLayer = map.createBlankLayer('floor', tileset);
    const stuffLayer = map.createBlankLayer('stuff', tileset);
    if (!floorLayer || !stuffLayer) throw new Error('tilemap layers failed');
    for (const [y, row] of this.office.floor.entries()) {
      for (const [x, tile] of row.entries()) floorLayer.putTileAt(tile, x, y);
    }
    for (const [y, row] of this.office.furniture.entries()) {
      for (const [x, tile] of row.entries()) {
        if (tile >= 0) stuffLayer.putTileAt(tile, x, y);
      }
    }
    floorLayer.setDepth(-2);
    stuffLayer.setDepth(-1);
  }

  private buildAnimations(): void {
    for (const id of AVATAR_IDS) {
      if (!this.textures.exists(`char-${id}`)) continue;
      for (const dir of ['down', 'left', 'right', 'up'] as const) {
        const row = DIR_ROW[dir] * 4;
        if (this.anims.exists(walkKey(id, dir))) continue;
        this.anims.create({
          key: walkKey(id, dir),
          frames: this.anims.generateFrameNumbers(`char-${id}`, {
            frames: [row, row + 1, row + 2, row + 3],
          }),
          frameRate: 8,
          repeat: -1,
        });
      }
    }
  }

  private applyZoom(): void {
    const { width, height } = this.scale.gameSize;
    const zoom = Math.max(2, Math.ceil(Math.max(width / WORLD_W, height / WORLD_H)));
    this.cameras.main.setZoom(zoom);
  }

  override update(_time: number, dtMs: number): void {
    this.updatePlayer(dtMs);
    for (const actor of this.actors.values()) actor.update(dtMs);
    this.updateAnchors();
    this.updateNearby();
  }

  private updatePlayer(dtMs: number): void {
    if (!this.player || !this.keys) return;
    const k = this.keys;
    // Somebody typing their own name to confirm a deletion is not asking to
    // walk east. Keyboard state is global to the window, so the office has to
    // notice where the letters are actually going.
    const typing = isTypingSomewhere();
    let vx = typing
      ? 0
      : (k.left.isDown || k.a.isDown ? -1 : 0) + (k.right.isDown || k.d.isDown ? 1 : 0);
    let vy = typing
      ? 0
      : (k.up.isDown || k.w.isDown ? -1 : 0) + (k.down.isDown || k.s.isDown ? 1 : 0);
    const moving = vx !== 0 || vy !== 0;
    if (vx !== 0 && vy !== 0) {
      vx *= Math.SQRT1_2;
      vy *= Math.SQRT1_2;
    }

    const sprite = this.player.sprite;
    const step = (SPEED * dtMs) / 1000;
    const tryMove = (nx: number, ny: number): boolean => {
      for (const [ox, oy] of [
        [-5, -1],
        [5, -1],
        [-5, 3],
        [5, 3],
      ] as const) {
        if (isBlocked(this.office, nx + ox, ny + oy)) return false;
      }
      return true;
    };
    if (vx !== 0 && tryMove(sprite.x + vx * step, sprite.y)) sprite.x += vx * step;
    if (vy !== 0 && tryMove(sprite.x, sprite.y + vy * step)) sprite.y += vy * step;

    let dir: Direction = this.lastSent?.dir ?? 'down';
    if (vx < 0) dir = 'left';
    else if (vx > 0) dir = 'right';
    else if (vy < 0) dir = 'up';
    else if (vy > 0) dir = 'down';

    if (moving) sprite.anims.play(walkKey(this.player.view.avatar, dir), true);
    else {
      sprite.anims.stop();
      sprite.setFrame(DIR_ROW[dir] * 4);
    }
    this.player.syncOverlays();

    const position: Position = {
      x: Math.round(sprite.x * 10) / 10,
      y: Math.round(sprite.y * 10) / 10,
      dir,
      moving,
    };
    const last = this.lastSent;
    if (
      !last ||
      last.x !== position.x ||
      last.y !== position.y ||
      last.dir !== position.dir ||
      last.moving !== position.moving
    ) {
      this.lastSent = position;
      bridge.emit('self-move', position);
    }
  }

  private updateAnchors(): void {
    const cam = this.cameras.main;
    const zoom = cam.zoom;
    const place = (id: string, actor: AvatarActor) => {
      const x = (actor.sprite.x - cam.worldView.x) * zoom;
      const y = (actor.sprite.y - HEAD_OFFSET - cam.worldView.y) * zoom;
      const visible =
        x > -200 &&
        x < this.scale.gameSize.width + 200 &&
        y > -120 &&
        y < this.scale.gameSize.height + 120;
      positionAnchor(id, x, y, visible);
    };
    for (const [id, actor] of this.actors) place(id, actor);
    if (this.player) place(this.player.view.id, this.player);
  }

  private updateNearby(): void {
    const now = this.time.now;
    if (now - this.nearbyAt < 300 || !this.player) return;
    this.nearbyAt = now;
    const px = this.player.sprite.x;
    const py = this.player.sprite.y;
    const near = [...this.actors.values()]
      .map((actor) => ({
        id: actor.view.id,
        d: Math.hypot(actor.sprite.x - px, actor.sprite.y - py),
        sharing: actor.view.sharing,
      }))
      .filter((a) => a.d < NEARBY_RADIUS && a.sharing)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_NEARBY)
      .map((a) => a.id);
    const current = useStore.getState().nearby;
    if (near.length !== current.length || near.some((id, i) => id !== current[i])) {
      useStore.getState().setNearby(near);
    }
  }
}
