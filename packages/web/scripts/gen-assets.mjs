/**
 * Generates every sprite the office uses — characters, tileset, favicon, and
 * the link-preview card — as original pixel art, so the project owns its look
 * outright (no asset packs, no licensing questions). Runs before dev/build;
 * outputs land in public/assets/ plus a generated tile-index module in
 * src/game/.
 *
 * Characters: one hand-authored 16×20 base (4 directions × 4 walk frames),
 * palette-swapped into the twelve avatars declared in @sloppers/protocol.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');
const GEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'game');
mkdirSync(OUT, { recursive: true });
mkdirSync(GEN, { recursive: true });

// ---------------------------------------------------------------- plumbing

function hex(color) {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
    255,
  ];
}

class Sheet {
  constructor(width, height) {
    this.png = new PNG({ width, height });
  }
  set(x, y, rgba) {
    if (x < 0 || y < 0 || x >= this.png.width || y >= this.png.height) return;
    const i = (this.png.width * y + x) * 4;
    this.png.data[i] = rgba[0];
    this.png.data[i + 1] = rgba[1];
    this.png.data[i + 2] = rgba[2];
    this.png.data[i + 3] = rgba[3];
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.png.width || y >= this.png.height) return [0, 0, 0, 0];
    const i = (this.png.width * y + x) * 4;
    return [this.png.data[i], this.png.data[i + 1], this.png.data[i + 2], this.png.data[i + 3]];
  }
  rect(x, y, w, h, rgba) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, rgba);
  }
  /**
   * One source pixel becomes a scale×scale block — nearest-neighbour by
   * construction, which is the only enlargement pixel art tolerates.
   * Fully-transparent source pixels are skipped rather than written, so
   * furniture composites over floor exactly as it does in the game.
   */
  blitScaled(src, sx, sy, w, h, dx, dy, scale) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = src.get(sx + x, sy + y);
        if (px[3] === 0) continue;
        this.rect(dx + x * scale, dy + y * scale, scale, scale, px);
      }
    }
  }
  blitGrid(grid, legend, ox, oy, { mirror = false, scale = 1 } = {}) {
    grid.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[mirror ? row.length - 1 - x : x];
        const color = legend[ch];
        if (!color) continue;
        if (scale === 1) this.set(ox + x, oy + y, color);
        else this.rect(ox + x * scale, oy + y * scale, scale, scale, color);
      }
    });
  }
  write(name) {
    writeFileSync(join(OUT, name), PNG.sync.write(this.png));
  }
}

// ------------------------------------------------------------- characters

const CHAR_W = 16;
const CHAR_H = 20;

// Rows of the sheet: down, left, right, up. Frames: stand, stepA, stand, stepB.
// Legend: O outline · H hair · S skin · E eye · T shirt · D shirt shade ·
//         P pants · B boots · . transparent

const HEAD_DOWN = [
  '...OOOOOOOOOO...',
  '..OHHHHHHHHHHO..',
  '.OHHHHHHHHHHHHO.',
  '.OHHHHHHHHHHHHO.',
  '.OHSSSSSSSSSSHO.',
  '.OSSSSSSSSSSSSO.',
  '.OSSESSSSSSESSO.',
  '.OSSSSSSSSSSSSO.',
  '..OSSSSSSSSSSO..',
  '...OOOOOOOOOO...',
];

const HEAD_UP = [
  '...OOOOOOOOOO...',
  '..OHHHHHHHHHHO..',
  '.OHHHHHHHHHHHHO.',
  '.OHHHHHHHHHHHHO.',
  '.OHHHHHHHHHHHHO.',
  '.OHHHHHHHHHHHHO.',
  '.OHHHHHHHHHHHHO.',
  '.OHHHHHHHHHHHHO.',
  '..OHHHHHHHHHHO..',
  '...OOOOOOOOOO...',
];

const HEAD_SIDE = [
  '...OOOOOOOOOO...',
  '..OHHHHHHHHHHO..',
  '.OHHHHHHHHHHHHO.',
  '.OHHHHHHHHHHHHO.',
  '.OHHHHHSSSSSSSO.',
  '.OHHHSSSSSSSSSO.',
  '.OHHHSSSSSSESSO.',
  '.OHHHSSSSSSSSSO.',
  '..OHHHSSSSSSSO..',
  '...OOOOOOOOOO...',
];

