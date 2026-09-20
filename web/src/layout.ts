// Geometry from the v3 handoff ("Terrain"): y is strictly the release
// year; the trunk runs straight down from the anchor and branches step
// sideways by `spread`; clashes are resolved with a horizontal relaxation
// only. Cards come in three tiers that shrink with distance from the
// anchor. Values per device are the handoff's table.
//
// Placement is incremental: a film's position is computed once, the first
// time it is seen, relaxed against the cards already placed, and cached.
// Later films never move earlier ones; only the whole-canvas shift (so the
// leftmost card sits at the padding) can change, and the canvas
// compensates by scrolling.

import type { MapFilm, MapTree } from './tree';

export type Device = 'phone' | 'tablet' | 'desktop';
export type Tier = 'anchor' | 'trunk' | 'branch';

export interface Geometry {
  anchor: [number, number]; // card w × h
  trunk: [number, number];
  branch: [number, number];
  ppy: number; // pixels per year
  spread: number; // sideways step per branch level
  pad: number; // canvas padding
  stem: number;
}

export const GEOMETRY: Record<Device, Geometry> = {
  desktop: { anchor: [340, 220], trunk: [260, 180], branch: [180, 120], ppy: 54, spread: 420, pad: 190, stem: 34 },
  tablet: { anchor: [272, 176], trunk: [208, 144], branch: [144, 96], ppy: 46, spread: 330, pad: 150, stem: 28 },
  phone: { anchor: [200, 130], trunk: [156, 108], branch: [110, 74], ppy: 38, spread: 230, pad: 100, stem: 22 },
};

/** Matches `--header-h` in styles.css. The canvas starts at page y = 0 and
 *  the header overlays it, so year-zero must sit far enough down that a
 *  card hanging above its pin is not clipped. */
export const HEADER_H = 64;
/** Air between the header and a card sitting on the earliest year. */
const TOP_GAP = 32;

/** Vertical origin of minYear. Cards hang above their pin by stem + h, so
 *  this has to clear the fixed header even for the tallest (anchor) card. */
export function topOf(g: Geometry): number {
  return HEADER_H + TOP_GAP + g.stem + g.anchor[1];
}

export const TOP = topOf(GEOMETRY.desktop);
const GAP_X = 46;
const GAP_Y = 26;

export function deviceFor(viewportWidth: number): Device {
  if (viewportWidth < 640) return 'phone';
  if (viewportWidth < 1100) return 'tablet';
  return 'desktop';
}

/** Type scale relative to the desktop anchor card. */
export function typeScale(g: Geometry): number {
  return g.anchor[0] / 340;
}

export function tierOf(f: MapFilm): Tier {
  return f.anchor ? 'anchor' : f.trunk ? 'trunk' : 'branch';
}

export interface PlacedFilm extends MapFilm {
  x: number;
  y: number;
  w: number;
  h: number;
  tier: Tier;
}

export type EdgeKind = 'trunk' | 'branch';

export interface Edge {
  id: string;
  kind: EdgeKind;
  from: PlacedFilm;
  to: PlacedFilm;
  d: string;
  /** The actor the edge stands for and their billing in `to` (1-based). */
  actor: string;
  role: string;
  billing: number;
}

export interface Layout {
  geometry: Geometry;
  placed: PlacedFilm[];
  byId: Map<string, PlacedFilm>;
  edges: Edge[];
  canvasW: number;
  canvasH: number;
  minYear: number;
  maxYear: number;
  /** Horizontal offset applied to every node so the leftmost sits at pad. */
  shift: number;
  yOf: (year: number) => number;
}

/** Positions already decided, in unshifted coordinates. One per anchor and
 *  geometry; throw it away when either changes. */
