/**
 * Procedural placeholder floor plans. They follow the conventions on slide 2
 * (black walls, white interior, gray exterior, entrance facing down) so the demo
 * behaves like the real image set, but they are not RPLAN data.
 */
import { Rng, mulberry32 } from "../../shared/allocator";
import { encodeGrayPng } from "./png";

const SIZE = 256;
const CELL = 8;
const GRID = 28;
const OFFSET = 16;
const WALL = 4;
const GRAY = 205;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function int(rng: Rng, low: number, high: number): number {
  return low + Math.floor(rng() * (high - low + 1));
}

function buildFootprint(rng: Rng): Rect[] {
  const main: Rect = { x: int(rng, 3, 8), y: int(rng, 4, 8), w: int(rng, 11, 18), h: int(rng, 10, 15) };
  main.w = Math.min(main.w, GRID - main.x - 2);
  main.h = Math.min(main.h, GRID - main.y - 2);
  const rects = [main];
  const extras = int(rng, 0, 3);
  for (let i = 0; i < extras; i++) {
    const w = int(rng, 4, 9);
    const h = int(rng, 4, 8);
    const side = int(rng, 0, 3);
    const r: Rect = { x: main.x, y: main.y, w, h };
    if (side === 0) {
      r.x = main.x + int(rng, 0, Math.max(0, main.w - w));
      r.y = main.y - h + 1;
    } else if (side === 1) {
      r.x = main.x + main.w - 1;
      r.y = main.y + int(rng, 0, Math.max(0, main.h - h));
    } else if (side === 2) {
      r.x = main.x + int(rng, 0, Math.max(0, main.w - w));
      r.y = main.y + main.h - 1;
    } else {
      r.x = main.x - w + 1;
      r.y = main.y + int(rng, 0, Math.max(0, main.h - h));
    }
    r.x = Math.max(1, r.x);
    r.y = Math.max(1, r.y);
    r.w = Math.min(r.w, GRID - r.x - 1);
    r.h = Math.min(r.h, GRID - r.y - 1);
    rects.push(r);
  }
  return rects;
}

function split(rect: Rect, depth: number, rng: Rng, out: Rect[]): void {
  const tooSmall = rect.w < 8 && rect.h < 8;
  if (depth <= 0 || tooSmall || (depth < 2 && rng() < 0.3)) {
    out.push(rect);
    return;
  }
  const vertical = rect.w === rect.h ? rng() < 0.5 : rect.w > rect.h;
  if (vertical && rect.w >= 8) {
    const cut = int(rng, 4, rect.w - 4);
    split({ ...rect, w: cut }, depth - 1, rng, out);
    split({ ...rect, x: rect.x + cut, w: rect.w - cut }, depth - 1, rng, out);
  } else if (!vertical && rect.h >= 8) {
    const cut = int(rng, 4, rect.h - 4);
    split({ ...rect, h: cut }, depth - 1, rng, out);
    split({ ...rect, y: rect.y + cut, h: rect.h - cut }, depth - 1, rng, out);
  } else {
    out.push(rect);
  }
}

export function renderPlan(seed: number): Uint8Array {
  const rng = mulberry32(seed * 2654435761);
  const footprint = buildFootprint(rng);
  const inside = new Uint8Array(GRID * GRID);
  for (const r of footprint) {
    for (let y = r.y; y < r.y + r.h && y < GRID; y++) for (let x = r.x; x < r.x + r.w && x < GRID; x++) inside[y * GRID + x] = 1;
  }
  const leaves: Rect[] = [];
  split({ x: 0, y: 0, w: GRID, h: GRID }, 4, rng, leaves);
  const room = new Int16Array(GRID * GRID).fill(-1);
  leaves.forEach((leaf, id) => {
    for (let y = leaf.y; y < leaf.y + leaf.h; y++) {
      for (let x = leaf.x; x < leaf.x + leaf.w; x++) if (inside[y * GRID + x]) room[y * GRID + x] = id;
    }
  });

  const pixels = new Uint8Array(SIZE * SIZE).fill(GRAY);
  const fill = (x0: number, y0: number, w: number, h: number, value: number) => {
    for (let y = Math.max(0, y0); y < Math.min(SIZE, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(SIZE, x0 + w); x++) pixels[y * SIZE + x] = value;
    }
  };
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= GRID || y >= GRID ? -1 : room[y * GRID + x]);

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) if (at(x, y) >= 0) fill(OFFSET + x * CELL, OFFSET + y * CELL, CELL, CELL, 255);
  }

  type Edge = { x: number; y: number; horizontal: boolean; a: number; b: number };
  const edges: Edge[] = [];
  for (let y = 0; y <= GRID; y++) {
    for (let x = 0; x <= GRID; x++) {
      if (x < GRID && at(x, y - 1) !== at(x, y)) edges.push({ x, y, horizontal: true, a: at(x, y - 1), b: at(x, y) });
      if (y < GRID && at(x - 1, y) !== at(x, y)) edges.push({ x, y, horizontal: false, a: at(x - 1, y), b: at(x, y) });
    }
  }
  for (const e of edges) {
    const px = OFFSET + e.x * CELL - Math.floor(WALL / 2);
    const py = OFFSET + e.y * CELL - Math.floor(WALL / 2);
    if (e.horizontal) fill(px, py, CELL + WALL, WALL, 0);
    else fill(px, py, WALL, CELL + WALL, 0);
  }

  // Doors: connect the rooms with a spanning tree of openings.
  const interior = edges.filter((e) => e.a >= 0 && e.b >= 0);
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    if (!parent.has(v)) parent.set(v, v);
    const p = parent.get(v)!;
    if (p === v) return v;
    const root = find(p);
    parent.set(v, root);
    return root;
  };
  const shuffled = interior.map((e) => ({ e, k: rng() })).sort((p, q) => p.k - q.k).map((p) => p.e);
  for (const e of shuffled) {
    if (find(e.a) === find(e.b)) continue;
    parent.set(find(e.a), find(e.b));
    const px = OFFSET + e.x * CELL;
    const py = OFFSET + e.y * CELL;
    if (e.horizontal) fill(px, py - WALL, CELL, WALL * 2, 255);
    else fill(px - WALL, py, WALL * 2, CELL, 255);
  }

  // Entrance: an opening in the lowest exterior wall.
  const exteriorBottom = edges.filter((e) => e.horizontal && e.a >= 0 && e.b < 0);
  if (exteriorBottom.length) {
    const lowest = Math.max(...exteriorBottom.map((e) => e.y));
    const options = exteriorBottom.filter((e) => e.y === lowest);
    const door = options[Math.floor(rng() * options.length)];
    fill(OFFSET + door.x * CELL, OFFSET + door.y * CELL - WALL, CELL, WALL * 2, 255);
  }
  return pixels;
}

export function planPng(seed: number): Buffer {
  return encodeGrayPng(SIZE, SIZE, renderPlan(seed));
}
