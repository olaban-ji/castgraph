import { describe, expect, it } from 'vitest';
import type { ApiNode, Pathways, PathwayFilm } from './api';
import {
  buildTree,
  canDeepen,
  deepenTree,
  expandable,
  extendTree,
  filmWeight,
  isRecent,
  recentFrom,
  hopScore,
  peopleFor,
  personWeight,
  phi,
  rankHops,
  RULES,
} from './tree';

const movie = (
  id: number,
  label: string,
  year: number | undefined,
  votes = 100,
): PathwayFilm => ({
  id: `m:${id}`,
  type: 'movie',
  label,
  tmdb_id: id,
  year,
  votes,
  rating: 7,
  role: 'Role',
  order: 0,
});
const person = (id: number, label: string, popularity = 5): ApiNode => ({
  id: `p:${id}`,
  type: 'person',
  label,
  tmdb_id: id,
  popularity,
});

function seedPathways(): Pathways {
  return {
    movie: movie(1, 'Seed', 1999, 9000),
    cast: [
      {
        person: person(10, 'Lead', 20),
        role: 'Neo',
        order: 0,
        films: [
          movie(2, 'Hit A', 1991, 8000),
          movie(3, 'Hit B', 1994, 7000),
          movie(4, 'Hit C', 2005, 6000),
          movie(5, 'Hit D', 2014, 5000),
          movie(6, 'Hit E', 2015, 4000),
          movie(9, 'Undated', undefined, 9000),
        ],
      },
      {
        person: person(11, 'Costar', 8),
        role: 'Trinity',
        order: 1,
        films: [
          movie(7, 'Side A', 1979, 4000),
          movie(8, 'Side B', 2000, 3000),
          movie(12, 'Side C', 2001, 2000),
        ],
      },
    ],
  };
}

describe('weights', () => {
  it('logs popularity and votes and discounts billing', () => {
    expect(personWeight(10, 0)).toBeCloseTo(Math.log1p(10));
    expect(personWeight(10, 1)).toBeCloseTo(Math.log1p(10) * phi(1));
    expect(filmWeight(100, 0)).toBeCloseTo(Math.log1p(100));
    expect(hopScore(10, 1, { votes: 100, order: 4 })).toBeCloseTo(
      personWeight(10, 1) * filmWeight(100, 4),
    );
  });

  it('counts the last two years as recent', () => {
    const now = new Date('2026-09-23');
    expect(recentFrom(now)).toBe(2024);
    expect(isRecent(2025, now)).toBe(true);
    expect(isRecent(2024, now)).toBe(true);
    expect(isRecent(2023, now)).toBe(false);
    expect(isRecent(undefined, now)).toBe(false);
  });
});

describe('rankHops', () => {
  it('orders by score and drops undated films', () => {
    const hops = rankHops(seedPathways().cast, new Set());
    expect(hops.every((h) => h.film.id !== 'm:9')).toBe(true);
    for (let i = 1; i < hops.length; i++) {
      expect(hops[i - 1].score).toBeGreaterThanOrEqual(hops[i].score);
    }
    expect(hops[0].person.id).toBe('p:10');
  });
});