export class LayoutCache {
  readonly positions = new Map<string, Box>();
  minYear = Infinity;
  constructor(readonly geometry: Geometry) {}
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Occupancy index so relaxation only compares against nearby cards. */
class Occupancy {
  private readonly rows = new Map<number, Box[]>();
  constructor(private readonly rowH: number) {}
  add(b: Box): void {
    const r = Math.floor(b.y / this.rowH);
    const row = this.rows.get(r);
    if (row) row.push(b);
    else this.rows.set(r, [b]);
  }
  /** Cards whose boxes overlap b vertically. */
  near(b: Box, stem: number): Box[] {
    const r = Math.floor(b.y / this.rowH);
    const out: Box[] = [];
    const bTop = b.y - stem - b.h;
    for (let i = r - 2; i <= r + 2; i++) {
      for (const a of this.rows.get(i) ?? []) {
        const aTop = a.y - stem - a.h;
        if (aTop > b.y + GAP_Y || bTop > a.y + GAP_Y) continue;
        out.push(a);
      }
    }
    return out;
  }
}

export function layoutTree(tree: MapTree, cache: LayoutCache): Layout {
  const g = cache.geometry;
  const films = [...tree.films.values()];
  const minYear = Math.min(...films.map((f) => f.year));
  const maxYear = Math.max(...films.map((f) => f.year));
  // Years are measured from the earliest film ever placed so cached
  // positions stay valid when an older film arrives later.
  if (minYear < cache.minYear) {
    if (cache.positions.size > 0) {
      const dy = (cache.minYear - minYear) * g.ppy;
      for (const p of cache.positions.values()) p.y += dy;
    }
    cache.minYear = minYear;
  }
  const origin = topOf(g);
  const yOf = (year: number) => origin + (year - cache.minYear) * g.ppy;

  const occupancy = new Occupancy(g.trunk[1] + g.stem);
  for (const p of cache.positions.values()) occupancy.add(p);

  // Insertion order is placement order: a film's parent always precedes it.
  for (const f of films) {
    if (cache.positions.has(f.id)) continue;
    const [w, h] = g[tierOf(f)];
    const parent = f.parent ? cache.positions.get(f.parent) : undefined;
    // The trunk runs straight down from the anchor at x = 0; a branch steps
    // sideways from its parent.
    const tx = parent ? parent.x + f.side * g.spread : 0;
    const box: Box = { x: tx, y: yOf(f.year), w, h };
    if (!f.anchor) box.x = settle(box, tx, occupancy.near(box, g.stem), f.side);
    cache.positions.set(f.id, box);
    occupancy.add(box);
  }

  let minX = Infinity;
  let maxX = -Infinity;
  for (const f of films) {
    const p = cache.positions.get(f.id)!;
    if (p.x - p.w / 2 < minX) minX = p.x - p.w / 2;
    if (p.x + p.w / 2 > maxX) maxX = p.x + p.w / 2;
  }
  const shift = g.pad - minX;
  const placed: PlacedFilm[] = [];
  const byId = new Map<string, PlacedFilm>();
  for (const f of films) {
    const p = cache.positions.get(f.id)!;
    const node: PlacedFilm = { ...f, x: p.x + shift, y: p.y, w: p.w, h: p.h, tier: tierOf(f) };
    placed.push(node);
    byId.set(f.id, node);
  }
  const canvasW = Math.round(maxX - minX + g.pad * 2);
  const canvasH = Math.round(yOf(maxYear) + 260);

  const edges: Edge[] = [];
  const trunk = placed.filter((p) => p.trunk).sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 1; i < trunk.length; i++) {
    const a = trunk[i - 1];
    const b = trunk[i];
    // The lead's role in whichever end is not the anchor.
    const stop = b.anchor ? a : b;
    edges.push({
      id: `t-${a.id}-${b.id}`, kind: 'trunk', from: a, to: b, d: curve(a, b),
      actor: stop.relation, role: stop.role, billing: stop.billing,
    });
  }
  for (const p of placed) {
    if (!p.parent) continue;
    const a = byId.get(p.parent)!;
    edges.push({ id: `b-${a.id}-${p.id}`, kind: 'branch', from: a, to: p, d: curve(a, p), actor: p.relation, role: p.role, billing: p.billing });
  }

  return { geometry: g, placed, byId, edges, canvasW, canvasH, minYear: cache.minYear, maxYear, shift, yOf };
}

/** The handoff relaxes all cards together; here earlier cards are fixed,
 *  so the new card's x is solved exactly: the nearest point to its target
 *  that is clear of every neighbour it overlaps vertically. Each neighbour
 *  forbids an interval of x; the intervals are merged and the target is
 *  moved to the closest free edge, outward (away from the parent) on a tie. */
function settle(box: Box, tx: number, neighbours: Box[], side: 1 | -1): number {
  if (neighbours.length === 0) return tx;
  const forbidden = neighbours
    .map((a) => {
      const need = (a.w + box.w) / 2 + GAP_X;
      return [a.x - need, a.x + need] as [number, number];
    })
    .sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const iv of forbidden) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  for (const [lo, hi] of merged) {
    if (tx <= lo || tx >= hi) continue;
    const toLo = tx - lo;
    const toHi = hi - tx;
    if (toLo === toHi) return side < 0 ? lo : hi;
    return toLo < toHi ? lo : hi;
  }
  return tx;
}

