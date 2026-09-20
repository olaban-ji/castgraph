import posthog from 'posthog-js';

export { posthog };

const DEFAULT_HOST = 'https://us.i.posthog.com';

/** Start PostHog if a project token is available. Vite bakes VITE_* in at
 *  build time; otherwise the API's public config is used so production can
 *  take POSTHOG_* from the process environment. */
export function initAnalytics(): void {
  const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN as string | undefined;
  const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || DEFAULT_HOST;
  if (token) {
    posthog.init(token, { api_host: host, defaults: '2026-05-30' });
    return;
  }
  void fetch('/api/analytics-config')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg: { token?: string; host?: string } | null) => {
      if (!cfg?.token) return;
      posthog.init(cfg.token, {
        api_host: cfg.host || DEFAULT_HOST,
        defaults: '2026-05-30',
      });
    })
    .catch(() => {
      // Analytics is optional; a missing API should not break the map.
    });
}

/** Tracing headers so server-side captures share the browser distinct ID. */
export function analyticsHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const distinctId = posthog.get_distinct_id();
    if (distinctId) headers['X-PostHog-Distinct-Id'] = distinctId;
    const sessionId = posthog.get_session_id();
    if (sessionId) headers['X-PostHog-Session-Id'] = sessionId;
  } catch {
    // SDK not initialised yet.
  }
  return headers;
}