describe('buildTree', () => {
  it('blows the seed out into children, with no gold trunk of other films', () => {
    const tree = buildTree(seedPathways());
    const kids = [...tree.films.values()].filter((f) => f.parent === 'm:1');
    expect(tree.films.get('m:1')!.anchor).toBe(true);
    expect(kids.length).toBeGreaterThan(4);
    expect(kids.every((f) => !f.anchor && f.parent === 'm:1' && f.depth === 1)).toBe(true);
    expect(kids.some((f) => f.side === -1)).toBe(true);
    expect(kids.some((f) => f.side === 1)).toBe(true);
    expect(kids.filter((f) => f.relationPersonId === 'p:10').length).toBe(5);
    expect(kids.filter((f) => f.relationPersonId === 'p:11').length).toBe(3);
    expect(tree.films.has('m:9')).toBe(false);
    expect(tree.expanded.has('m:1')).toBe(true);
    expect(tree.deepened.has('m:1')).toBe(true);
    expect(canDeepen(tree, 'm:1')).toBe(false);
    expect(expandable(tree).map((f) => f.id).sort()).toEqual(kids.map((f) => f.id).sort());
  });

  it('keeps a slot for a person\'s newest film without costing an older one', () => {
    const thisYear = new Date().getFullYear();
    const full = Array.from({ length: RULES.seedFilms }, (_, i) =>
      movie(200 + i, `Hit ${i}`, 1990 + i, 30000 - i * 100),
    );
    const pw: Pathways = {
      movie: movie(1, 'Seed', 2010, 40000),
      cast: [
        {
          person: person(10, 'Star', 20),
          role: 'Lead',
          order: 0,
          // One more film than the cap allows, and a small new one behind it.
          films: [...full, movie(300, 'Older extra', 1985, 20000), movie(301, 'Newest', thisYear, 400)],
        },
      ],
    };
    const tree = buildTree(pw);
    const mine = [...tree.films.values()].filter((f) => f.parent === 'm:1');
    // Every film that made the cut on votes is still there …
    for (const f of full) expect(tree.films.has(f.id)).toBe(true);
    // … the new one is there beside them, in a slot of its own …
    expect(tree.films.has('m:301')).toBe(true);
    // … and the slot is only for the new one, not a bigger fan: the
    // older film behind the cap stays behind it.
    expect(tree.films.has('m:300')).toBe(false);
    expect(mine).toHaveLength(RULES.seedFilms + 1);
  });

  it('caps the reserved slots, so one prolific year cannot swamp a seed', () => {
    const thisYear = new Date().getFullYear();
    const full = Array.from({ length: RULES.seedFilms }, (_, i) =>
      movie(200 + i, `Hit ${i}`, 1990 + i, 30000 - i * 100),
    );
    // Five recent films for one person, most voted first.
    const fresh = Array.from({ length: 5 }, (_, i) =>
      movie(300 + i, `New ${i}`, thisYear, 900 - i * 100),
    );
    const pw: Pathways = {
      movie: movie(1, 'Seed', 2010, 40000),
      cast: [
        { person: person(10, 'Star', 20), role: 'Lead', order: 0, films: [...full, ...fresh] },
      ],
    };
    const tree = buildTree(pw);
    const mine = [...tree.films.values()].filter((f) => f.parent === 'm:1');
    expect(mine).toHaveLength(RULES.seedFilms + RULES.recentSlots);
    // The most voted of the new films take the slots, in order.
    for (const f of fresh.slice(0, RULES.recentSlots)) expect(tree.films.has(f.id)).toBe(true);
    for (const f of fresh.slice(RULES.recentSlots)) expect(tree.films.has(f.id)).toBe(false);
  });

  it('charges nothing extra for recent work that ranks on its own votes', () => {
    const thisYear = new Date().getFullYear();
    // A new film big enough to place among the most voted, and two small
    // ones behind it. The big one earns its place, so all three fit.
    const films = [
      ...Array.from({ length: RULES.seedFilms - 1 }, (_, i) =>
        movie(200 + i, `Hit ${i}`, 1990 + i, 30000 - i * 100),
      ),
      movie(250, 'Big and new', thisYear, 29000),
      movie(300, 'Small and new', thisYear, 500),
      movie(301, 'Smaller and new', thisYear, 400),
      movie(400, 'Old also-ran', 1985, 1000),
    ];
    const pw: Pathways = {
      movie: movie(1, 'Seed', 2010, 40000),
      cast: [{ person: person(10, 'Star', 20), role: 'Lead', order: 0, films }],
    };
    const tree = buildTree(pw);
    expect(tree.films.has('m:250')).toBe(true);
    expect(tree.films.has('m:300')).toBe(true);
    expect(tree.films.has('m:301')).toBe(true);
    expect(tree.films.has('m:400')).toBe(false);
  });

  it('always hangs the director\'s films, even when billed stars outscore them', () => {
    const stars = Array.from({ length: RULES.seedPeople }, (_, i) => ({
      person: person(100 + i, `Star ${i}`, 40),
      role: 'Role',
      order: i,
      films: [movie(200 + i, `Star hit ${i}`, 1980 + i, 200000)],
    }));
    const pw: Pathways = {
      movie: movie(1, 'Dr. Strangelove', 1964, 9000),
      cast: [
        ...stars,
        {
          person: person(99, 'Stanley Kubrick', 6),
          role: 'Director',
          order: 0,
          films: [
            { ...movie(40, 'The Shining', 1980, 18000), role: 'Director' },
            { ...movie(41, 'A Clockwork Orange', 1971, 16000), role: 'Director' },
            { ...movie(42, '2001: A Space Odyssey', 1968, 17000), role: 'Director' },
          ],
        },
      ],
    };
    const tree = buildTree(pw);
    expect(tree.films.get('m:41')).toMatchObject({
      relation: 'Stanley Kubrick',
      role: 'Director',
      parent: 'm:1',
    });
    expect(tree.films.has('m:40')).toBe(true);
    expect(tree.films.has('m:42')).toBe(true);
  });

  it('lets a high-score hop of a worse-billed person hang first', () => {
    const pw: Pathways = {
      movie: movie(1, 'Seed', 1999, 9000),
      cast: [
        {
          person: person(10, 'Lead', 3),
          role: 'Neo',
          order: 0,
          films: [movie(2, 'Obscure', 1991, 250)],
        },
        {
          person: person(11, 'Costar', 12),
          role: 'Trinity',
          order: 4,
          films: [movie(7, 'Famous', 2000, 20000)],
        },
      ],
    };
    const tree = buildTree(pw);
    const kids = [...tree.films.values()].filter((f) => f.parent === 'm:1');
    expect(kids[0].id).toBe('m:7');
    expect(tree.films.get('m:1')).toMatchObject({ relation: 'Costar' });
  });

  it('caps each person on a seed, not the whole map', () => {
    const pw = seedPathways();
    pw.cast[0].films = Array.from({ length: 20 }, (_, i) =>
      movie(100 + i, `Hit ${i}`, 1980 + i, 8000 - i),
    );
    const ofLead = [...buildTree(pw).films.values()].filter(
      (f) => f.relationPersonId === 'p:10' && !f.anchor,
    );
    expect(ofLead).toHaveLength(RULES.seedFilms);
  });

  it('refuses a seed with no year', () => {
    const pw = seedPathways();
    pw.movie = movie(1, 'Seed', undefined);
    expect(() => buildTree(pw)).toThrow(/release year/);
  });
});