/** Rounded orthogonal path between two pins: travel in year first, step
 *  sideways in the gap between years, then drop onto the film. Same column
 *  or same year is a straight line. Avoids the S-curve of a vertical-tangent
 *  cubic, which folds back on itself when two films are close in year. */
export function curve(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const x1 = a.x.toFixed(1);
  const y1 = a.y.toFixed(1);
  const x2 = b.x.toFixed(1);
  const y2 = b.y.toFixed(1);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 0.5 || Math.abs(dy) < 0.5) {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }
  const my = (a.y + b.y) / 2;
  const r = Math.min(36, Math.abs(dx) / 2, Math.abs(dy) / 2);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  return [
    `M ${x1} ${y1}`,
    `L ${x1} ${(my - r * sy).toFixed(1)}`,
    `Q ${x1} ${my.toFixed(1)}, ${(a.x + r * sx).toFixed(1)} ${my.toFixed(1)}`,
    `L ${(b.x - r * sx).toFixed(1)} ${my.toFixed(1)}`,
    `Q ${x2} ${my.toFixed(1)}, ${x2} ${(my + r * sy).toFixed(1)}`,
    `L ${x2} ${y2}`,
  ].join(' ');
}

/** Edge hue by the decade of a film's year: edges fade from the source
 *  decade's colour to the target's. Colours are kept bright enough to
 *  read on the dark canvas; decades without a hue fall back to steel. */
export function decadeColour(year: number): string {
  const decade = Math.floor(year / 10) * 10;
  return DECADE_COLOURS[decade] ?? '#B8C0CC';
}

const DECADE_COLOURS: Record<number, string> = {
  1920: '#C9A36A',
  1930: '#D4B45A',
  1940: '#E0C070',
  1950: '#E8B84A',
  1960: '#4DB8C9',
  1970: '#C4A06A',
  1980: '#E09A5A',
  1990: '#7FA8C9',
  2000: '#8FB88A',
  2010: '#C97F9E',
  2020: '#A090F0',
};

/** The reader's window in canvas coordinates (scroll and size divided by
 *  zoom, so the same numbers work at any scale). */
export interface Viewport {
  sx: number;
  sy: number;
  vw: number;
  vh: number;
}

/** Films whose card box comes within `screens` screens of the lit screen,
 *  vertically and horizontally. */
export function filmsWithin(layout: Layout, v: Viewport, screens: number): PlacedFilm[] {
  const { stem } = layout.geometry;
  const x0 = v.sx - v.vw * screens;
  const x1 = v.sx + v.vw * (1 + screens);
  const y0 = v.sy - v.vh * screens;
  const y1 = v.sy + v.vh * (1 + screens);
  return layout.placed.filter((p) => {
    const top = p.y - stem - p.h;
    return p.y > y0 && top < y1 && p.x + p.w / 2 > x0 && p.x - p.w / 2 < x1;
  });
}

/** Edges whose bounding box (the orthogonal path between pins) meets the
 *  lit screen plus `screens`. Long trunk runs that cross the view without
 *  either pin on screen still count. */
export function edgesWithin(layout: Layout, v: Viewport, screens: number): Edge[] {
  const x0 = v.sx - v.vw * screens;
  const x1 = v.sx + v.vw * (1 + screens);
  const y0 = v.sy - v.vh * screens;
  const y1 = v.sy + v.vh * (1 + screens);
  return layout.edges.filter((e) => {
    const minX = Math.min(e.from.x, e.to.x);
    const maxX = Math.max(e.from.x, e.to.x);
    const minY = Math.min(e.from.y, e.to.y);
    const maxY = Math.max(e.from.y, e.to.y);
    return maxX >= x0 && minX <= x1 && maxY >= y0 && minY <= y1;
  });
}

/** Distance from a pin to the centre of the lit screen, for prefetch order. */
export function distanceToCentre(p: { x: number; y: number }, v: Viewport): number {
  const cx = v.sx + v.vw / 2;
  const cy = v.sy + v.vh / 2;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Page scroll that puts the film's card in the visual centre of the
 *  window (below the fixed header). */
export function scrollPosForFilm(
  film: { x: number; y: number; h: number },
  stem: number,
  zoom: number,
  vw: number,
  vh: number,
): { left: number; top: number } {
  return {
    left: film.x * zoom - vw / 2,
    top: (film.y - stem - film.h / 2) * zoom - (vh + HEADER_H) / 2,
  };
}
