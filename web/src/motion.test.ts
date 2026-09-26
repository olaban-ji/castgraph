import { describe, expect, it } from 'vitest';
import css from './grid.css?raw';
import {
  AXIS_FADE_MS,
  BREATHE_AT_MS,
  CHIP_FLIP_MS,
  CHIP_IN_MS,
  COPY_FADE_MS,
  COPY_STEP_MS,
  EASE,
  FAST_PATH_MS,
  FLY_MS,
  FLY_SCALE,
  FOCUS_DELAY_MS,
  FOCUS_END_MS,
  FOCUS_KEYFRAMES,
  FOCUS_MS,
  GLIDE_MS,
  LAND_MS,
  LIFT_MS,
  LOADER_H,
  LOADER_W,
  MAP_FADE_MS,
  REFLOW_MS,
  ARRIVE_MS,
  ARRIVE_DELAY_MS,
  REVEAL_WINDOW_MS,
  SET_AT_MS,
  SPREAD_AFTER_LANDING_MS,
  SPREAD_MS,
  VEIL_AT_MS,
  VEIL_IN_MS,
  VEIL_OPACITY,
  VEIL_OUT_MS,
  chipInDelay,
  chipShift,
  flightTo,
  landingTransform,
  loaderSpot,
  markFlight,
  openingPlan,
  returnTileDelay,
  revealWindow,
  tileCaptionDelay,
  tileFillDelay,
} from './motion';
import { REVEAL_MAX_MS } from './grid';

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
});

describe('the curves', () => {
  it('are the stylesheet’s own, for the animations played from script', () => {
    // The stylesheet names them; element.animate cannot read var(), so
    // the same five are written again here and must not drift.
    const tokens: Record<string, string> = {
      glide: '--ease-glide',
      settle: '--ease-settle',
      exit: '--ease-exit',
      spread: '--ease-spread',
      focus: '--ease-focus',
    };
    for (const [name, prop] of Object.entries(tokens)) {
      const m = css.match(new RegExp(`${prop}:\\s*([^;]+);`));
      expect(m?.[1].trim(), prop).toBe(EASE[name as keyof typeof EASE]);
    }
  });
});