const BODY_FRONT = [
  '...OTTTTTTTTO...',
  '..OTTTTTTTTTTO..',
  '..OSTTTTDTTTSO..',
  '..OSTTTTDTTTSO..',
  '...OTTTTDTTTO...',
];

const BODY_SIDE = [
  '....OTTTTTTO....',
  '...OTTTTTTTTO...',
  '...OTTTTTTTSO...',
  '...OTTTTTTTSO...',
  '....OTTTTTTO....',
];

// Legs occupy rows 15–19.
const LEGS_STAND = [
  '...OPPO..OPPO...',
  '...OPPO..OPPO...',
  '...OPPO..OPPO...',
  '...OBBO..OBBO...',
  '....OO....OO....',
];
const LEGS_STEP_A = [
  '...OPPO..OPPO...',
  '...OPPO..OPPO...',
  '...OBBO..OPPO...',
  '....OO...OBBO...',
  '..........OO....',
];
const LEGS_STEP_B = [
  '...OPPO..OPPO...',
  '...OPPO..OPPO...',
  '...OPPO..OBBO...',
  '...OBBO...OO....',
  '....OO..........',
];
const LEGS_SIDE_STAND = [
  '....OPPPPO......',
  '....OPPPPO......',
  '....OPPPPO......',
  '....OBBBBO......',
  '.....OOOO.......',
];
const LEGS_SIDE_A = [
  '....OPPPPO......',
  '....OPPPPO......',
  '...OPPOOPPO.....',
  '...OBBO.OBBO....',
  '....OO...OO.....',
];
const LEGS_SIDE_B = [
  '....OPPPPO......',
  '....OPPPPO......',
  '...OPPOOPPO.....',
  '....OBBOBBO.....',
  '.....OO.OO......',
];

const INK = hex('#1a1423');
const EYE = hex('#241d31');

/** hair, shirt, shirt shade, pants — each avatar is a palette of the base. */
const CAST = {
  clementine: ['#e8763a', '#f3ebdd', '#d9cdb4', '#4a4458'],
  juniper: ['#3f7d4e', '#e0b04c', '#c4933a', '#37324a'],
  marlow: ['#6b4a33', '#4f7cc7', '#3d63a4', '#3a3145'],
  sable: ['#2c2637', '#8a80a5', '#6f668c', '#241d31'],
  biscuit: ['#e5c56b', '#a2643c', '#87502f', '#43395a'],
  pixel: ['#4fc4cf', '#2b2438', '#211b30', '#4a4458'],
  mochi: ['#e88ea8', '#f3ebdd', '#d9cdb4', '#5a4a6b'],
  rusty: ['#b8432f', '#c7b299', '#a99678', '#3a3145'],
  fern: ['#8a5a2e', '#2e5d43', '#234a34', '#2c2637'],
  ziggy: ['#7d5ba6', '#f0a04b', '#d18538', '#37324a'],
  plum: ['#8e4a68', '#c4b7d9', '#a698bd', '#312a44'],
  comet: ['#ded9e8', '#324a7d', '#273b66', '#241d31'],
};

const SKIN_TONES = {
  clementine: '#f0c8a0',
  juniper: '#8d5a3b',
  marlow: '#c89572',
  sable: '#e8b88f',
  biscuit: '#f0c8a0',
  pixel: '#a66a42',
  mochi: '#f5d5b5',
  rusty: '#e0a878',
  fern: '#75462b',
  ziggy: '#d9a075',
  plum: '#f0c8a0',
  comet: '#c89572',
};

function legendFor(id) {
  const [hair, shirt, shade, pants] = CAST[id];
  return {
    O: INK,
    E: EYE,
    H: hex(hair),
    S: hex(SKIN_TONES[id]),
    T: hex(shirt),
    D: hex(shade),
    P: hex(pants),
    B: INK,
  };
}

function drawFrame(sheet, legend, col, row, head, body, legs, { mirror = false, bob = 0 } = {}) {
  const ox = col * CHAR_W;
  const oy = row * CHAR_H;
  sheet.blitGrid(head, legend, ox, oy + bob, { mirror });
  sheet.blitGrid(body, legend, ox, oy + 10 + bob, { mirror });
  sheet.blitGrid(legs, legend, ox, oy + 15, { mirror });
}

