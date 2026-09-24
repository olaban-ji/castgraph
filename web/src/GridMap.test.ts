import { describe, expect, it } from 'vitest';
import { opacityOf } from './GridMap';
import type { Placed } from './grid';

function card(): Placed {
  return {
    film: { id: 'tt0000001', year: 2000, rating: 7, md: 0, isAnchor: false },
    left: 0,
    top: 0,
    lane: 0,
  };
}

describe('opacityOf', () => {
  it('is full strength when nobody is being previewed or selected', () => {
    expect(opacityOf(card(), ['nm0000001'], new Set(), null)).toBe(1);
  });

  it('dims every card when the preview is a person who is not on this grid', () => {
    // A leftover hover from the film just left looks like this: the
    // pointer is in the search field, so nothing will clear it.
    expect(opacityOf(card(), ['nm0000001', 'nm0000002'], new Set(), 'nm0000099')).toBeLessThan(1);
  });

  it('keeps a card that holds the previewed person', () => {
    expect(opacityOf(card(), ['nm0000001', 'nm0000002'], new Set(), 'nm0000002')).toBe(1);
  });

  it('gives a card the benefit of the doubt until its detail arrives', () => {
    // Its place is already settled; only what it says is still coming,
    // so dimming it would be a guess that flickers when the words land.
    expect(opacityOf(card(), undefined, new Set(['nm0000009']), null)).toBe(1);
    expect(opacityOf(card(), undefined, new Set(), 'nm0000009')).toBe(1);
  });
});
