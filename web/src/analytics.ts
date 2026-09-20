const DEFAULT_HOST = 'https://us.i.posthog.com';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

type PostHog = typeof import('posthog-js').default;

let client: PostHog | null = null;
const queued: Array<(ph: PostHog) => void> = [];

function whenReady(fn: (ph: PostHog) => void): void {
  if (client) fn(client);
  else queued.push(fn);
}

function setClient(ph: PostHog): void {
  client = ph;
  const pending = queued.splice(0);
  for (const fn of pending) fn(ph);
}

function pageHostname(): string {
  return globalThis.window?.location?.hostname ?? '';
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

function tracingHostnames(): string[] {
  const hostname = pageHostname();
  if (!hostname || isLoopback(hostname)) return [];
  return [hostname];
}

function initClient(ph: PostHog, token: string, host: string): void {
  ph.init(token, {
    api_host: host,
    defaults: '2026-05-30',
    // Same-origin /api calls. Hostname only, never a port or URL.
    tracing_headers: tracingHostnames(),
  });
  setClient(ph);
}

/** Load PostHog in its own chunk so the map is not paying for it up front.
 *  Vite bakes VITE_* in at build time; otherwise the API's public config is
 *  used so production can take POSTHOG_* from the process environment.
 *  Loopback never initialises, so local sessions do not reach PostHog. */
export function initAnalytics(): void {
  if (isLoopback(pageHostname())) return;
  const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN as string | undefined;
  const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || DEFAULT_HOST;
  if (token) {
    void import('posthog-js')
      .then(({ default: posthog }) => initClient(posthog, token, host))
      .catch(() => {
        // Analytics is optional; a missing SDK should not break the map.
      });
    return;
  }
  void fetch('/api/analytics-config')
    .then((r) => (r.ok ? r.json() : null))
    .then(async (cfg: { token?: string; host?: string } | null) => {
      if (!cfg?.token) return;
      const { default: posthog } = await import('posthog-js');
      initClient(posthog, cfg.token, cfg.host || DEFAULT_HOST);
    })
    .catch(() => {
      // Analytics is optional; a missing API should not break the map.
    });
}

export function capture(...args: Parameters<PostHog['capture']>): void {
  whenReady((ph) => {
    ph.capture(...args);
  });
}

/** Headers for /api fetches that leave before posthog-js patches `fetch`. */
export function analyticsHeaders(): Record<string, string> {
  if (!client) return {};
  const headers: Record<string, string> = {};
  try {
    const distinctId = client.get_distinct_id();
    if (distinctId) headers['X-PostHog-Distinct-Id'] = distinctId;
    const sessionId = client.get_session_id();
    if (sessionId) headers['X-PostHog-Session-Id'] = sessionId;
  } catch {
    // SDK not initialised yet.
  }
  return headers;
}