for (const id of Object.keys(CAST)) {
  const sheet = new Sheet(CHAR_W * 4, CHAR_H * 4);
  const legend = legendFor(id);
  const rows = [
    {
      row: 0,
      head: HEAD_DOWN,
      body: BODY_FRONT,
      legs: [LEGS_STAND, LEGS_STEP_A, LEGS_STAND, LEGS_STEP_B],
    },
    {
      row: 1,
      head: HEAD_SIDE,
      body: BODY_SIDE,
      legs: [LEGS_SIDE_STAND, LEGS_SIDE_A, LEGS_SIDE_STAND, LEGS_SIDE_B],
      mirror: true,
    },
    {
      row: 2,
      head: HEAD_SIDE,
      body: BODY_SIDE,
      legs: [LEGS_SIDE_STAND, LEGS_SIDE_A, LEGS_SIDE_STAND, LEGS_SIDE_B],
    },
    {
      row: 3,
      head: HEAD_UP,
      body: BODY_FRONT,
      legs: [LEGS_STAND, LEGS_STEP_A, LEGS_STAND, LEGS_STEP_B],
    },
  ];
  for (const spec of rows) {
    spec.legs.forEach((legGrid, frame) => {
      drawFrame(sheet, legend, frame, spec.row, spec.head, spec.body, legGrid, {
        mirror: spec.mirror ?? false,
        bob: frame % 2 === 1 ? 1 : 0,
      });
    });
  }
  sheet.write(`char-${id}.png`);
}

// ---------------------------------------------------------------- tileset

const T = 16;
const PAL = {
  ink: hex('#1a1423'),
  floor: hex('#8a6547'),
  floorDark: hex('#7a573c'),
  floorSeam: hex('#6b4a33'),
  wallFace: hex('#4a3f5c'),
  wallPanel: hex('#554968'),
  wallTop: hex('#312a44'),
  rug: hex('#39586b'),
  rugDark: hex('#2e4757'),
  rugEdge: hex('#243947'),
  desk: hex('#a0724c'),
  deskEdge: hex('#7a573c'),
  screen: hex('#241d31'),
  screenGlow: hex('#7de0a6'),
  screenDim: hex('#3f7d5c'),
  metal: hex('#8a80a5'),
  leaf: hex('#3f7d4e'),
  leafDark: hex('#2e5d43'),
  pot: hex('#b8432f'),
  potDark: hex('#8e3524'),
  paper: hex('#f3ebdd'),
  amber: hex('#ffb454'),
  night: hex('#241d31'),
  star: hex('#c4b7d9'),
  shelf: hex('#6b4a33'),
  book1: hex('#b8432f'),
  book2: hex('#39586b'),
  book3: hex('#e0b04c'),
};

const TILE_NAMES = [
  'floorA',
  'floorB',
  'wallTop',
  'wallFace',
  'window',
  'rug',
  'rugEdgeN',
  'rugEdgeS',
  'rugEdgeW',
  'rugEdgeE',
  'deskL',
  'deskR',
  'chair',
  'plant',
  'shelfTop',
  'shelfBottom',
  'coffee',
  'whiteboard',
];

