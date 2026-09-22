import { describe, expect, it } from 'vitest';
import { curve, decadeColour, edgesWithin, filmsWithin, GEOMETRY, HEADER_H, LANE_GAP, LayoutCache, layoutTree, routeLanes, TOP, topOf, scrollPosForFilm } from './layout';
import type { MapFilm, MapTree } from './tree';

function film(id: string, year: number, extra: Partial<MapFilm> = {}): MapFilm {
  return {
    id, year, trunk: false, anchor: false, side: 1, relation: 'X', relationPersonId: 'p:1', role: 'R', billing: 1, depth: 1,
    movie: { id, type: 'movie', label: id, tmdb_id: 1, year },
    ...extra,
  };
}

function tree(films: MapFilm[]): MapTree {
  return { anchorId: films[0].id, films: new Map(films.map((f) => [f.id, f])), expanded: new Set(), deepened: new Set(), links: [] };
}

describe('layoutTree', () => {
  const g = GEOMETRY.desktop;

  it('pins y to the year, fans blow-outs from the seed and never moves y', () => {
    const t = tree([
      film('a', 1999, { trunk: true, anchor: true, depth: 0 }),
      film('b', 2010, { parent: 'a', side: 1, depth: 1, trunk: true }),
      film('c', 2011, { parent: 'a', side: 1, depth: 1, trunk: true }), // clashes with b: pushed sideways, not down
      film('d', 1980, { parent: 'a', side: -1, depth: 1, trunk: true }),
    ]);
    const l = layoutTree(t, new LayoutCache(g));
    expect(l.minYear).toBe(1980);
    const a = l.byId.get('a')!;
    const b = l.byId.get('b')!;
    const c = l.byId.get('c')!;
    expect(a.y).toBe(TOP + 19 * g.ppy);
    expect(a.tier).toBe('anchor');
    expect(a.w).toBe(g.anchor[0]);
    expect(b.x).toBeGreaterThan(a.x);
    expect(c.y).toBe(TOP + 31 * g.ppy);
    expect(Math.abs(c.x - b.x)).toBeGreaterThanOrEqual((b.w + c.w) / 2 + 46 - 1);
    expect(l.byId.get('d')!.y).toBe(TOP);
    expect(l.byId.get('d')!.x).toBeLessThan(a.x);
    expect(l.byId.get('d')!.tier).toBe('trunk');
  });

  it('keeps a card on the earliest year fully below the header', () => {
    for (const device of ['desktop', 'tablet', 'phone'] as const) {
      const geo = GEOMETRY[device];
      const l = layoutTree(
        tree([film('a', 1999, { trunk: true, anchor: true, depth: 0 })]),
        new LayoutCache(geo),
      );
      const a = l.byId.get('a')!;
      expect(a.y - geo.stem - a.h).toBeGreaterThanOrEqual(HEADER_H);
      expect(a.y).toBe(topOf(geo));
    }
  });

  it('keeps every card inside the canvas with padding', () => {
    const films = [film('a', 1999, { trunk: true, anchor: true, depth: 0 })];
    for (let i = 0; i < 30; i++) films.push(film(`b${i}`, 1990 + (i % 5), { parent: 'a', side: i % 2 ? 1 : -1 }));
    const l = layoutTree(tree(films), new LayoutCache(g));
    expect(Math.min(...l.placed.map((p) => p.x - p.w / 2))).toBe(g.pad);
    expect(Math.max(...l.placed.map((p) => p.x + p.w / 2)) + g.pad).toBeLessThanOrEqual(l.canvasW + 1);
    expect(Math.min(...l.placed.map((p) => p.y - g.stem - p.h))).toBeGreaterThanOrEqual(HEADER_H);
    expect(l.canvasH).toBe(l.yOf(1999) + 260);
    // No two cards that overlap vertically overlap horizontally.
    for (const p of l.placed) {
      for (const q of l.placed) {
        if (p === q) continue;
        const vertical = !(p.y - g.stem - p.h > q.y + 26 || q.y - g.stem - q.h > p.y + 26);
        if (vertical) expect(Math.abs(p.x - q.x)).toBeGreaterThanOrEqual((p.w + q.w) / 2 + 46 - 1);
      }
    }
  });

  it('builds one edge per blow-out, each naming its actor, plus extra network links', () => {
    const t = tree([
      film('a', 1999, { trunk: true, anchor: true, depth: 0, relation: 'Lead', role: 'Neo' }),
      film('b', 1991, { parent: 'a', side: 1, depth: 1, trunk: true, relation: 'Lead', role: 'Utah', billing: 1 }),
      film('c', 2005, { parent: 'a', side: -1, depth: 1, trunk: true, relation: 'Lead', role: 'John', billing: 1 }),
      film('d', 1980, { parent: 'b', side: -1, depth: 2, relation: 'Costar', role: 'Frank', billing: 3 }),
    ]);
    t.links.push({ from: 'c', to: 'd', relation: 'Costar', relationPersonId: 'p:1', role: 'Frank', billing: 3 });
    const l = layoutTree(t, new LayoutCache(g));
    expect(l.edges.filter((e) => e.kind === 'trunk')).toHaveLength(0);
    const branch = l.edges.filter((e) => e.id.startsWith('b-'));
    expect(branch).toHaveLength(3);
    expect(branch.find((e) => e.to.id === 'd')).toMatchObject({
      from: { id: 'b' }, to: { id: 'd' }, actor: 'Costar', role: 'Frank', billing: 3,
    });
    const extra = l.edges.find((e) => e.id.startsWith('n-'))!;
    expect(extra).toMatchObject({ from: { id: 'c' }, to: { id: 'd' }, actor: 'Costar' });
    expect(extra.d).toMatch(/^M /);
    expect(extra.d).not.toMatch(/ C /);
    expect(Math.abs(extra.hy - branch.find((e) => e.to.id === 'd')!.hy)).toBeGreaterThanOrEqual(LANE_GAP);
  });

  it('does not stack same-year blow-outs on one sideways run', () => {
    const t = tree([
      film('a', 1999, { trunk: true, anchor: true, depth: 0 }),
      film('b', 2010, { parent: 'a', side: 1, depth: 1, trunk: true }),
      film('c', 2010, { parent: 'a', side: 1, depth: 1, trunk: true }),
      film('d', 2010, { parent: 'a', side: -1, depth: 1, trunk: true }),
    ]);
    const l = layoutTree(t, new LayoutCache(g));
    const ys = l.edges.map((e) => e.hy);
    expect(new Set(ys).size).toBe(l.edges.length);
    for (let i = 0; i < l.edges.length; i++) {
      for (let j = i + 1; j < l.edges.length; j++) {
        const a = l.edges[i];
        const b = l.edges[j];
        const overlap = Math.min(a.from.x, a.to.x) <= Math.max(b.from.x, b.to.x)
          && Math.min(b.from.x, b.to.x) <= Math.max(a.from.x, a.to.x);
        if (overlap) expect(Math.abs(a.hy - b.hy)).toBeGreaterThanOrEqual(LANE_GAP);
      }
    }
  });

  it('never moves a placed card when later films arrive, even earlier ones', () => {
    const cache = new LayoutCache(g);
    const films = [
      film('a', 1999, { trunk: true, anchor: true, depth: 0 }),
      film('b', 2003, { parent: 'a', side: 1, depth: 1, trunk: true }),
      film('c', 1979, { parent: 'a', side: -1, depth: 1, trunk: true }),
    ];
    const first = layoutTree(tree(films), cache);
    const before = new Map(first.placed.map((p) => [p.id, { x: p.x - first.shift, y: p.y }]));

    films.push(film('d', 1960, { parent: 'c', side: -1 }));
    films.push(film('e', 2000, { parent: 'c', side: -1 }));
    const second = layoutTree(tree(films), cache);
    const dyTop = (1979 - 1960) * g.ppy;
    for (const [id, p] of before) {
      const q = second.byId.get(id)!;
      expect(q.x - second.shift).toBe(p.x);
      expect(q.y).toBe(p.y + dyTop);
    }
    expect(second.byId.get('d')!.y).toBe(TOP);
    expect(second.minYear).toBe(1960);
  });

  it('does not move existing cards when a stop is deepened', () => {
    const cache = new LayoutCache(g);
    const t = tree([
      film('a', 1999, { trunk: true, anchor: true, depth: 0 }),
      film('b', 1991, { parent: 'a', side: 1, depth: 1, trunk: true }),
    ]);
    const first = layoutTree(t, cache);
    const bx = first.byId.get('b')!.x - first.shift;
    const by = first.byId.get('b')!.y;
    t.films.set(
      'c',
      film('c', 1995, { parent: 'b', side: 1, depth: 2 }),
    );
    const second = layoutTree(t, cache);
    expect(second.byId.get('b')!.x - second.shift).toBe(bx);
    expect(second.byId.get('b')!.y).toBe(by);
    expect(second.byId.get('c')!.parent).toBe('b');
  });

  it('windows films to the lit screen plus a band', () => {
    const films = [film('a', 1999, { trunk: true, anchor: true, depth: 0 })];
    for (let y = 1900; y < 2020; y += 5) films.push(film(`b${y}`, y, { parent: 'a' }));
    const l = layoutTree(tree(films), new LayoutCache(g));
    const all = filmsWithin(l, { sx: 0, sy: 0, vw: 100000, vh: 100000 }, 0);
    expect(all).toHaveLength(l.placed.length);
    const top = filmsWithin(l, { sx: 0, sy: 0, vw: 3000, vh: 500 }, 0.25);
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThan(l.placed.length);
    expect(top.every((p) => p.y - g.stem - p.h < 500 * 1.25)).toBe(true);
  });
});

