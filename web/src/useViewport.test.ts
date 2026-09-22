import { describe, expect, it } from 'vitest';
import { viewportStepped } from './useViewport';

describe('viewportStepped', () => {
  const origin = { sx: 100, sy: 200, vw: 1200, vh: 800 };

  it('ignores sub-step camera movement', () => {
    expect(viewportStepped(origin, { ...origin, sx: 140, sy: 250 }, 96)).toBe(false);
  });

  it('fires after the camera has moved a step', () => {
    expect(viewportStepped(origin, { ...origin, sy: 300 }, 96)).toBe(true);
    expect(viewportStepped(origin, { ...origin, sx: 0 }, 96)).toBe(true);
  });

  it('always fires on a resize', () => {
    expect(viewportStepped(origin, { ...origin, vw: 800 }, 96)).toBe(true);
    expect(viewportStepped(origin, { ...origin, vh: 600 }, 96)).toBe(true);
  });
});