describe('the opening timeline', () => {
  it('matches the design’s numbers', () => {
    expect(FAST_PATH_MS).toBe(120);
    expect([COPY_FADE_MS, COPY_STEP_MS]).toEqual([600, 120]);
    expect([VEIL_OPACITY, VEIL_IN_MS, VEIL_OUT_MS]).toEqual([0.72, 420, 600]);
    expect([LOADER_W, LOADER_H]).toEqual([46, 70]);
    // In focus from 140 to 1060.
    expect([FOCUS_DELAY_MS, FOCUS_MS, FOCUS_END_MS]).toEqual([140, 920, 1060]);
    expect(GLIDE_MS).toBe(520);
  });

  it('racks the mark past sharp and back, ending exactly in focus', () => {
    expect(FOCUS_KEYFRAMES[0]).toMatchObject({ opacity: 0, filter: 'blur(14px)', transform: 'scale(1.45)' });
    expect(FOCUS_KEYFRAMES[1]).toMatchObject({ opacity: 1, offset: 0.62, transform: 'scale(0.985)' });
    expect(FOCUS_KEYFRAMES[2]).toMatchObject({ offset: 0.8, filter: 'blur(1.2px)', transform: 'scale(1.006)' });
    expect(FOCUS_KEYFRAMES[3]).toMatchObject({ opacity: 1, filter: 'blur(0px)', transform: 'scale(1)' });
  });

  it('skips everything for a list already in hand', () => {
    expect(openingPlan(0).fast).toBe(true);
    expect(openingPlan(119).fast).toBe(true);
    expect(openingPlan(120).fast).toBe(false);
  });

  it('holds the veil until a fast list has been ruled out', () => {
    // A list in hand within FAST_PATH_MS skips the sequence, veil and
    // all, so the veil cannot start rising any earlier than that.
    expect(VEIL_AT_MS).toBe(FAST_PATH_MS);
    // And it is still fully down before the mark has settled in focus.
    expect(VEIL_AT_MS + VEIL_IN_MS).toBeLessThan(FOCUS_END_MS);
  });

  it('lets the focus finish before the mark lifts off, however quick the list', () => {
    const plan = openingPlan(300);
    expect(plan.lift).toBe(1060);
    expect(plan.breathes).toBe(false);
  });

  it('lifts off the moment a slow list lands, and breathes until then', () => {
    const plan = openingPlan(2400);
    expect(plan.lift).toBe(2400);
    expect(plan.breathes).toBe(true);
    // The breathing starts just after the focus settles.
    expect(BREATHE_AT_MS).toBe(1120);
    expect(openingPlan(BREATHE_AT_MS).breathes).toBe(false);
  });

  it('times the posters, the word and the landing from the lift', () => {
    const { lift, tilesIn, word, done } = openingPlan(500);
    expect(tilesIn - lift).toBe(80);
    expect(word - lift).toBe(320);
    // The loader goes, and the header's mark appears, as the glide ends.
    expect(done - lift).toBe(GLIDE_MS);
  });

  it('brings each poster into focus in reading order', () => {
    // This replaces firstRun's TILE_STEP_MS of 40, whose test held all
    // eight within 320 ms: the fills were then a quick fade of colour.
    // They are a focus pull now, as the design times it, 70 ms apart,
    // so the eighth starts 510 ms in and its caption 600 ms in.
    expect(tileFillDelay(0)).toBe(20);
    expect(tileFillDelay(7)).toBe(20 + 7 * 70);
    expect(tileCaptionDelay(0)).toBe(110);
    expect(tileCaptionDelay(7)).toBe(110 + 7 * 70);
  });

  it('draws the poster stagger in the stylesheet from the same numbers', () => {
    // .cd-cold-fill and .cd-cold-meta write the delays as calc()s; this
    // keeps them saying what tileFillDelay and tileCaptionDelay say.
    expect(css).toContain('640ms var(--ease-settle) calc(20ms + var(--i, 0) * 70ms)');
    expect(css).toContain('400ms ease calc(110ms + var(--i, 0) * 70ms)');
  });

  it('raises the tiles in order on the way back from a map instead', () => {
    expect(returnTileDelay(0)).toBe(80);
    expect(returnTileDelay(3)).toBe(80 + 3 * 45);
  });
});

describe('loaderSpot', () => {
  it('centres the mark across the grid and down the part of it on screen', () => {
    // Grid from 300 to 1100 in a 900 tall window: visible from the first
    // frame (300) to the bottom of the window (900).
    expect(loaderSpot(box(400, 300, 640, 800), box(400, 300, 146, 219), 900)).toEqual({
      x: 720,
      y: 600,
    });
  });

  it('stops at the grid’s bottom when the whole grid is on screen', () => {
    expect(loaderSpot(box(20, 250, 350, 290), box(20, 250, 168, 252), 844)).toEqual({
      x: 195,
      y: 395,
    });
  });

  it('never sits closer than 48px to the bottom of the window', () => {
    // A grid that starts almost at the bottom of a short window.
    const at = loaderSpot(box(0, 360, 800, 400), box(0, 360, 90, 135), 390);
    expect(at?.y).toBe(390 - 48);
  });

  it('gives up on frames with no size, so the opening is skipped', () => {
    expect(loaderSpot(box(0, 0, 0, 0), box(0, 0, 0, 0), 900)).toBeNull();
  });
});

describe('markFlight', () => {
  it('flies centre to centre and shrinks to the slot’s width', () => {
    const f = markFlight(box(26, 21, 14.7, 22.5), { x: 720, y: 600 });
    expect(f.dx).toBeCloseTo(26 + 7.35 - 720);
    expect(f.dy).toBeCloseTo(21 + 11.25 - 600);
    expect(f.scale).toBeCloseTo(14.7 / 46);
  });
});

