import { useEffect, useRef, useState } from 'react';
import { TILE, TILE_SIZE } from '../game/tiles.gen.js';

/**
 * The hero isn't a screenshot — it's the office, running. A small canvas
 * simulation using the game's real sprite sheets: cast members wander a
 * strip of floor while their status bubbles surface one at a time. No
 * Phaser here; the landing stays light and the world stays true.
 */

const SCALE = 3;
const STRIP_TILES_Y = 5;
const CHAR_W = 16;
const CHAR_H = 20;
const WALK_FPS = 8;
const SPEED = 22; // px/s in world units — an unhurried office pace

interface CastMember {
  id: string;
  name: string;
  presence: 'active' | 'grinding' | 'needs-attention';
  line: string;
  tokens: string;
}

/** Real-feeling teammates; organic numbers, no Acme Corp. */
const CAST: CastMember[] = [
  {
    id: 'juniper',
    name: 'maya',
    presence: 'grinding',
    line: 'Migrating payments off the legacy API',
    tokens: '1.4M tok today',
  },
  {
    id: 'rusty',
    name: 'arjun',
    presence: 'needs-attention',
    line: 'Chasing a flaky deploy test',
    tokens: '847k tok today',
  },
  {
    id: 'mochi',
    name: 'nina',
    presence: 'active',
    line: 'Rebuilding onboarding, third attempt',
    tokens: '612k tok today',
  },
  {
    id: 'comet',
    name: 'theo',
    presence: 'grinding',
    line: 'Backfilling the events table',
    tokens: '2.1M tok today',
  },
  {
    id: 'fern',
    name: 'zoe',
    presence: 'active',
    line: 'Dark mode for the docs site',
    tokens: '389k tok today',
  },
  {
    id: 'pixel',
    name: 'ravi',
    presence: 'grinding',
    line: 'Writing a parser it swore was simple',
    tokens: '976k tok today',
  },
];

const PRESENCE_COLOR: Record<CastMember['presence'], string> = {
  active: '#7de0a6',
  grinding: '#ffb454',
  'needs-attention': '#ff6b81',
};

const PRESENCE_LABEL: Record<CastMember['presence'], string> = {
  active: 'at the desk',
  grinding: 'agents cooking',
  'needs-attention': 'agent needs input',
};

const DIR_ROW = { down: 0, left: 1, right: 2, up: 3 } as const;
type Dir = keyof typeof DIR_ROW;

