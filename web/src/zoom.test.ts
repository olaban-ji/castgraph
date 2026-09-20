import { describe, expect, it } from 'vitest';
import { GEOMETRY } from './layout';
import { clampZoom, fitZoom, zoomAfterWheel, ZOOM_MAX, ZOOM_MIN } from './zoom';

describe('fitZoom', () => {
  it('is two zoom-out clicks looser than a tight desktop fit', () => {
    // Tight fit on 1680×1000 is ~0.8; two − clicks → ~0.60
    expect(fitZoom(1680, 1000, GEOMETRY.desktop)).toBeCloseTo(0.8 / 1.15 ** 2, 2);
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