describe('extendTree', () => {
  it('treats a blown-out film as a seed of its own', () => {
    const tree = buildTree(seedPathways());
    const pw: Pathways = {
      movie: movie(2, 'Hit A', 1991),
      cast: [
        {
          person: person(10, 'Lead', 20),
          role: 'X',
          order: 0,
          films: [movie(50, 'Lead F', 1988, 5000)],
        },
        {
          person: person(13, 'Other', 10),
          role: 'Y',
          order: 1,
          films: [movie(30, 'Other A', 1986, 4000), movie(31, 'Other B', 1987, 3500)],
        },
        {
          person: person(14, 'Third', 8),
          role: 'Z',
          order: 2,
          films: [movie(32, 'Third A', 1995, 3000)],
        },
      ],
    };
    expect(extendTree(tree, 'm:2', pw)).toBe(true);
    const kids = [...tree.films.values()].filter((f) => f.parent === 'm:2');
    expect(tree.films.has('m:50')).toBe(false);
    expect(kids.some((f) => f.id === 'm:30')).toBe(true);
    expect(kids.every((f) => f.depth === 2 && !f.trunk)).toBe(true);
    expect(extendTree(tree, 'm:2', pw)).toBe(false);
    expect(expandable(tree).map((f) => f.id)).not.toContain('m:2');
    expect(peopleFor(tree.films.get('m:1')!)).toBe(RULES.seedPeople);
    expect(peopleFor(tree.films.get('m:2')!)).toBe(RULES.stopPeople);
  });

  it('adds a network edge when a seed reaches a film already on the map', () => {
    const tree = buildTree(seedPathways());
    expect(tree.films.has('m:3')).toBe(true);
    const pw: Pathways = {
      movie: movie(7, 'Side A', 1979),
      cast: [
        {
          person: person(21, 'A', 10),
          role: 'x',
          order: 0,
          films: [movie(3, 'Hit B', 1994, 7000), movie(60, 'A1', 1980, 800)],
        },
      ],
    };
    expect(extendTree(tree, 'm:7', pw)).toBe(true);
    expect(tree.films.get('m:3')?.parent).toBe('m:1');
    expect(tree.links).toContainEqual({
      from: 'm:7',
      to: 'm:3',
      relation: 'A',
      relationPersonId: 'p:21',
      role: 'Role',
      billing: 1,
    });
    expect(tree.films.get('m:60')?.parent).toBe('m:7');
  });

  it('keeps blowing out a director who led to this seed', () => {
    const pw: Pathways = {
      movie: movie(1, 'Dr. Strangelove', 1964, 9000),
      cast: [
        {
          person: person(99, 'Stanley Kubrick', 6),
          role: 'Director',
          order: 0,
          films: [{ ...movie(41, 'A Clockwork Orange', 1971, 16000), role: 'Director' }],
        },
      ],
    };
    const tree = buildTree(pw);
    expect(extendTree(tree, 'm:41', {
      movie: movie(41, 'A Clockwork Orange', 1971),
      cast: [
        {
          person: person(99, 'Stanley Kubrick', 6),
          role: 'Director',
          order: 0,
          films: [
            { ...movie(1, 'Dr. Strangelove', 1964, 9000), role: 'Director' },
            { ...movie(43, 'Barry Lyndon', 1975, 4000), role: 'Director' },
          ],
        },
      ],
    })).toBe(true);
    expect(tree.films.get('m:43')).toMatchObject({
      relation: 'Stanley Kubrick',
      parent: 'm:41',
      role: 'Director',
    });
  });

  it('keeps blowing out at any depth', () => {
    const tree = buildTree(seedPathways());
    let parent = 'm:7';
    for (let depth = 1; depth <= 6; depth++) {
      const id = 100 + depth;
      const pw: Pathways = {
        movie: movie(Number(parent.slice(2)), 'p', 1990),
        cast: [
          {
            person: person(200 + depth, `Actor ${depth}`, 8),
            role: 'R',
            order: 0,
            films: [movie(id, `Deep ${depth}`, 1990 + depth, 2000)],
          },
        ],
      };
      expect(extendTree(tree, parent, pw)).toBe(true);
      parent = `m:${id}`;
    }
    expect(tree.films.get('m:106')?.depth).toBe(7);
  });

  it('ignores a stop that is not on the map', () => {
    const tree = buildTree(seedPathways());
    expect(
      extendTree(tree, 'm:999', { movie: movie(999, 'X', 2000), cast: [] }),
    ).toBe(false);
  });
});

