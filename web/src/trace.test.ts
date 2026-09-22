import { describe, expect, it } from 'vitest';
import { GEOMETRY, LayoutCache, layoutTree, type Layout } from './layout';
import { traceLabelFor, traceRoleIn, traceRoute } from './trace';
import type { MapFilm, MapTree } from './tree';

function film(id: string, year: number, extra: Partial<MapFilm> = {}): MapFilm {
  return {
    id, year, trunk: false, anchor: false, side: 1, relation: 'Somebody', relationPersonId: 'p:0',
    role: 'Role', billing: 1, depth: 1,
    movie: { id, type: 'movie', label: id, tmdb_id: 1, year },
    ...extra,
  };
}

/**
 *   anchor ──Ann── b ──Bob── c ──Ann── d
 *      └───Cid─── e
 * Ann appears twice: once next to the anchor, once three hops out.
 */
function built(): Layout {
  const films = [
    film('anchor', 1990, { anchor: true, trunk: true, depth: 0 }),
    film('b', 1995, { parent: 'anchor', depth: 1, relation: 'Ann', role: 'Neo' }),
    film('c', 2000, { parent: 'b', depth: 2, relation: 'Bob', role: 'Trinity' }),
    film('d', 2005, { parent: 'c', depth: 3, relation: 'Ann', role: 'Director' }),
    film('e', 2010, { parent: 'anchor', side: -1, depth: 1, relation: 'Cid', role: 'Cypher' }),
  ];
  const tree: MapTree = {
    anchorId: 'anchor',
    films: new Map(films.map((f) => [f.id, f])),
    expanded: new Set(),
    deepened: new Set(),
    links: [],
  };
  return layoutTree(tree, new LayoutCache(GEOMETRY.desktop));
}

describe('traceRoute', () => {
  it('is null for someone the map does not connect', () => {
    expect(traceRoute(built(), 'Nobody')).toBeNull();
  });

  it('lights the route from the searched film, not just the person’s hops', () => {
    const t = traceRoute(built(), 'Ann')!;
    // Ann's far hop is c–d; the route to it runs anchor–b–c.
    expect([...t.films].sort()).toEqual(['anchor', 'b', 'c', 'd']);
    expect(t.edges.size).toBe(3); // anchor–b, b–c, c–d
  });

  it('separates the person’s own hops from the route that reaches them', () => {
    const l = built();
    const t = traceRoute(l, 'Ann')!;
    const byId = new Map(l.edges.map((e) => [e.id, e]));
    for (const id of t.through) expect(byId.get(id)!.actor).toBe('Ann');
    const context = [...t.edges].filter((id) => !t.through.has(id));
    expect(context.map((id) => byId.get(id)!.actor)).toEqual(['Bob']);
  });

  it('counts the films the person connects', () => {
    expect(traceRoute(built(), 'Ann')!.appearances).toBe(4); // anchor, b, c, d
    expect(traceRoute(built(), 'Cid')!.appearances).toBe(2);
  });

  it('is just the one hop when the person sits next to the searched film', () => {
    const t = traceRoute(built(), 'Cid')!;
    expect(t.edges.size).toBe(1);
    expect([...t.films].sort()).toEqual(['anchor', 'e']);
  });

  it('always includes the searched film, so the route starts somewhere known', () => {
    expect(traceRoute(built(), 'Ann')!.films.has('anchor')).toBe(true);
    expect(traceRoute(built(), 'Bob')!.films.has('anchor')).toBe(true);
  });

  it('takes the shortest way round when a link offers a short cut', () => {
    const l = built();
    // A direct anchor–c link: the route to Ann's far hop should use it
    // instead of going the long way through b.
    const tree: MapTree = {
      anchorId: 'anchor',
      films: new Map(l.placed.map((f) => [f.id, f as MapFilm])),
      expanded: new Set(),
      deepened: new Set(),
      links: [{ from: 'anchor', to: 'c', relation: 'Dee', relationPersonId: 'p:9', role: 'Extra', billing: 4 }],
    };
    const short = layoutTree(tree, new LayoutCache(GEOMETRY.desktop));
    const t = traceRoute(short, 'Ann')!;
    const actors = [...t.edges].map((id) => short.edges.find((e) => e.id === id)!.actor);
    expect(actors).toContain('Dee');
    expect(actors).not.toContain('Bob');
  });
});

describe('traceRoleIn', () => {
  it('says what the person did in that particular film', () => {
    const l = built();
    expect(traceRoleIn(l, 'Ann', 'b')).toBe('Neo');
    expect(traceRoleIn(l, 'Ann', 'd')).toBe('directed');
  });

  it('is empty where the person has no hop', () => {
    expect(traceRoleIn(built(), 'Ann', 'e')).toBe('');
  });

  it('will not borrow the role from the other end of a hop', () => {
    // Ann reaches b as Neo; that says nothing about what she did in the
    // searched film, so the searched film's card stays quiet.
    expect(traceRoleIn(built(), 'Ann', 'anchor')).toBe('');
  });
});

describe('stops', () => {
  it('walks outward from the searched film', () => {
    const t = traceRoute(built(), 'Ann');
    expect(t).not.toBeNull();
    expect(t!.stops).toEqual(['anchor', 'b', 'c', 'd']);
  });

  it('lists every film the person reaches, once each', () => {
    const t = traceRoute(built(), 'Ann')!;
    expect(t.stops).toHaveLength(t.appearances);
    expect(new Set(t.stops).size).toBe(t.stops.length);
  });

  it('starts a one-hop trace at the two films it joins', () => {
    const t = traceRoute(built(), 'Cid')!;
    expect(t.stops).toEqual(['anchor', 'e']);
  });
});

describe('traceLabelFor', () => {
  it('names the person and what they did here', () => {
    const l = built();
    const t = traceRoute(l, 'Ann')!;
    expect(traceLabelFor(l, t, 'b')).toBe('Ann · Neo');
    expect(traceLabelFor(l, t, 'd')).toBe('Ann · directed');
  });

  it('leaves a card alone where the person did nothing', () => {
    const l = built();
    expect(traceLabelFor(l, traceRoute(l, 'Ann')!, 'e')).toBeUndefined();
  });
});
