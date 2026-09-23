import { describe, expect, it } from 'vitest';
import { opacityOf } from './GridMap';
import type { Placed } from './grid';

function card(people: number[]): Placed {
  return {
    film: { id: 1, title: 'X', year: 2000, rating: 7, people, isAnchor: false },
    left: 0,
    top: 0,
    lane: 0,
  };
}

describe('opacityOf', () => {
  it('is full strength when nobody is being previewed or selected', () => {
    expect(opacityOf(card([1]), new Set(), null)).toBe(1);
  });

  it('dims every card when the preview is a person who is not on this grid', () => {
    // A leftover hover from the film just left looks like this: the
    // pointer is in the search field, so nothing will clear it.
    expect(opacityOf(card([1, 2]), new Set(), 99)).toBeLessThan(1);
  });

  it('keeps a card that holds the previewed person', () => {
    expect(opacityOf(card([1, 2]), new Set(), 2)).toBe(1);
  });
});