describe('edgesWithin', () => {
  const g = GEOMETRY.desktop;
  const l = layoutTree(
    tree([
      film('a', 1999, { trunk: true, anchor: true, depth: 0 }),
      film('b', 1991, { parent: 'a', side: 1, depth: 1, trunk: true }),
      film('c', 2005, { parent: 'a', side: -1, depth: 1, trunk: true }),
      film('d', 1980, { parent: 'a', side: -1, depth: 1, trunk: true }),
    ]),
    new LayoutCache(g),
  );

  it('keeps an edge whose path crosses the window even if neither pin is in it', () => {
    const edge = l.edges.find((e) => e.from.id === 'a' && e.to.id === 'c')
      ?? l.edges.find((e) => e.from.id === 'c' && e.to.id === 'a')!;
    const midY = (edge.from.y + edge.to.y) / 2;
    const midX = (edge.from.x + edge.to.x) / 2;
    const hit = edgesWithin(l, { sx: midX - 10, sy: midY - 10, vw: 20, vh: 20 }, 0);
    expect(hit.some((e) => e.id === edge.id)).toBe(true);
  });

  it('drops edges whose bounding box misses the window', () => {
    const d = l.byId.get('d')!;
    const far = edgesWithin(l, { sx: d.x + 4000, sy: d.y + 4000, vw: 100, vh: 100 }, 0);
    expect(far).toHaveLength(0);
  });
});