const tiles = new Sheet(T * TILE_NAMES.length, T);
const tileDrawers = {
  floorA(s, ox) {
    s.rect(ox, 0, T, T, PAL.floor);
    for (let y = 0; y < T; y++) s.set(ox + 7, y, PAL.floorSeam);
    s.rect(ox, 5, 7, 1, PAL.floorDark);
    s.rect(ox + 8, 12, 8, 1, PAL.floorDark);
    s.set(ox + 3, 9, PAL.floorDark);
    s.set(ox + 12, 3, PAL.floorDark);
  },
  floorB(s, ox) {
    s.rect(ox, 0, T, T, PAL.floor);
    for (let y = 0; y < T; y++) s.set(ox + 11, y, PAL.floorSeam);
    s.rect(ox, 10, 11, 1, PAL.floorDark);
    s.rect(ox + 12, 4, 4, 1, PAL.floorDark);
    s.set(ox + 5, 2, PAL.floorDark);
    s.set(ox + 14, 13, PAL.floorDark);
  },
  wallTop(s, ox) {
    s.rect(ox, 0, T, T, PAL.wallTop);
    s.rect(ox, T - 2, T, 2, PAL.ink);
  },
  wallFace(s, ox) {
    s.rect(ox, 0, T, T, PAL.wallFace);
    s.rect(ox, 0, T, 1, PAL.wallPanel);
    s.rect(ox, 10, T, 1, PAL.wallPanel);
    s.rect(ox, 11, T, 5, PAL.wallTop);
  },
  window(s, ox) {
    tileDrawers.wallFace(s, ox);
    s.rect(ox + 2, 2, 12, 8, PAL.ink);
    s.rect(ox + 3, 3, 10, 6, PAL.night);
    s.set(ox + 5, 4, PAL.star);
    s.set(ox + 10, 5, PAL.star);
    s.set(ox + 7, 7, PAL.star);
    s.set(ox + 12, 3, PAL.amber);
  },
  rug(s, ox) {
    s.rect(ox, 0, T, T, PAL.rug);
    for (let y = 0; y < T; y += 4)
      for (let x = (y / 4) % 2 === 0 ? 0 : 2; x < T; x += 4) s.set(ox + x, y, PAL.rugDark);
  },
  rugEdgeN(s, ox) {
    tileDrawers.rug(s, ox);
    s.rect(ox, 0, T, 2, PAL.rugEdge);
  },
  rugEdgeS(s, ox) {
    tileDrawers.rug(s, ox);
    s.rect(ox, T - 2, T, 2, PAL.rugEdge);
  },
  rugEdgeW(s, ox) {
    tileDrawers.rug(s, ox);
    s.rect(ox, 0, 2, T, PAL.rugEdge);
  },
  rugEdgeE(s, ox) {
    tileDrawers.rug(s, ox);
    s.rect(ox + T - 2, 0, 2, T, PAL.rugEdge);
  },
  deskL(s, ox) {
    // Monitor on a desk slab; slab continues into deskR.
    s.rect(ox + 1, 9, 15, 5, PAL.desk);
    s.rect(ox + 1, 13, 15, 1, PAL.deskEdge);
    s.rect(ox + 1, 9, 15, 1, hex('#b8875e'));
    s.rect(ox + 4, 1, 9, 7, PAL.ink);
    s.rect(ox + 5, 2, 7, 5, PAL.screen);
    s.rect(ox + 6, 3, 4, 1, PAL.screenGlow);
    s.rect(ox + 6, 5, 5, 1, PAL.screenDim);
    s.rect(ox + 7, 8, 3, 1, PAL.metal);
  },
  deskR(s, ox) {
    s.rect(ox, 9, 15, 5, PAL.desk);
    s.rect(ox, 13, 15, 1, PAL.deskEdge);
    s.rect(ox, 9, 15, 1, hex('#b8875e'));
    s.rect(ox + 3, 10, 6, 2, PAL.ink); // keyboard
    s.rect(ox + 11, 10, 2, 2, PAL.paper); // notepad
  },
  chair(s, ox) {
    s.rect(ox + 4, 6, 8, 6, PAL.ink);
    s.rect(ox + 5, 7, 6, 4, hex('#5a4a6b'));
    s.rect(ox + 5, 12, 2, 2, PAL.ink);
    s.rect(ox + 9, 12, 2, 2, PAL.ink);
  },
  plant(s, ox) {
    s.rect(ox + 5, 10, 6, 4, PAL.pot);
    s.rect(ox + 5, 13, 6, 1, PAL.potDark);
    s.rect(ox + 6, 3, 4, 7, PAL.leaf);
    s.rect(ox + 3, 5, 4, 4, PAL.leafDark);
    s.rect(ox + 9, 4, 4, 4, PAL.leafDark);
    s.set(ox + 7, 2, PAL.leaf);
    s.set(ox + 10, 3, PAL.leaf);
  },
  shelfTop(s, ox) {
    s.rect(ox + 1, 0, 14, 16, PAL.shelf);
    s.rect(ox + 2, 2, 12, 5, PAL.ink);
    s.rect(ox + 3, 2, 2, 5, PAL.book1);
    s.rect(ox + 6, 3, 2, 4, PAL.book2);
    s.rect(ox + 9, 2, 2, 5, PAL.book3);
    s.rect(ox + 2, 9, 12, 5, PAL.ink);
    s.rect(ox + 4, 10, 2, 4, PAL.book2);
    s.rect(ox + 7, 9, 2, 5, PAL.book1);
  },
  shelfBottom(s, ox) {
    s.rect(ox + 1, 0, 14, 14, PAL.shelf);
    s.rect(ox + 2, 1, 12, 5, PAL.ink);
    s.rect(ox + 3, 2, 2, 4, PAL.book3);
    s.rect(ox + 8, 1, 2, 5, PAL.book2);
    s.rect(ox + 1, 13, 14, 1, PAL.ink);
  },
  coffee(s, ox) {
    s.rect(ox + 2, 9, 12, 5, PAL.metal);
    s.rect(ox + 2, 13, 12, 1, hex('#6f668c'));
    s.rect(ox + 4, 2, 8, 7, PAL.ink);
    s.rect(ox + 5, 3, 6, 3, hex('#5a4a6b'));
    s.rect(ox + 7, 7, 2, 2, PAL.paper);
    s.set(ox + 7, 1, PAL.metal);
    s.set(ox + 9, 0, PAL.metal);
  },
  whiteboard(s, ox) {
    tileDrawers.wallFace(s, ox);
    s.rect(ox + 1, 1, 14, 9, PAL.ink);
    s.rect(ox + 2, 2, 12, 7, PAL.paper);
    s.rect(ox + 3, 3, 6, 1, PAL.rug);
    s.rect(ox + 3, 5, 8, 1, PAL.pot);
    s.rect(ox + 3, 7, 4, 1, PAL.rug);
  },
};

