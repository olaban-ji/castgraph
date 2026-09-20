import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const init = vi.fn();
const captureEvent = vi.fn();
const getDistinctId = vi.fn(() => 'distinct-1');
const getSessionId = vi.fn(() => 'session-1');

vi.mock('posthog-js', () => ({
  default: {
    init,
    capture: captureEvent,
    get_distinct_id: getDistinctId,
    get_session_id: getSessionId,
  },
}));

describe('analytics', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubGlobal('window', { location: { hostname: 'map.example' } });
    init.mockClear();
    captureEvent.mockClear();
    getDistinctId.mockClear();
    getSessionId.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the SDK from a baked token and flushes queued captures', async () => {
    vi.stubEnv('VITE_POSTHOG_PROJECT_TOKEN', 'phc_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://example.posthog.com');
    const { initAnalytics, capture, analyticsHeaders } = await import('./analytics');

    capture('movie_selected', { movie_id: 603, title: 'The Matrix' });
    expect(captureEvent).not.toHaveBeenCalled();
    expect(analyticsHeaders()).toEqual({});

    initAnalytics();
    await vi.waitFor(() => expect(init).toHaveBeenCalledTimes(1));

    expect(init).toHaveBeenCalledWith('phc_test', {
      api_host: 'https://example.posthog.com',
      defaults: '2026-05-30',
      tracing_headers: ['map.example'],
    });
    expect(captureEvent).toHaveBeenCalledWith('movie_selected', {
      movie_id: 603,
      title: 'The Matrix',
    });
    expect(analyticsHeaders()).toEqual({
      'X-PostHog-Distinct-Id': 'distinct-1',
      'X-PostHog-Session-Id': 'session-1',
    });
  });

  it('does not load the SDK when no token is available', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    const { initAnalytics, capture } = await import('./analytics');

    initAnalytics();
    capture('movie_selected', { movie_id: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith('/api/analytics-config');
    expect(init).not.toHaveBeenCalled();
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it('loads the SDK from the API config when no token is baked in', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'phc_from_api', host: 'https://api.posthog.com' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { initAnalytics, capture } = await import('./analytics');

    initAnalytics();
    capture('movie_selected', { movie_id: 7 });
    await vi.waitFor(() => expect(init).toHaveBeenCalledTimes(1));

    expect(init).toHaveBeenCalledWith('phc_from_api', {
      api_host: 'https://api.posthog.com',
      defaults: '2026-05-30',
      tracing_headers: ['map.example'],
    });
    expect(captureEvent).toHaveBeenCalledWith('movie_selected', { movie_id: 7 });
  });

  it('does not load the SDK on localhost', async () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    vi.stubEnv('VITE_POSTHOG_PROJECT_TOKEN', 'phc_test');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { initAnalytics, capture, analyticsHeaders } = await import('./analytics');

    initAnalytics();
    capture('movie_selected', { movie_id: 1 });
    await Promise.resolve();

    expect(init).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captureEvent).not.toHaveBeenCalled();
    expect(analyticsHeaders()).toEqual({});
  });
});
