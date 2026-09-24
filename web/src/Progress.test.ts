import { describe, expect, it } from 'vitest';

// The progress line's shape is a CSS transition plus three timeouts; what
// is worth pinning here is that it never uses a frame, because a request
// begun in a hidden tab still has to finish its line.
describe('progress line', () => {
  const src = Object.values(
    import.meta.glob('./Progress.tsx', { query: '?raw', import: 'default', eager: true }),
  )[0] as string;

  it('waits on timers, never on frames', () => {
    expect(src).not.toContain('requestAnimationFrame');
    expect(src).toContain('setTimeout');
  });

  it('starts at a token width and finishes only when the answer lands', () => {
    expect(src).toContain('setWidth(8)');
    expect(src).toContain('setWidth(62)');
    expect(src).toContain('setWidth(100)');
  });
});
