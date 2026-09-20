import { describe, expect, it } from 'vitest';
import { easeInOutCubic, glideDurationMs } from './glide';

describe('easeInOutCubic', () => {
  it('starts and ends at rest and is halfway at t = 0.5', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBe(0.5);
  });

  it('moves less than linearly at the start and end', () => {
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
  });
});

describe('glideDurationMs', () => {
  it('clamps short and long hops', () => {
    expect(glideDurationMs(0, 0)).toBe(560);
    expect(glideDurationMs(20_000, 0)).toBe(1400);
  });

  it('grows with distance inside the clamp', () => {
    expect(glideDurationMs(1000, 0)).toBeGreaterThan(glideDurationMs(200, 0));
    expect(glideDurationMs(1000, 0)).toBeLessThan(1400);
  });
});
