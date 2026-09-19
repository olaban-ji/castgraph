import { describe, expect, it } from 'vitest';
import type { ApiNode, Pathways, PathwayFilm } from './api';
import { buildTree, costarsFor, expandable, extendTree, RULES } from './tree';

const movie = (id: number, label: string, year: number | undefined, votes = 100): PathwayFilm => ({
  id: `m:${id}`, type: 'movie', label, tmdb_id: id, year, votes, rating: 7, role: 'Role', order: 0,
});
const person = (id: number, label: string): ApiNode => ({ id: `p:${id}`, type: 'person', label, tmdb_id: id });

/** The anchor (1): lead 10 with films 2..6 (most voted first), co-star 11
 *  with films 7, 8; the API already dropped anyone with no other film. */
function anchorPathways(): Pathways {
  return {
    movie: movie(1, 'Anchor', 1999, 9000),
    cast: [
      { person: person(10, 'Lead'), role: 'Neo', order: 0, films: [
        movie(5, 'Lead D', 2014), movie(3, 'Lead B', 1994), movie(2, 'Lead A', 1991), movie(4, 'Lead C', 2005),
        movie(6, 'Lead E', 2013), movie(9, 'Undated', undefined),
      ] },
      { person: person(11, 'Costar'), role: 'Trinity', order: 1, films: [movie(7, 'Costar A', 1979), movie(8, 'Costar B', 2000), movie(12, 'Costar C', 2001)] },
    ],
  };
}

describe('buildTree', () => {
  it('makes the top-billed actor the trunk and other co-stars branches', () => {
    const tree = buildTree(anchorPathways());
    const trunk = [...tree.films.values()].filter((f) => f.trunk && !f.anchor).map((f) => f.id);
    expect(trunk).toEqual(['m:5', 'm:3', 'm:2', 'm:4', 'm:6']); // API order, undated film dropped
    expect(tree.leadId).toBe('p:10');

    const branches = [...tree.films.values()].filter((f) => f.parent);
    expect(branches.map((f) => f.id)).toEqual(['m:7', 'm:8']); // two films per anchor co-star
    expect(branches[0]).toMatchObject({ parent: 'm:1', relation: 'Costar', depth: 1, side: -1, role: 'Role', billing: 1 });
    // The anchor's own relation is its lead and their role in it.
    expect(tree.films.get('m:1')).toMatchObject({ relation: 'Lead', role: 'Neo', billing: 1 });
    expect(branches[1].side).toBe(1);
    expect(tree.expanded.has('m:1')).toBe(true);
    expect(expandable(tree).map((f) => f.id)).toEqual(['m:5', 'm:3', 'm:2', 'm:4', 'm:6', 'm:7', 'm:8']);
  });

  it('caps the trunk', () => {
    const pw = anchorPathways();
    for (let i = 20; i < 40; i++) pw.cast[0].films.push(movie(i, `Lead ${i}`, 1980 + i));
    const trunk = [...buildTree(pw).films.values()].filter((f) => f.trunk && !f.anchor);
    expect(trunk).toHaveLength(RULES.trunkMax);
  });

  it('refuses an anchor with no year', () => {
    const pw = anchorPathways();
    pw.movie = movie(1, 'Anchor', undefined);
    expect(() => buildTree(pw)).toThrow(/release year/);
  });
});

describe('extendTree', () => {
  it("hangs a stop's co-stars' films off it, skipping the lead and the actor that led there", () => {
    const tree = buildTree(anchorPathways());
    // Expanding "Lead A" (m:2): its cast is the lead again, co-star 13 whose
    // best film is already on the map, and co-star 14.
    const pw: Pathways = {
      movie: movie(2, 'Lead A', 1991),
      cast: [
        { person: person(10, 'Lead'), role: 'X', order: 0, films: [movie(50, 'Lead F', 1988)] },
        { person: person(13, 'Other'), role: 'Y', order: 1, films: [movie(3, 'Lead B', 1994), movie(30, 'Other A', 1986)] },
        { person: person(14, 'Third'), role: 'Z', order: 2, films: [movie(31, 'Third A', 1995)] },
        { person: person(15, 'Fourth'), role: 'W', order: 3, films: [movie(32, 'Fourth A', 1996)] },
      ],
    };
    expect(extendTree(tree, 'm:2', pw)).toBe(true);
    const kids = [...tree.films.values()].filter((f) => f.parent === 'm:2');
    // A trunk stop gets two co-stars, one film each, next-best when taken.
    expect(kids.map((f) => f.id)).toEqual(['m:30', 'm:31']);
    expect(kids[0]).toMatchObject({ relation: 'Other', depth: 1 });
    expect(tree.films.has('m:50')).toBe(false);
    // A film already on the map is never re-parented.
    expect(tree.films.get('m:3')?.parent).toBeUndefined();
    // Idempotent.
    expect(extendTree(tree, 'm:2', pw)).toBe(false);
    expect(expandable(tree).map((f) => f.id)).not.toContain('m:2');
  });

  it('narrows to a single route past the trunk', () => {
    const tree = buildTree(anchorPathways());
    // m:7 hangs off the anchor (depth 1); its expansion offers three co-stars.
    const pw: Pathways = {
      movie: movie(7, 'Costar A', 1979),
      cast: [
        { person: person(21, 'A'), role: 'x', order: 0, films: [movie(60, 'A1', 1980)] },
        { person: person(22, 'B'), role: 'y', order: 1, films: [movie(61, 'B1', 1981)] },
        { person: person(23, 'C'), role: 'z', order: 2, films: [movie(62, 'C1', 1982)] },
      ],
    };
    expect(costarsFor(tree.films.get('m:7')!)).toBe(RULES.deepStopCostars);
    extendTree(tree, 'm:7', pw);
    const kids = [...tree.films.values()].filter((f) => f.parent === 'm:7');
    expect(kids.map((f) => f.id)).toEqual(['m:60']);
    expect(costarsFor(tree.films.get('m:1')!)).toBe(RULES.anchorCostars);
    expect(costarsFor(tree.films.get('m:5')!)).toBe(RULES.trunkStopCostars);
  });

  it('keeps growing at any depth', () => {
    const tree = buildTree(anchorPathways());
    let parent = 'm:7';
    for (let depth = 1; depth <= 6; depth++) {
      const id = 100 + depth;
      const pw: Pathways = {
        movie: movie(Number(parent.slice(2)), 'p', 1990),
        cast: [{ person: person(200 + depth, `Actor ${depth}`), role: 'R', order: 0, films: [movie(id, `Deep ${depth}`, 1990 + depth)] }],
      };
      expect(extendTree(tree, parent, pw)).toBe(true);
      parent = `m:${id}`;
    }
    expect(tree.films.get('m:106')?.depth).toBe(7);
  });

  it('ignores a stop that is not on the map', () => {
    const tree = buildTree(anchorPathways());
    expect(extendTree(tree, 'm:999', { movie: movie(999, 'X', 2000), cast: [] })).toBe(false);
  });
});
