import { describe, expect, it } from 'vitest';
import { RING_MS, opacityOf, ringDelay } from './GridMap';
import type { Placed } from './grid';

/** A card whose spine says it holds these places in the chip row. */
function card(people: number[] = []): Placed {
  return {
    film: { id: 'tt0000001', year: 2000, rating: 7, md: 0, people, isAnchor: false },
    left: 0,
    top: 0,
    lane: 0,
  };
}

describe('opacityOf', () => {
  it('is full strength when nobody is being previewed or selected', () => {
    expect(opacityOf(card([0]), new Set(), null)).toBe(1);
  });

  it('dims every card when the preview is a person who is not on this grid', () => {
    // A leftover hover from the film just left looks like this: the
    // pointer is in the search field, so nothing will clear it. The id
    // is not in this chip row, so its place is -1.
    expect(opacityOf(card([0, 1]), new Set(), -1)).toBeLessThan(1);
  });

  it('keeps a card that holds the previewed person', () => {
    expect(opacityOf(card([0, 1]), new Set(), 1)).toBe(1);
  });

  it('judges a card from the spine, before its detail has arrived', () => {
    // Who is on a card is known from the first paint. A card scrolled
    // into view under a selection is dim at once rather than lit until
    // its words land and then dimmed.
    expect(opacityOf(card([1]), new Set([0]), null)).toBeLessThan(1);
    expect(opacityOf(card([1]), new Set([1]), null)).toBe(1);
    expect(opacityOf(card([1]), new Set(), 0)).toBeLessThan(1);
  });
});

describe('the ring after a Recenter', () => {
  it('waits for the glide to land, then plays for 900 ms', () => {
    expect(ringDelay(false)).toBe(420);
    expect(RING_MS).toBe(900);
  });

  it('starts at once when the map jumps instead of gliding', () => {
    // With reduced motion asked for, the scroll is instant, so the
    // searched card is already where it was taken.
    expect(ringDelay(true)).toBe(0);
  });
});
