import { describe, expect, it } from 'vitest';
import type { GridPayload } from './grid';
import { gridCache } from './gridCache';

/** A fetch whose answers the test hands out by hand. */
function fakeFetch() {
  const calls: { id: string; resolve: (p: GridPayload) => void; reject: (e: unknown) => void }[] = [];
  const fetch = (id: string) =>
    new Promise<GridPayload>((resolve, reject) => calls.push({ id, resolve, reject }));
  return { fetch, calls };
}

function payload(id: string): GridPayload {
  return {
    anchor: { id, title: id, year: 2000, rating: 7, md: 0, people: [], isAnchor: true },
    people: [],
    films: [[id, 2000, 7, 0, []]],
  };
}

/** Lets every settled promise's handlers run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('gridCache', () => {
  it('joins everyone asking for the same map onto one request', async () => {
    const { fetch, calls } = fakeFetch();
    const cache = gridCache(fetch);
    const first = cache.load('tt1');
    const second = cache.load('tt1');
    expect(calls.length).toBe(1);
    calls[0].resolve(payload('tt1'));
    await expect(first).resolves.toMatchObject({ anchor: { id: 'tt1' } });
    await expect(second).resolves.toMatchObject({ anchor: { id: 'tt1' } });
  });

  it('answers a second mount that joined after the first one moved on', async () => {
    // StrictMode in development: mount, clean up, mount again, all
    // before the answer. The first caller leaving must not cost the
    // second one the map — there is no signal for it to cancel with.
    const { fetch, calls } = fakeFetch();
    const cache = gridCache(fetch);
    let firstGaveUp = false;
    const firstMount = cache.load('tt1').then(() => {
      if (firstGaveUp) return 'ignored';
      return 'used';
    });
    firstGaveUp = true;
    const secondMount = cache.load('tt1');
    expect(calls.length).toBe(1);
    calls[0].resolve(payload('tt1'));
    await expect(secondMount).resolves.toMatchObject({ anchor: { id: 'tt1' } });
    await expect(firstMount).resolves.toBe('ignored');
    expect(cache.peek('tt1')).toBeDefined();
  });

  it('keeps an answer, so opening the map again does not ask', async () => {
    const { fetch, calls } = fakeFetch();
    const cache = gridCache(fetch);
    const first = cache.load('tt1');
    calls[0].resolve(payload('tt1'));
    await first;
    expect(cache.peek('tt1')?.anchor.id).toBe('tt1');
    await cache.load('tt1');
    expect(calls.length).toBe(1);
  });

  it('forgets a failure before anyone hears of it, so asking again is a new request', async () => {
    const { fetch, calls } = fakeFetch();
    const cache = gridCache(fetch);
    const failed = cache.load('tt1');
    calls[0].reject(new Error('500'));
    await expect(failed).rejects.toThrow('500');
    // By the time the caller has the error, the entry is gone.
    expect(cache.peek('tt1')).toBeUndefined();
    const retried = cache.load('tt1');
    expect(calls.length).toBe(2);
    calls[1].resolve(payload('tt1'));
    await expect(retried).resolves.toMatchObject({ anchor: { id: 'tt1' } });
  });

  it('drops the oldest map once it holds more than it keeps', async () => {
    const { fetch, calls } = fakeFetch();
    const cache = gridCache(fetch, 2);
    for (const id of ['tt1', 'tt2', 'tt3', 'tt4']) {
      const p = cache.load(id);
      calls[calls.length - 1].resolve(payload(id));
      await p;
    }
    await settle();
    expect(cache.peek('tt1')).toBeUndefined();
    expect(cache.peek('tt4')).toBeDefined();
  });
});
