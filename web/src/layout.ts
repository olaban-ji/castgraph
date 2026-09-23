// Geometry from the v3 handoff ("Terrain"): y is strictly the release
// year; the searched film sits at x = 0 and every blow-out steps sideways
// from its seed by `spread`. Clashes are resolved with a horizontal
// relaxation only. Cards come in three tiers that shrink with hop
// distance from the search. Values per device are the handoff's table.
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

// Branch cards are taller than the handoff's 120 to pay for a title bar
// that is always on rather than revealed on hover.
export const GEOMETRY: Record<Device, Geometry> = {
  desktop: { anchor: [340, 220], trunk: [260, 180], branch: [180, 132], ppy: 54, spread: 420, pad: 190, stem: 34 },
  tablet: { anchor: [272, 176], trunk: [208, 144], branch: [144, 106], ppy: 46, spread: 330, pad: 150, stem: 28 },
  phone: { anchor: [200, 130], trunk: [156, 108], branch: [110, 82], ppy: 38, spread: 230, pad: 100, stem: 22 },
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
/** Centre-to-centre gap between sideways runs that share a stretch of column.
 *  Wider than the painted stroke plus its halo so two routes stay distinct. */
export const LANE_GAP = 18;

/** Floor on any lane separation. Two parallel runs closer than this read
 *  as one thick line rather than two routes. */
export const MIN_LANE_GAP = 7;

/** Edges leaving the same pin share this much of their drop before they
 *  fan out. One thick root that splits reads as one relationship; ten
 *  thin roots read as noise. */
export const BUNDLE_DROP = 18;

/** Corner radius where a route turns. Small enough that the three
 *  segments still read as "down, across, up". */
export const CORNER_R = 10;

/** Longest sideways run an edge may take, in branch spreads. A route
 *  longer than this is not drawn; its film carries a "+n more" affordance
 *  instead and the edge appears only while that film is active. */
export const MAX_RUN_SPREADS = 2;

/** The widest sideways run this geometry will draw. */
export function maxRun(g: Geometry): number {
  return g.spread * MAX_RUN_SPREADS;
}

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
  if (f.anchor) return 'anchor';
  return f.depth <= 1 ? 'trunk' : 'branch';
}

export interface PlacedFilm extends MapFilm {
  x: number;
  y: number;
  w: number;
  h: number;
  tier: Tier;
}

export type EdgeKind = 'trunk' | 'branch';

/** One person's reason for an edge. Two films are often connected by more
 *  than one — Inception and Oppenheimer by Cillian Murphy and again by
 *  Christopher Nolan — and the map draws that as one line, so the line
 *  has to carry all of them or filtering to the second person loses a
 *  film that is right there on the map. */
export interface EdgePerson {
  name: string;
  role: string;
  billing: number;
  director: boolean;
}

export interface Edge {
  id: string;
  kind: EdgeKind;
  from: PlacedFilm;
  to: PlacedFilm;
  d: string;
  /** Year-axis of the sideways run. Unique among edges whose columns overlap. */
  hy: number;
  /** The actor the edge stands for and their billing in `to` (1-based).
   *  The one that placed the card: it decides how the line is drawn. */
  actor: string;
  role: string;
  billing: number;
  /** Everyone this line stands for, the one above first. */
  people: EdgePerson[];
  /** A directing hop, drawn dashed and green rather than gold. */
  director: boolean;
  /** An extra link: a seed reached a film already on the map, rather than
   *  the hop that placed it. */
  extra: boolean;
  /** An extra link whose sideways run is longer than maxRun: drawn only
   *  while one of its films is active, and counted on the card as
   *  "+n more". A film's own placing hop is never hidden this way — a
   *  card with no line to the map is a card with no explanation. */
  long: boolean;
}