describe('curve', () => {
  it('is a straight line when pins share a column or a year', () => {
    expect(curve({ x: 10, y: 0 }, { x: 10, y: 80 })).toBe('M 10.0 0.0 L 10.0 80.0');
    expect(curve({ x: 10, y: 40 }, { x: 200, y: 40 })).toBe('M 10.0 40.0 L 200.0 40.0');
  });

  it('steps sideways in the year gap instead of folding into an S-curve', () => {
    const d = curve({ x: 0, y: 0 }, { x: 200, y: 100 });
    expect(d.startsWith('M 0.0 0.0')).toBe(true);
    expect(d.endsWith('L 200.0 100.0')).toBe(true);
    expect(d).toContain(' Q ');
    expect(d).not.toMatch(/ C /);
    expect(d).toContain('50.0'); // midpoint year
  });

  it('jogs off a shared year when given a lane', () => {
    const d = curve({ x: 0, y: 40 }, { x: 200, y: 40 }, 70);
    expect(d).toContain(' Q ');
    expect(d).toContain('70.0');
    expect(d).not.toBe('M 0.0 40.0 L 200.0 40.0');
  });
});

describe('routeLanes', () => {
  it('gives same-year siblings distinct sideways runs', () => {
    const lanes = routeLanes([
      { id: 'b-a-1', from: { x: 0, y: 0 }, to: { x: 200, y: 100 } },
      { id: 'b-a-2', from: { x: 0, y: 0 }, to: { x: 400, y: 100 } },
      { id: 'b-a-3', from: { x: 0, y: 0 }, to: { x: 600, y: 100 } },
    ]);
    expect(new Set(lanes).size).toBe(3);
    expect(Math.abs(lanes[0] - lanes[1])).toBeGreaterThanOrEqual(LANE_GAP);
    expect(Math.abs(lanes[1] - lanes[2])).toBeGreaterThanOrEqual(LANE_GAP);
    expect(Math.abs(lanes[0] - lanes[2])).toBeGreaterThanOrEqual(LANE_GAP);
  });

  it('keeps a reverse extra link off the parent-child tick', () => {
    const lanes = routeLanes([
      { id: 'b-a-b', from: { x: 0, y: 0 }, to: { x: 400, y: 200 }, extra: false },
      { id: 'n-b-a', from: { x: 400, y: 200 }, to: { x: 0, y: 0 }, extra: true },
    ]);
    expect(Math.abs(lanes[0] - lanes[1])).toBeGreaterThanOrEqual(LANE_GAP);
  });
});

describe('decadeColour', () => {
  it('maps a year to its decade hue and falls back for unknown decades', () => {
    expect(decadeColour(1999)).toBe('#7FA8C9');
    expect(decadeColour(2013)).toBe('#C97F9E');
    expect(decadeColour(1957)).toBe('#E8B84A');
    expect(decadeColour(1961)).toBe('#4DB8C9');
    expect(decadeColour(1915)).toBe('#B8C0CC');
  });
});

describe('scrollPosForFilm', () => {
  it('centres the card in the window below the header', () => {
    const pos = scrollPosForFilm({ x: 1000, y: 500, h: 220 }, 34, 1, 1200, 800);
    expect(pos.left).toBe(400);
    expect(pos.top).toBe((500 - 34 - 110) - (800 + HEADER_H) / 2);
  });

  it('scales with zoom', () => {
    const pos = scrollPosForFilm({ x: 1000, y: 500, h: 220 }, 34, 2, 1200, 800);
    expect(pos.left).toBe(1400);
  });
});
