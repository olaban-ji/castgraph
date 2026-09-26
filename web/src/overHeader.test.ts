import { describe, expect, it } from 'vitest';
import {
  APP_SCROLL_LIMIT_MS,
  APP_SCROLL_MS,
  APP_SCROLL_TAIL_MS,
  HEADER_SLOP,
  HIDE_AFTER,
  NO_APP_SCROLL,
  SHOW_WITHIN,
  appScrollAt,
  headerGoes,
  quietAt,
} from './overHeader';

describe('headerGoes', () => {
  it('uses the spec’s numbers', () => {
    expect(HEADER_SLOP).toBe(6);
    expect(HIDE_AFTER).toBe(80);
    expect(SHOW_WITHIN).toBe(40);
  });

  it('will not go near the top of the map', () => {
    // Going down this far says nothing: hiding the header here would
    // take the top of the map up with it.
    expect(headerGoes(0, 40)).toBeNull();
    expect(headerGoes(40, 80)).toBeNull();
  });

  it('goes once the reader is past 80 px and still going down', () => {
    expect(headerGoes(74, 81)).toBe(true);
    expect(headerGoes(200, 300)).toBe(true);
    // Exactly 80 is not past it.
    expect(headerGoes(40, 80)).toBeNull();
  });

  it('comes back on the way up', () => {
    expect(headerGoes(300, 200)).toBe(false);
  });

  it('comes back within 40 px of the top, whichever way the reader is going', () => {
    expect(headerGoes(300, 0)).toBe(false);
    expect(headerGoes(34, 39)).toBe(false);
    expect(headerGoes(40, 34)).toBe(false);
    // 40 itself is not within it.
    expect(headerGoes(38, 40)).toBeNull();
  });

  it('ignores a thumb that is barely moving', () => {
    expect(headerGoes(300, 300 + HEADER_SLOP)).toBeNull();
    expect(headerGoes(300, 300 - HEADER_SLOP)).toBeNull();
    expect(headerGoes(300, 300 + HEADER_SLOP + 1)).toBe(true);
    expect(headerGoes(300, 300 - HEADER_SLOP - 1)).toBe(false);
  });
});

describe('the app’s own scrolls', () => {
  it('gives a jump a moment and a glide most of a second', () => {
    expect(appScrollAt(1000, false).until).toBe(1000 + APP_SCROLL_MS.instant);
    expect(appScrollAt(1000, true).until).toBe(1000 + APP_SCROLL_MS.smooth);
    expect(APP_SCROLL_MS).toEqual({ smooth: 700, instant: 120 });
  });

  it('counts a scroll inside the window as the app’s', () => {
    expect(quietAt(appScrollAt(1000, false), 1050)).not.toBeNull();
    expect(quietAt(appScrollAt(1000, true), 1650)).not.toBeNull();
  });

  it('hands scrolling back to the reader once the window closes', () => {
    expect(quietAt(appScrollAt(1000, false), 1000 + APP_SCROLL_MS.instant)).toBeNull();
    expect(quietAt(appScrollAt(1000, true), 1000 + APP_SCROLL_MS.smooth)).toBeNull();
    expect(quietAt(NO_APP_SCROLL, 5)).toBeNull();
  });

  it('keeps the window open while a long glide is still moving', () => {
    // A smooth scroll the browser draws out past 700 ms keeps firing
    // events, and each one pushes the window a little further.
    let w = appScrollAt(0, true);
    for (let t = 0; t <= 1200; t += 16) {
      const next = quietAt(w, t);
      expect(next, `event at ${t} ms`).not.toBeNull();
      w = next!;
    }
    // Once it stops, the window closes a tail's length after its last
    // frame.
    expect(quietAt(w, 1200 + APP_SCROLL_TAIL_MS + 1)).toBeNull();
  });

  it('never holds the window open past its limit', () => {
    // A reader who grabs the map mid-glide scrolls too, and must get the
    // header's rules back however long they keep going.
    let w = appScrollAt(0, true);
    let t = 0;
    for (; t < 5000; t += 16) {
      const next = quietAt(w, t);
      if (!next) break;
      w = next;
    }
    expect(t).toBeLessThanOrEqual(APP_SCROLL_LIMIT_MS);
  });

  it('does not stretch a jump', () => {
    const w = quietAt(appScrollAt(0, false), 100)!;
    expect(w.until).toBe(APP_SCROLL_MS.instant);
  });
});
