import { describe, expect, it } from 'vitest';
import { PROGRESS } from './Progress';

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
    // The refresh's timeline: 6% at once, 70% after 30 ms, full width on
    // arrival, a fade 380 ms later and an empty line by 900 ms. It used
    // to start at 8% and crawl to 62%.
    expect(PROGRESS).toEqual({
      start: 6,
      crawl: 70,
      crawlAfterMs: 30,
      fadeAfterMs: 380,
      resetAfterMs: 900,
    });
    expect(src).toContain('setWidth(PROGRESS.start)');
    expect(src).toContain('setWidth(PROGRESS.crawl)');
    expect(src).toContain('setWidth(100)');
  });

  it('is gone before it is emptied, so it never visibly shrinks', () => {
    // The fade is .4s in the stylesheet.
    expect(PROGRESS.resetAfterMs).toBeGreaterThanOrEqual(PROGRESS.fadeAfterMs + 400);
  });
});
