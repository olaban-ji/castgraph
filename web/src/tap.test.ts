import { describe, expect, it } from 'vitest';
import { isOffScreen, isTap, OFF_EDGE, SCROLL_QUIET_MS, TAP_SLOP } from './tap';

describe('isTap', () => {
  it('takes a press that stayed put on a map that had stopped', () => {
    expect(isTap(false, 5000)).toBe(true);
  });

  it('refuses a press that travelled: that was a scroll', () => {
    expect(isTap(true, 5000)).toBe(false);
  });

  it('refuses the release that stops a flick', () => {
    expect(isTap(false, 0)).toBe(false);
    expect(isTap(false, SCROLL_QUIET_MS - 1)).toBe(false);
  });

  it('lets go the moment the quiet has been kept', () => {
    expect(isTap(false, SCROLL_QUIET_MS)).toBe(true);
  });

  it('has a slop worth having: a thumb is never still', () => {
    expect(TAP_SLOP).toBeGreaterThan(0);
  });
});

describe('isOffScreen', () => {
  const view = { left: 0, top: 0, width: 1000, height: 800 };

  it('is at home in the middle', () => {
    expect(isOffScreen(500, 400, view)).toBe(false);
  });

  it('is gone past any edge', () => {
    expect(isOffScreen(-10, 400, view)).toBe(true);
    expect(isOffScreen(1200, 400, view)).toBe(true);
    expect(isOffScreen(500, -10, view)).toBe(true);
    expect(isOffScreen(500, 900, view)).toBe(true);
  });

  it('counts the last few pixels of an edge as gone, so the button does not blink', () => {
    expect(isOffScreen(OFF_EDGE - 1, 400, view)).toBe(true);
    expect(isOffScreen(OFF_EDGE + 1, 400, view)).toBe(false);
  });

  it('measures against where the scroller is, not the plot', () => {
    const scrolled = { left: 0, top: 4000, width: 1000, height: 800 };
    expect(isOffScreen(500, 4400, scrolled)).toBe(false);
    expect(isOffScreen(500, 400, scrolled)).toBe(true);
  });
});
