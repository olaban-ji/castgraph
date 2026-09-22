import { describe, expect, it } from 'vitest';
import { GEOMETRY } from './layout';
import {
  clampZoom,
  fitZoom,
  fontPx,
  MIN_TEXT_PX,
  pinchScale,
  pointerDistance,
  textIsCapped,
  zoomAfterWheel,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from './zoom';

describe('fitZoom', () => {
  it('is one zoom-out click looser than a tight desktop fit', () => {
    // Tight fit on 1680×1000 is ~0.8; one − click → ~0.70. A first screen
    // with a dozen readable films beats one with forty unreadable ones.
    expect(fitZoom(1680, 1000, GEOMETRY.desktop)).toBeCloseTo(0.8 / ZOOM_STEP, 2);
  });

  it('opens closer in than the old two-click default', () => {
    const now = fitZoom(1680, 1000, GEOMETRY.desktop);
    expect(now).toBeGreaterThan(0.8 / ZOOM_STEP ** 2);
  });

  it('still keeps a phone above the zoom floor', () => {
    expect(fitZoom(390, 700, GEOMETRY.phone)).toBeGreaterThanOrEqual(ZOOM_MIN);
  });

  it('zooms a small laptop out further than a large desktop', () => {
    const laptop = fitZoom(1280, 800, GEOMETRY.desktop);
    const desktop = fitZoom(1920, 1080, GEOMETRY.desktop);
    expect(laptop).toBeLessThan(desktop);
  });

  it('stays inside the zoom clamp', () => {
    expect(fitZoom(200, 200, GEOMETRY.phone)).toBeGreaterThanOrEqual(ZOOM_MIN);
    expect(fitZoom(4000, 2000, GEOMETRY.desktop)).toBeLessThanOrEqual(ZOOM_MAX);
  });
});

describe('zoomAfterWheel', () => {
  it('moves a little for a small pixel tick', () => {
    const z = zoomAfterWheel(1, 10);
    expect(z).toBeLessThan(1);
    expect(z).toBeGreaterThan(0.96);
  });

  it('does not leap on a burst of trackpad events', () => {
    let z = 1;
    for (let i = 0; i < 20; i++) z = zoomAfterWheel(z, 8);
    expect(z).toBeGreaterThan(0.6);
    expect(z).toBeLessThan(0.96);
  });

  it('clamps at the ends', () => {
    expect(zoomAfterWheel(ZOOM_MIN, 800)).toBe(ZOOM_MIN);
    expect(zoomAfterWheel(ZOOM_MAX, -800)).toBe(ZOOM_MAX);
  });
});

describe('clampZoom', () => {
  it('pins to the allowed range', () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(3)).toBe(ZOOM_MAX);
    expect(clampZoom(1)).toBe(1);
  });
});

describe('fontPx', () => {
  it('shrinks with the card while the result stays readable', () => {
    expect(fontPx(19, 1, 1)).toBe(19);
    expect(fontPx(19, 0.8, 1)).toBeCloseTo(15.2);
  });

  it('holds the rendered size at the minimum while the counter-scale has room', () => {
    // A 19px trunk title on a tablet card at 0.7 zoom would render at
    // 7.8px; counter-scaling lifts it back to the floor.
    for (const zoom of [1, 0.9, 0.8, 0.7, 0.65]) {
      const rendered = fontPx(19, 0.588, zoom) * zoom;
      expect(rendered).toBeGreaterThanOrEqual(MIN_TEXT_PX - 0.01);
    }
  });

  it('below the counter-scale cap the card keeps only its title', () => {
    // Past 1.6× the text would outgrow the card, so the card sheds its
    // metadata row rather than growing: the title is what is left.
    expect(textIsCapped(0.6)).toBe(true);
    expect(fontPx(19, 0.588, 0.6)).toBe(MIN_TEXT_PX * 1.6);
  });

  it('caps the counter-scale so text cannot outgrow its card', () => {
    const tiny = fontPx(10, 0.5, 0.1);
    expect(tiny).toBeLessThanOrEqual(MIN_TEXT_PX * 1.6);
  });
});

describe('textIsCapped', () => {
  it('is false at everyday zooms and true once the cap is reached', () => {
    expect(textIsCapped(1)).toBe(false);
    expect(textIsCapped(0.8)).toBe(false);
    expect(textIsCapped(0.5)).toBe(true);
  });
});

describe('pinch', () => {
  it('is the ratio of finger distance to where the gesture began', () => {
    expect(pinchScale(100, 150)).toBeCloseTo(1.5);
    expect(pinchScale(100, 50)).toBeCloseTo(0.5);
  });

  it('is inert before a gesture has a starting distance', () => {
    expect(pinchScale(0, 200)).toBe(1);
  });

  it('measures two pointers', () => {
    expect(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