TILE_NAMES.forEach((name, i) => {
  tileDrawers[name](tiles, i * T);
});
tiles.write('tiles.png');

const tileIndex = Object.fromEntries(TILE_NAMES.map((name, i) => [name, i]));
writeFileSync(
  join(GEN, 'tiles.gen.ts'),
  `// Generated by scripts/gen-assets.mjs — do not edit.\nexport const TILE = ${JSON.stringify(tileIndex, null, 2)} as const;\nexport const TILE_SIZE = ${T};\n`,
);

// ---------------------------------------------------------------- favicon

const icon = new Sheet(16, 16);
icon.rect(0, 0, 16, 16, hex('#1a1423'));
icon.rect(2, 3, 12, 9, hex('#241d31'));
icon.rect(3, 4, 10, 7, hex('#2b2438'));
icon.rect(4, 5, 6, 1, PAL.screenGlow);
icon.rect(4, 7, 8, 1, PAL.screenDim);
icon.rect(4, 9, 4, 1, PAL.amber);
icon.rect(6, 12, 4, 1, hex('#8a80a5'));
icon.rect(5, 13, 6, 1, hex('#8a80a5'));
icon.write('favicon.png');

// ------------------------------------------------------------- unfurl card

/**
 * The picture a sloppers link shows when somebody drops it into Slack or
 * iMessage. The product is a place you look at, and for a long time the link
 * to it unfurled as one word of text.
 *
 * So: not a banner, and not a screenshot either — the office itself, drawn
 * from the same tiles and the same characters the game loads, at the same
 * zoom a laptop gets (`applyZoom` in game/scene.ts settles on 3 for anything
 * up to about 1500px wide). Every pixel here is one the office would draw.
 *
 * The arrangement below mirrors `buildOffice()` in src/game/map.ts, which is
 * where the office is really defined. Nothing enforces that — a script cannot
 * import a TypeScript module — so if the office is ever rearranged, rearrange
 * it here too and re-run `pnpm --filter @sloppers/web gen`.
 */
const OG_W = 1200;
const OG_H = 630;
/**
 * Four, where the office itself would pick three on a laptop. An unfurl is
 * shown at a third of its size in a chat window, so the pixels have to be
 * chunky enough to survive that — at 3× the people come out about fifteen
 * pixels tall in Slack, which is a smudge.
 */
const OG_SCALE = 4;
/**
 * The leftmost column in frame. Chosen so neither edge cuts a desk in half:
 * the pod at columns 4–5 falls entirely outside, the one at 22–23 entirely
 * inside, and 18.75 columns fit across at this scale.
 */
const OG_X0 = 6;
const MAP_W = 32;
const MAP_H = 22;

const card = new Sheet(OG_W, OG_H);
card.rect(0, 0, OG_W, OG_H, PAL.ink);

/** Tile index → its column in the tileset sheet. */
const TILE = Object.fromEntries(TILE_NAMES.map((name, i) => [name, i]));

const cardFloor = Array.from({ length: MAP_H }, () => Array.from({ length: MAP_W }, () => 0));
const cardStuff = Array.from({ length: MAP_H }, () => Array.from({ length: MAP_W }, () => -1));
const place = (x, y, tile) => {
  if (cardStuff[y]) cardStuff[y][x] = tile;
};