interface Walker {
  member: CastMember;
  sheet: HTMLImageElement;
  x: number;
  y: number;
  tx: number;
  ty: number;
  dir: Dir;
  pauseUntil: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export function OfficeStrip() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [bubble, setBubble] = useState<{ member: CastMember; x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let cancelled = false;
    let bubbleTimer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      const [tiles, ...sheets] = await Promise.all([
        loadImage('/assets/tiles.png'),
        ...CAST.map((m) => loadImage(`/assets/char-${m.id}.png`)),
      ]);
      if (cancelled) return;

      const walkers: Walker[] = CAST.map((member, i) => ({
        member,
        sheet: sheets[i] as HTMLImageElement,
        x: 60 + i * 130 + Math.random() * 40,
        y: 24 + Math.random() * 40,
        tx: 0,
        ty: 0,
        dir: 'down',
        pauseUntil: 0,
      }));

      let worldW = 0;
      const stripH = STRIP_TILES_Y * TILE_SIZE;

      const resize = () => {
        const rect = host.getBoundingClientRect();
        canvas.width = Math.ceil(rect.width);
        canvas.height = stripH * SCALE;
        canvas.style.height = `${stripH * SCALE}px`;
        worldW = canvas.width / SCALE;
        for (const w of walkers) {
          w.tx = Math.random() * (worldW - 32) + 16;
          w.ty = Math.random() * (stripH - 40) + 12;
        }
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(host);

      const drawTile = (index: number, tx: number, ty: number) => {
        ctx.drawImage(
          tiles,
          index * TILE_SIZE,
          0,
          TILE_SIZE,
          TILE_SIZE,
          tx * TILE_SIZE * SCALE,
          ty * TILE_SIZE * SCALE,
          TILE_SIZE * SCALE,
          TILE_SIZE * SCALE,
        );
      };

      // A desk pod and plants, so it reads as a room rather than a texture.
      const furniture = () => {
        const cols = Math.ceil(worldW / TILE_SIZE);
        for (let ty = 0; ty < STRIP_TILES_Y; ty++) {
          for (let tx = 0; tx < cols; tx++) {
            drawTile((tx + ty) % 2 === 0 ? TILE.floorA : TILE.floorB, tx, ty);
          }
        }
        for (let tx = 2; tx < cols - 2; tx += 9) {
          drawTile(TILE.deskL, tx, 1);
          drawTile(TILE.deskR, tx + 1, 1);
          drawTile(TILE.chair, tx, 2);
        }
        for (let tx = 6; tx < cols - 2; tx += 13) drawTile(TILE.plant, tx, 3);
      };

      let last = performance.now();
      let elapsed = 0;

      const frame = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        elapsed += dt;

        ctx.imageSmoothingEnabled = false;
        furniture();

        for (const w of walkers) {
          if (!reducedMotion && now >= w.pauseUntil) {
            const dx = w.tx - w.x;
            const dy = w.ty - w.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 3) {
              w.pauseUntil = now + 1500 + Math.random() * 4000;
              w.tx = Math.random() * (worldW - 32) + 16;
              w.ty = Math.random() * (stripH - 44) + 14;
            } else {
              w.x += (dx / dist) * SPEED * dt;
              w.y += (dy / dist) * SPEED * dt;
              w.dir =
                Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
            }
          }
          const moving = !reducedMotion && now >= w.pauseUntil;
          const walkFrame = moving ? Math.floor(elapsed * WALK_FPS) % 4 : 0;
          ctx.drawImage(
            w.sheet,
            walkFrame * CHAR_W,
            DIR_ROW[w.dir] * CHAR_H,
            CHAR_W,
            CHAR_H,
            Math.round((w.x - CHAR_W / 2) * SCALE),
            Math.round((w.y - CHAR_H) * SCALE),
            CHAR_W * SCALE,
            CHAR_H * SCALE,
          );
          // Presence pip above each head, always on.
          ctx.fillStyle = PRESENCE_COLOR[w.member.presence];
          ctx.fillRect(Math.round((w.x - 2) * SCALE), Math.round((w.y - CHAR_H - 5) * SCALE), 8, 8);
        }

        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      // One bubble at a time, rotating through the cast.
      let bubbleIndex = 0;
      const cycleBubble = () => {
        const w = walkers[bubbleIndex % walkers.length];
        bubbleIndex += 1;
        if (w) {
          setBubble({ member: w.member, x: w.x * SCALE, y: (w.y - CHAR_H - 6) * SCALE });
          bubbleTimer = setTimeout(() => {
            setBubble(null);
            bubbleTimer = setTimeout(cycleBubble, 700);
          }, 3800);
        }
      };
      bubbleTimer = setTimeout(cycleBubble, 1200);

      return () => observer.disconnect();
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (bubbleTimer) clearTimeout(bubbleTimer);
    };
  }, []);

  return (
    <div ref={hostRef} className="relative w-full overflow-hidden border-y-2 border-ink">
      <canvas ref={canvasRef} className="block w-full [image-rendering:pixelated]" />
      {bubble ? (
        <div
          className="pixel-panel absolute z-10 max-w-60 -translate-x-1/2 -translate-y-full px-3 py-2 text-left"
          style={{
            left: Math.min(Math.max(bubble.x, 130), (hostRef.current?.clientWidth ?? 600) - 130),
            top: Math.max(bubble.y, 78),
            borderLeft: `4px solid ${PRESENCE_COLOR[bubble.member.presence]}`,
          }}
        >
          <div className="font-display text-xs uppercase tracking-wide text-parchment">
            {bubble.member.name}{' '}
            <span
              className="font-mono text-xs normal-case"
              style={{ color: PRESENCE_COLOR[bubble.member.presence] }}
            >
              {PRESENCE_LABEL[bubble.member.presence]}
            </span>
          </div>
          <div className="truncate font-mono text-sm text-parchment">{bubble.member.line}</div>
          <div className="font-mono text-xs text-crt">{bubble.member.tokens}</div>
        </div>
      ) : null}
    </div>
  );
}