export interface Layout {
  geometry: Geometry;
  placed: PlacedFilm[];
  byId: Map<string, PlacedFilm>;
  edges: Edge[];
  /** Film id -> how many of its edges are too long to draw at rest. */
  longByFilm: Map<string, number>;
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
    // The searched film sits at x = 0; every other card steps sideways
    // from the seed it blew out of.
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

  // One line per pair of films, whoever connects them. Placements are
  // gathered first, so the person who put the card there is the one the
  // line is drawn for; anyone else joins that line rather than adding one.
  const pending: PendingEdge[] = [];
  const byPair = new Map<string, PendingEdge>();
  const join = (e: PendingEdge): void => {
    const key = pairKey(e.from.id, e.to.id);
    const seen = byPair.get(key);
    if (!seen) {
      byPair.set(key, e);
      pending.push(e);
      return;
    }
    if (seen.people.some((q) => q.name === e.people[0].name)) return;
    seen.people.push(e.people[0]);
  };
  for (const p of placed) {
    if (!p.parent) continue;
    const a = byId.get(p.parent)!;
    join({
      id: `b-${a.id}-${p.id}`, kind: 'branch', from: a, to: p, extra: false,
      actor: p.relation, role: p.role, billing: p.billing,
      people: [personOf(p.relation, p.role, p.billing)],
    });
  }
  for (const l of tree.links) {
    const a = byId.get(l.from);
    const b = byId.get(l.to);
    if (!a || !b) continue;
    join({
      id: `n-${a.id}-${b.id}`, kind: 'branch', from: a, to: b, extra: true,
      actor: l.relation, role: l.role, billing: l.billing,
      people: [personOf(l.relation, l.role, l.billing)],
    });
  }
  const lanes = routeLanes(pending);
  const limit = maxRun(g);
  const longByFilm = new Map<string, number>();
  const edges: Edge[] = pending.map((e, i) => {
    const long = e.extra && Math.abs(e.to.x - e.from.x) > limit;
    if (long) {
      longByFilm.set(e.from.id, (longByFilm.get(e.from.id) ?? 0) + 1);
      longByFilm.set(e.to.id, (longByFilm.get(e.to.id) ?? 0) + 1);
    }
    return {
      id: e.id, kind: e.kind, from: e.from, to: e.to,
      d: curve(e.from, e.to, lanes[i]), hy: lanes[i],
      actor: e.actor, role: e.role, billing: e.billing, people: e.people,
      director: e.role === 'Director', extra: e.extra, long,
    };
  });

