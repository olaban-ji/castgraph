import { describe, expect, it } from 'vitest';
import { ANCHOR_LIFT, DIM_LIFT, RING_MS, opacityOf, ringDelay, spreadDelays } from './GridMap';
import type { Placed } from './grid';

/** A card whose spine says it holds these places in the chip row. */
function card(people: number[] = [], id = 'tt0000001', isAnchor = false): Placed {
  return {
    film: { id, year: 2000, rating: 7, md: 0, people, isAnchor },
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

describe('opacityOf while a card is lifted to be mapped next', () => {
  it('lights only the lifted card and steps the rest back to .3', () => {
    expect(DIM_LIFT).toBe(0.3);
    expect(opacityOf(card([0], 'tt1'), new Set(), null, null, 'tt1')).toBe(1);
    expect(opacityOf(card([0], 'tt2'), new Set(), null, null, 'tt1')).toBe(DIM_LIFT);
  });

  it('dims the searched film too, a little less than the rest', () => {
    // It is about to stop being the searched film; the design draws it
    // at .45 with its tag while the lift is on.
    expect(ANCHOR_LIFT).toBe(0.45);
    expect(opacityOf(card([], 'tt9', true), new Set(), null, null, 'tt1')).toBe(ANCHOR_LIFT);
  });

  it('outranks a selection, a floor and a preview', () => {
    // A card the filters had dimmed is still the one the reader tapped.
    const tapped = card([2], 'tt1');
    expect(opacityOf(tapped, new Set([0]), 0, 9, 'tt1')).toBe(1);
    // And a card they had lit steps back with the rest.
    expect(opacityOf(card([0], 'tt2'), new Set([0]), null, null, 'tt1')).toBe(DIM_LIFT);
  });

  it('changes nothing when no card is lifted', () => {
    expect(opacityOf(card([], 'tt9', true), new Set([0]), null, 8)).toBe(1);
    expect(opacityOf(card([1]), new Set([0]), null, null, null)).toBeLessThan(1);
  });
});

describe('spreadDelays', () => {
  it('delays the arrival only, never hover or lift', () => {
    // One delay per transition .cd-card-entering lists: opacity and
    // transform wait their turn; translate, box-shadow and background do
    // not, so a card answers the pointer even mid-spread.
    expect(spreadDelays(340)).toBe('340ms, 340ms, 0s, 0s, 0s');
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
