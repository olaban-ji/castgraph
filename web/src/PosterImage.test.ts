import { describe, expect, it } from 'vitest';
import { posterGaveUp } from './PosterImage';

const failed = {
  complete: true,
  naturalWidth: 0,
  naturalHeight: 0,
  currentSrc: '',
  loading: 'eager',
};

describe('posterGaveUp', () => {
  it('has given up when an eager fetch finished with no pixels', () => {
    // Safari's cached 404: complete, no pixels, and currentSrc left empty
    // because the error event already fired.
    expect(posterGaveUp(failed)).toBe(true);
    expect(posterGaveUp({ ...failed, currentSrc: 'https://m.media-amazon.com/images/M/gone.jpg' })).toBe(true);
  });

  it('is still in flight while the browser has not finished', () => {
    expect(posterGaveUp({ ...failed, complete: false })).toBe(false);
  });

  it('has the picture when there are pixels', () => {
    expect(posterGaveUp({ ...failed, naturalWidth: 92, naturalHeight: 138 })).toBe(false);
  });

  it('has not started when a lazy poster has no source yet', () => {
    expect(posterGaveUp({ ...failed, loading: 'lazy', currentSrc: '' })).toBe(false);
  });

  it('has given up when a lazy poster was fetched and came back empty', () => {
    expect(
      posterGaveUp({
        ...failed,
        loading: 'lazy',
        currentSrc: 'https://m.media-amazon.com/images/M/gone.jpg',
      }),
    ).toBe(true);
  });
});