for (let y = 0; y < MAP_H; y++) {
  for (let x = 0; x < MAP_W; x++) {
    cardFloor[y][x] = (x + y) % 2 === 0 ? TILE.floorA : TILE.floorB;
  }
}
for (let x = 0; x < MAP_W; x++) {
  place(x, 0, TILE.wallTop);
  place(x, 1, TILE.wallFace);
  place(x, MAP_H - 1, TILE.wallTop);
}
for (const x of [4, 5, 10, 11, 20, 21, 26, 27]) place(x, 1, TILE.window);
for (const x of [15, 16]) place(x, 1, TILE.whiteboard);
for (let y = 0; y < MAP_H; y++) {
  place(0, y, TILE.wallTop);
  place(MAP_W - 1, y, TILE.wallTop);
}
for (const y of [5, 9]) {
  for (const x of [4, 10, 16, 22]) {
    place(x, y, TILE.deskL);
    place(x + 1, y, TILE.deskR);
    place(x, y + 1, TILE.chair);
  }
}
place(29, 2, TILE.plant);
place(1, 2, TILE.plant);
place(8, 14, TILE.plant);

/** World pixel → card pixel. The crop starts at column OG_X0, row 0. */
const cardX = (worldX) => (worldX - OG_X0 * T) * OG_SCALE;
const cardY = (worldY) => worldY * OG_SCALE;

const drawTile = (index, tx, ty) => {
  card.blitScaled(tiles, index * T, 0, T, T, cardX(tx * T), cardY(ty * T), OG_SCALE);
};
for (let y = 0; y < MAP_H; y++) {
  for (let x = 0; x < MAP_W; x++) {
    drawTile(cardFloor[y][x], x, y);
    if (cardStuff[y][x] >= 0) drawTile(cardStuff[y][x], x, y);
  }
}

/** The four rows of the character sheet, as the pieces they are drawn from. */
const POSE = {
  down: { head: HEAD_DOWN, body: BODY_FRONT, legs: LEGS_STAND, step: LEGS_STEP_A, mirror: false },
  left: {
    head: HEAD_SIDE,
    body: BODY_SIDE,
    legs: LEGS_SIDE_STAND,
    step: LEGS_SIDE_A,
    mirror: true,
  },
  right: {
    head: HEAD_SIDE,
    body: BODY_SIDE,
    legs: LEGS_SIDE_STAND,
    step: LEGS_SIDE_A,
    mirror: false,
  },
  up: { head: HEAD_UP, body: BODY_FRONT, legs: LEGS_STAND, step: LEGS_STEP_A, mirror: false },
};

/**
 * One person standing on a tile, placed the way the scene places them: the
 * sprite's origin is (0.5, 0.85) of a 16×20 frame, which puts its top nine
 * pixels above the tile it is standing on — so somebody at a chair overlaps
 * the desk in front of them, exactly as in the office.
 */
function drawPerson(avatar, dir, tx, ty, { walking = false } = {}) {
  const pose = POSE[dir];
  const legend = legendFor(avatar);
  const opts = { mirror: pose.mirror, scale: OG_SCALE };
  const ox = cardX(tx * T);
  // Mid-step frames bob a pixel, and only the top half of the body does.
  const bob = walking ? 1 : 0;
  const oy = cardY(ty * T - 9);
  card.blitGrid(pose.head, legend, ox, oy + bob * OG_SCALE, opts);
  card.blitGrid(pose.body, legend, ox, oy + (10 + bob) * OG_SCALE, opts);
  card.blitGrid(walking ? pose.step : pose.legs, legend, ox, oy + 15 * OG_SCALE, opts);
}

// An office with people in it. Backs to the camera at the desks, because that
// is what working looks like from behind — a tile below the chair rather than
// on it, so the monitor they are working at stays in the picture. The rest
// are crossing the floor, which is what stops it reading as a diagram.
drawPerson('clementine', 'up', 10, 7);
drawPerson('juniper', 'up', 16, 7);
drawPerson('mochi', 'up', 22, 7);
drawPerson('pixel', 'right', 13, 8, { walking: true });
drawPerson('ziggy', 'down', 19, 3);
drawPerson('comet', 'left', 8, 4, { walking: true });
drawPerson('rusty', 'down', 8, 9);

card.write('og-office.png');

console.log(
  `assets: ${Object.keys(CAST).length} characters, ${TILE_NAMES.length} tiles, ` +
    `1 unfurl card → public/assets/`,
);