  return { geometry: g, placed, byId, edges, longByFilm, canvasW, canvasH, minYear: cache.minYear, maxYear, shift, yOf };
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

interface PendingEdge {
  id: string;
  kind: EdgeKind;
  from: PlacedFilm;
  to: PlacedFilm;
  extra: boolean;
  actor: string;
  role: string;
  billing: number;
  people: EdgePerson[];
}

/** A pair of films, whichever way round the edge runs. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

function personOf(name: string, role: string, billing: number): EdgePerson {
  return { name, role, billing, director: role === 'Director' };
}

/** Whether this line stands, among others, for `person`. */
export function edgeHas(e: Pick<Edge, 'people'>, person: string): boolean {
  return e.people.some((q) => q.name === person);
}

/** What `person` did in the film the edge arrives at, or undefined if the
 *  line does not stand for them. */
export function personOn(e: Pick<Edge, 'people'>, person: string): EdgePerson | undefined {
  return e.people.find((q) => q.name === person);
}

interface Pt { x: number; y: number }

/** Picks a unique year-axis for each edge's sideways run. Siblings that
 *  would share a midpoint (same parent, same year) fan into a comb just
 *  before the destination so each tick is a distinct elbow. Extra network
 *  links prefer the mid-gap so they do not retrace a parent-child tick. */
export function routeLanes(edges: { id: string; from: Pt & { id?: string }; to: Pt; extra?: boolean }[]): number[] {
  const n = edges.length;
  const hy = new Array<number>(n);
  const groups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    if (Math.abs(e.to.x - e.from.x) < 0.5) {
      hy[i] = (e.from.y + e.to.y) / 2;
      continue;
    }
    const dir = Math.sign(e.to.y - e.from.y) || 1;
    const src = e.from.id ?? e.from.x.toFixed(1);
    const key = `${src}:${e.to.y.toFixed(1)}:${dir}:${e.extra ? 'n' : 'b'}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  }
  for (const idxs of groups.values()) {
    idxs.sort((i, j) => edges[i].to.x - edges[j].to.x);
    for (let k = 0; k < idxs.length; k++) {
      const e = edges[idxs[k]];
      const dir = Math.sign(e.to.y - e.from.y) || 1;
      hy[idxs[k]] = e.extra
        ? e.from.y + (e.to.y - e.from.y) * 0.42
        : e.to.y - dir * (k + 1) * LANE_GAP;
    }
  }

  const used: { x0: number; x1: number; y: number }[] = [];
  const order = [...edges.keys()].sort((i, j) => {
    const extra = Number(!!edges[i].extra) - Number(!!edges[j].extra);
    if (extra) return extra;
    const li = Math.abs(edges[i].from.x - edges[i].to.x) + Math.abs(edges[i].from.y - edges[i].to.y);
    const lj = Math.abs(edges[j].from.x - edges[j].to.x) + Math.abs(edges[j].from.y - edges[j].to.y);
    return li - lj;
  });
  for (const i of order) {
    const e = edges[i];
    if (Math.abs(e.to.x - e.from.x) < 0.5) continue;
    const x0 = Math.min(e.from.x, e.to.x);
    const x1 = Math.max(e.from.x, e.to.x);
    const y0 = Math.min(e.from.y, e.to.y);
    const y1 = Math.max(e.from.y, e.to.y);
    hy[i] = pickLane(x0, x1, y0, y1, hy[i], used);
    used.push({ x0, x1, y: hy[i] });
  }
  return hy;
}

function pickLane(
  x0: number, x1: number, y0: number, y1: number,
  preferred: number, used: { x0: number; x1: number; y: number }[],
): number {
  const conflicts = used.filter((u) => x0 <= u.x1 + 8 && u.x0 <= x1 + 8);
  const gap = Math.max(MIN_LANE_GAP, LANE_GAP);
  const free = (y: number) => conflicts.every((u) => Math.abs(u.y - y) >= gap);
  const innerLo = y0 + Math.min(LANE_GAP, (y1 - y0) * 0.12);
  const innerHi = y1 - Math.min(LANE_GAP, (y1 - y0) * 0.12);

  if (y1 - y0 < 1) {
    if (free(y0)) return y0;
  } else if (preferred >= innerLo && preferred <= innerHi && free(preferred)) {
    return preferred;
  }

  if (innerHi >= innerLo) {
    let best: number | null = null;
    let bestDist = Infinity;
    const start = innerLo;
    for (let y = start; y <= innerHi + 0.01; y += LANE_GAP) {
      if (!free(y)) continue;
      const d = Math.abs(y - preferred);
      if (d < bestDist) {
        best = y;
        bestDist = d;
      }
    }
    if (best != null) return best;
  }

  if (free(preferred)) return preferred;
  for (let k = 1; k <= 48; k++) {
    const down = y1 + k * LANE_GAP;
    if (free(down)) return down;
    const up = y0 - k * LANE_GAP;
    if (free(up)) return up;
  }
  return preferred;
}

/** Rounded orthogonal path between two pins in three segments: a drop
 *  from the source pin, one sideways run on a shared lane, then a rise
 *  into the destination pin. The first BUNDLE_DROP of the drop is
 *  straight, so every edge leaving the same pin shares one visible root
 *  before fanning out. Same column is a straight line.
 *
 *  A shallow sweep spends most of its length near-horizontal, which is
 *  why a dozen of them read as banding; a route with corners can be
 *  followed by eye from one card to the next. */
export function curve(a: Pt, b: Pt, hy?: number): string {
  if (Math.abs(b.x - a.x) < 0.5) return roundedOrtho([a, b]);
  const raw = hy ?? (a.y + b.y) / 2;
  // Two pins on the same year with no lane of their own: one straight run.
  if (Math.abs(raw - a.y) < 0.5 && Math.abs(raw - b.y) < 0.5) return roundedOrtho([a, b]);
  const lane = laneFor(a, b, raw);
  const dir = Math.sign(lane - a.y) || 1;
  const bundle = { x: a.x, y: a.y + dir * BUNDLE_DROP };
  return roundedOrtho([a, bundle, { x: a.x, y: lane }, { x: b.x, y: lane }, b]);
}

/** The lane an edge runs along, pushed clear of the source pin when it
 *  would turn too soon, so the bundled drop is visible before the first
 *  corner and siblings leave their pin as one root. */
export function laneFor(a: Pt, b: Pt, lane: number): number {
  const drop = lane - a.y;
  if (Math.abs(drop) >= BUNDLE_DROP + CORNER_R) return lane;
  const dir = Math.sign(drop) || (b.y >= a.y ? 1 : -1);
  return a.y + dir * (BUNDLE_DROP + CORNER_R);
}

function roundedOrtho(pts: Pt[]): string {
  const p = collapse(pts);
  if (p.length === 0) return '';
  if (p.length === 1) return `M ${fmt(p[0])}`;
  if (p.length === 2) return `M ${fmt(p[0])} L ${fmt(p[1])}`;
  const parts = [`M ${fmt(p[0])}`];
  for (let i = 1; i < p.length - 1; i++) {
    const prev = p[i - 1];
    const corner = p[i];
    const next = p[i + 1];
    const r = Math.min(CORNER_R, dist(prev, corner) / 2, dist(corner, next) / 2);
    if (r < 0.5) {
      parts.push(`L ${fmt(corner)}`);
      continue;
    }
    parts.push(`L ${fmt(approach(prev, corner, r))}`);
    parts.push(`Q ${fmt(corner)}, ${fmt(approach(next, corner, r))}`);
  }
  parts.push(`L ${fmt(p[p.length - 1])}`);
  return parts.join(' ');
}

function collapse(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.05 && Math.abs(last.y - p.y) < 0.05) continue;
    const prev = out[out.length - 2];
    if (prev && last && collinear(prev, last, p)) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

function collinear(a: Pt, b: Pt, c: Pt): boolean {
  return (Math.abs(a.x - b.x) < 0.05 && Math.abs(b.x - c.x) < 0.05)
    || (Math.abs(a.y - b.y) < 0.05 && Math.abs(b.y - c.y) < 0.05);
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function approach(from: Pt, to: Pt, r: number): Pt {
  const len = dist(from, to);
  if (len < 1e-6) return { x: to.x, y: to.y };
  const t = r / len;
  return { x: to.x - (to.x - from.x) * t, y: to.y - (to.y - from.y) * t };
}

function fmt(p: Pt): string {
  return `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
}

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
 *  lit screen plus `screens`. Long edges that cross the view without
 *  either pin on screen still count. */
export function edgesWithin(layout: Layout, v: Viewport, screens: number): Edge[] {
  const x0 = v.sx - v.vw * screens;
  const x1 = v.sx + v.vw * (1 + screens);
  const y0 = v.sy - v.vh * screens;
  const y1 = v.sy + v.vh * (1 + screens);
  return layout.edges.filter((e) => {
    const minX = Math.min(e.from.x, e.to.x);
    const maxX = Math.max(e.from.x, e.to.x);
    const minY = Math.min(e.from.y, e.to.y, e.hy);
    const maxY = Math.max(e.from.y, e.to.y, e.hy);
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