describe('the move to another map', () => {
  it('matches the design’s steps', () => {
    expect(LIFT_MS).toBe(240);
    expect([FLY_MS, FLY_SCALE]).toEqual([380, 1.14]);
    expect(SET_AT_MS).toBe(560);
    expect(LAND_MS).toBe(320);
    expect(SPREAD_AFTER_LANDING_MS).toBe(220);
    expect(MAP_FADE_MS).toBe(220);
  });

  it('flies the copy to the middle of the map the reader can see', () => {
    // A desktop map: the scroller is under a 114px header, nothing over it.
    const t = flightTo(box(1117, 576, 168, 90), box(0, 114, 1440, 786), 0);
    expect(1117 + 84 + t.tx).toBe(720);
    expect(576 + 45 + t.ty).toBe(114 + 393);
  });

  it('keeps clear of a header lying over the map on a phone', () => {
    // The phone's scroller starts at the top of the window, 116px of it
    // under the header: the middle is the middle of what is left.
    const t = flightTo(box(200, 500, 132, 72), box(0, 0, 390, 844), 116);
    expect(500 + 36 + t.ty).toBe(116 + (844 - 116) / 2);
    expect(200 + 66 + t.tx).toBe(195);
  });

  it('lands on the new card’s exact box, whatever its size', () => {
    const from = box(100, 100, 168, 90);
    const t = landingTransform(from, box(600, 400, 132, 72));
    expect(100 + 84 + t.tx).toBe(600 + 66);
    expect(100 + 45 + t.ty).toBe(400 + 36);
    expect(t.sx).toBeCloseTo(132 / 168);
    expect(t.sy).toBeCloseTo(72 / 90);
  });

  it('lands in place when the card is where the copy started', () => {
    expect(landingTransform(box(5, 5, 10, 10), box(5, 5, 10, 10))).toEqual({
      tx: 0,
      ty: 0,
      sx: 1,
      sy: 1,
    });
  });

  it('keeps the spread open long enough for the landing’s later start', () => {
    // A card's longest wait is 520 ms and its arrival 460 ms. A map a copy
    // lands on starts spreading 220 ms later, so its window is that much
    // longer, or the last cards would lose their timing mid-arrival.
    expect(SPREAD_MS).toBe(460);
    expect(revealWindow(0)).toBe(REVEAL_WINDOW_MS);
    expect(revealWindow(0)).toBeGreaterThanOrEqual(REVEAL_MAX_MS + SPREAD_MS);
    expect(revealWindow(SPREAD_AFTER_LANDING_MS)).toBeGreaterThanOrEqual(
      SPREAD_AFTER_LANDING_MS + REVEAL_MAX_MS + SPREAD_MS,
    );
    expect(AXIS_FADE_MS).toBe(280);
  });

  it('slides a shared chip from where it was, and staggers new ones behind', () => {
    expect(chipShift(box(300, 70, 120, 34), box(180, 70, 120, 34))).toEqual({ dx: 120, dy: 0 });
    expect([CHIP_FLIP_MS, CHIP_IN_MS]).toEqual([420, 260]);
    expect(chipInDelay(0)).toBe(260);
    expect(chipInDelay(4)).toBe(260 + 4 * 35);
  });
});

describe('the reflow', () => {
  it('moves cards over 260 ms and fades new ones in over 220 ms after 60 ms', () => {
    expect(REFLOW_MS).toBe(260);
    expect([ARRIVE_MS, ARRIVE_DELAY_MS]).toEqual([220, 60]);
    // The stylesheet's arrival transition says the same.
    expect(css).toMatch(/\.cd-card-arrive \{\s*transition:\s*opacity 0\.22s linear 0\.06s/);
  });
});