describe('deepenTree', () => {
  it('hangs more of a person after a small expand, without duplicating cards', () => {
    const tree = buildTree(seedPathways());
    const many = Array.from({ length: 10 }, (_, i) =>
      movie(80 + i, `Other ${i}`, 1980 + i, 5000 - i * 10),
    );
    const pw: Pathways = {
      movie: movie(2, 'Hit A', 1991),
      cast: [
        {
          person: person(13, 'Other', 10),
          role: 'Y',
          order: 1,
          films: many,
        },
      ],
    };
    expect(extendTree(tree, 'm:2', pw)).toBe(true);
    const afterSmall = [...tree.films.values()].filter((f) => f.parent === 'm:2');
    expect(afterSmall).toHaveLength(RULES.stopFilms);
    expect(canDeepen(tree, 'm:2')).toBe(true);

    expect(deepenTree(tree, 'm:2', pw)).toBe(true);
    const ofOther = [...tree.films.values()].filter((f) => f.parent === 'm:2');
    expect(ofOther).toHaveLength(RULES.seedFilms);
    expect(new Set(ofOther.map((f) => f.id)).size).toBe(RULES.seedFilms);
    expect(tree.deepened.has('m:2')).toBe(true);
    expect(canDeepen(tree, 'm:2')).toBe(false);
    expect(deepenTree(tree, 'm:2', pw)).toBe(false);
  });

  it('links a title already on the map instead of placing a second card', () => {
    const tree = buildTree(seedPathways());
    expect(tree.films.has('m:3')).toBe(true);
    const pw: Pathways = {
      movie: movie(7, 'Side A', 1979),
      cast: [
        {
          person: person(21, 'A', 10),
          role: 'x',
          order: 0,
          films: [movie(3, 'Hit B', 1994, 7000), movie(60, 'A1', 1980, 800)],
        },
      ],
    };
    expect(deepenTree(tree, 'm:7', pw)).toBe(true);
    expect(tree.films.get('m:3')?.parent).toBe('m:1');
    expect(tree.links).toContainEqual({
      from: 'm:7',
      to: 'm:3',
      relation: 'A',
      relationPersonId: 'p:21',
      role: 'Role',
      billing: 1,
    });
    expect(tree.films.get('m:60')?.parent).toBe('m:7');
  });

  it('does not skip the inbound actor, unlike scroll expansion', () => {
    const tree = buildTree(seedPathways());
    const pw: Pathways = {
      movie: movie(2, 'Hit A', 1991),
      cast: [
        {
          person: person(10, 'Lead', 20),
          role: 'X',
          order: 0,
          films: [movie(50, 'Lead F', 1988, 5000)],
        },
        {
          person: person(13, 'Other', 10),
          role: 'Y',
          order: 1,
          films: [movie(30, 'Other A', 1986, 4000)],
        },
      ],
    };
    expect(extendTree(tree, 'm:2', pw)).toBe(true);
    expect(tree.films.has('m:50')).toBe(false);
    expect(deepenTree(tree, 'm:2', pw)).toBe(true);
    expect(tree.films.get('m:50')).toMatchObject({ parent: 'm:2', relation: 'Lead' });
  });

  it('refuses the searched film and unknown ids', () => {
    const tree = buildTree(seedPathways());
    const pw: Pathways = { movie: movie(1, 'Seed', 1999), cast: [] };
    expect(deepenTree(tree, 'm:1', pw)).toBe(false);
    expect(deepenTree(tree, 'm:999', pw)).toBe(false);
    expect(canDeepen(tree, 'm:1')).toBe(false);
  });
});
