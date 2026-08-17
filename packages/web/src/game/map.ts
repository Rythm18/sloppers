import { TILE, TILE_SIZE } from './tiles.gen.js';

/**
 * The default office, authored programmatically: a floor/wall base grid,
 * a furniture grid layered above it, and a walkability grid derived from
 * both. Coordinates are tiles; the world is MAP_W×MAP_H tiles of 16px.
 */

export const MAP_W = 32;
export const MAP_H = 22;
export const WORLD_W = MAP_W * TILE_SIZE;
export const WORLD_H = MAP_H * TILE_SIZE;

const EMPTY = -1;

function grid(fill: number): number[][] {
  return Array.from({ length: MAP_H }, () => Array.from({ length: MAP_W }, () => fill));
}

export interface OfficeMap {
  floor: number[][];
  furniture: number[][];
  blocked: boolean[][];
}

export function buildOffice(): OfficeMap {
  const floor = grid(0);
  const furniture = grid(EMPTY);
  const blocked = Array.from({ length: MAP_H }, () =>
    Array.from({ length: MAP_W }, () => false),
  );

  const setFurniture = (x: number, y: number, tile: number, solid = true) => {
    const row = furniture[y];
    const blockRow = blocked[y];
    if (!row || !blockRow) return;
    row[x] = tile;
    if (solid) blockRow[x] = true;
  };

  // Floorboards, subtly checkered.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const row = floor[y];
      if (row) row[x] = (x + y) % 2 === 0 ? TILE.floorA : TILE.floorB;
    }
  }

  // Walls: a cap row, a face row with windows and a whiteboard, side and
  // bottom caps.
  for (let x = 0; x < MAP_W; x++) {
    setFurniture(x, 0, TILE.wallTop);
    setFurniture(x, 1, TILE.wallFace);
    setFurniture(x, MAP_H - 1, TILE.wallTop);
  }
  for (const x of [4, 5, 10, 11, 20, 21, 26, 27]) setFurniture(x, 1, TILE.window);
  for (const x of [15, 16]) setFurniture(x, 1, TILE.whiteboard);
  for (let y = 0; y < MAP_H; y++) {
    setFurniture(0, y, TILE.wallTop);
    setFurniture(MAP_W - 1, y, TILE.wallTop);
  }

  // Desk pods: two rows of paired desks, a chair tucked under each.
  const deskRows = [5, 9];
  const deskCols = [4, 10, 16, 22];
  for (const y of deskRows) {
    for (const x of deskCols) {
      setFurniture(x, y, TILE.deskL);
      setFurniture(x + 1, y, TILE.deskR);
      setFurniture(x, y + 1, TILE.chair, false);
    }
  }

  // Meeting rug in the south-east corner, plants standing guard.
  const rug = { x0: 24, y0: 14, x1: 30, y1: 19 };
  for (let y = rug.y0; y <= rug.y1; y++) {
    for (let x = rug.x0; x <= rug.x1; x++) {
      let tile: number = TILE.rug;
      if (y === rug.y0) tile = TILE.rugEdgeN;
      else if (y === rug.y1) tile = TILE.rugEdgeS;
      else if (x === rug.x0) tile = TILE.rugEdgeW;
      else if (x === rug.x1) tile = TILE.rugEdgeE;
      setFurniture(x, y, tile, false);
    }
  }
  setFurniture(23, 14, TILE.plant);
  setFurniture(23, 19, TILE.plant);

  // Kitchenette along the west wall.
  setFurniture(2, 13, TILE.shelfTop);
  setFurniture(2, 14, TILE.shelfBottom);
  setFurniture(2, 16, TILE.coffee);
  setFurniture(2, 19, TILE.plant);

  // A few more plants to breathe. Keep tiles 13–19 × 13–16 clear: that's
  // the spawn envelope (SPAWN ± jitter in the server), and furniture there
  // can pin a freshly-spawned avatar against a blocked tile.
  setFurniture(29, 2, TILE.plant);
  setFurniture(1, 2, TILE.plant);
  setFurniture(8, 14, TILE.plant);

  return { floor, furniture, blocked };
}

export function isBlocked(map: OfficeMap, worldX: number, worldY: number): boolean {
  const tx = Math.floor(worldX / TILE_SIZE);
  const ty = Math.floor(worldY / TILE_SIZE);
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return true;
  return map.blocked[ty]?.[tx] ?? true;
}
