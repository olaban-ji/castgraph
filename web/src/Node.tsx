import { memo, useCallback, type CSSProperties, type KeyboardEvent } from 'react';
import type { Geometry, PlacedFilm } from './layout';
import { typeScale } from './layout';
import { fontPx, textIsCapped } from './zoom';

interface Props {
  film: PlacedFilm;
  g: Geometry;
  /** Page scale; applied per-card so the stage itself is never a giant layer. */
  zoom: number;
  /** This film is the one question being answered: its edges are lit and
   *  its card shows the connection and the explore action. */
  active: boolean;
  /** This card stands on the route currently being traced. */
  onRoute?: boolean;
  /** What the traced person did in this film, when they were in it. */
  traceLabel?: string;
  /** Tab order position, so keyboard travel follows the map in year order. */
  tabIndex?: number;
  /** Edges of this film too long to draw at rest. */
  longEdges?: number;
  onActivate?: (filmId: string, x: number, y: number) => void;
  onDeactivate?: (filmId: string) => void;
  /** Search-sized blow-out of this card into the current map. */
  onDeepen?: (filmId: string) => void;
  /** Already blown out: clicking re-anchors the map here. */
  onReanchor?: (filmId: string) => void;
  /** Card tapped: opens the detail sheet (phone, and the keyboard path). */
  onOpen?: (filmId: string) => void;
  deepening?: boolean;
  /** This card's connections are held lit. */
  locked?: boolean;
  /** Shares an edge with the locked card. */
  linked?: boolean;
  onLock?: (filmId: string) => void;
  /** Glide this card out from the anchor. Page pixels, from its own slot. */
  bloom?: { x: number; y: number } | null;
  onBloomEnd?: () => void;
}

/** One stop on the map: a location pin on the route and the card above it.
 *  The card is one of three tiers — anchor, trunk, branch — that carry
 *  less detail the further they sit from the anchor. The whole node is one
 *  button: pointing at it asks "how is this connected?", pressing it grows
 *  the map from here. */
export const Node = memo(function Node({
  film: m,
  g,
  zoom,
  active,
  onRoute,
  traceLabel,
  tabIndex,
  longEdges = 0,
  onActivate,
  onDeactivate,
  onDeepen,
  onReanchor,
  onOpen,
  deepening,
  locked,
  linked,
  onLock,
  bloom,
  onBloomEnd,
}: Props) {
  const k = typeScale(g);
  const fs = (px: number) => Math.round(fontPx(px, k, zoom));
  const terse = textIsCapped(zoom);
  const pad = m.anchor ? Math.round(18 * k) : Math.round(14 * k);
  const posterH = m.anchor ? m.h - pad * 2 : Math.round((m.h - pad * 2) * 0.86);
  const posterW = Math.round(posterH / 1.5);
  const imdb = m.movie.imdb_rating;
  const tmdb = m.movie.rating;
  const rating = compactRating(m.movie);
  // On a trace the card says what the traced person did here, which is
  // the question being asked, rather than how the card came to be placed.
  const connection = traceLabel ?? connectionLabel(m);

  const press = useCallback(() => {
    if (onDeepen) onDeepen(m.id);
    else if (onReanchor) onReanchor(m.id);
  }, [onDeepen, onReanchor, m.id]);

  const handlers = {
    role: 'button' as const,
    tabIndex: tabIndex ?? 0,
    'aria-label': cardLabel(m, connection),
    onMouseEnter: (ev: { clientX: number; clientY: number }) => onActivate?.(m.id, ev.clientX, ev.clientY),
    onMouseMove: (ev: { clientX: number; clientY: number }) => onActivate?.(m.id, ev.clientX, ev.clientY),
    onMouseLeave: () => onDeactivate?.(m.id),
    onFocus: (ev: { currentTarget: Element }) => {
      const r = ev.currentTarget.getBoundingClientRect();
      onActivate?.(m.id, r.left + r.width / 2, r.top);
    },
    onBlur: () => onDeactivate?.(m.id),
    // Pressing the card asks who is in it: the sheet names the cast and
    // the director so either can be followed through the map, and carries
    // "Explore from here" as its primary action. Growing the map straight
    // from the card stays one click away on the pill, which is already
    // under the pointer by the time the card is active.
    onClick: () => (onOpen ? onOpen(m.id) : press()),
    onKeyDown: (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      if (onOpen) onOpen(m.id);
      else press();
    },
  };

  const lock = active && onLock ? (
    <LockButton filmId={m.id} locked={!!locked} onLock={onLock} />
  ) : null;
  const explore = active && (onDeepen || deepening) ? (
    <ExploreButton
      filmId={m.id}
      label={exploreLabel(m.w, fs(12))}
      height={Math.max(24, Math.round(28 * k))}
      fontSize={fs(12)}
      onDeepen={onDeepen}
      deepening={deepening}
    />
  ) : null;
  const more = longEdges > 0 ? (
    <span className="mc-more" style={{ fontSize: fs(10) }}>+{longEdges} more</span>
  ) : null;

  return (
    <div
      className={`mc-node${active ? ' mc-node-active' : ''}${locked ? ' mc-node-locked' : ''}${linked ? ' mc-node-linked' : ''}${onRoute ? ' mc-node-route' : ''}${bloom ? ' mc-bloom' : ''}`}
      style={nodeStyle(m, g, zoom, bloom)}
      onAnimationEnd={bloom ? (ev) => { if (ev.target === ev.currentTarget) onBloomEnd?.(); } : undefined}
    >
      {m.tier === 'branch' ? (
        <div
          className="mc-card mc-branch"
          style={{ left: 0, top: 0, width: m.w, height: m.h, borderRadius: Math.round(10 * k) }}
          title={`${m.movie.label} (${m.year})`}
          {...handlers}
        >
          <Poster film={m} w={m.w} h={m.h} radius={0} wide />
          <div className="mc-branch-chip" style={{ top: Math.round(7 * k), right: Math.round(7 * k), gap: Math.round(5 * k) }}>
            <span className="mc-year mc-branch-year" style={{ fontSize: fs(10) }}>{m.year}</span>
            {rating ? (
              <span className="mc-rating-compact" style={{ fontSize: fs(11) }} title={`${rating.source} rating`}>
                {rating.value.toFixed(1)}
              </span>
            ) : null}
          </div>
          <div className="mc-branch-title" style={{ padding: Math.round(9 * k) }}>
            <div className="mc-title mc-title-branch" style={{ fontSize: fs(14) }}>{m.movie.label}</div>
            {connection ? (
              <div className="mc-connection" style={{ fontSize: fs(11) }}>{connection}</div>
            ) : null}
            {terse ? null : more}
          </div>
          {lock}
          {explore}
        </div>
      ) : (
        <div
          className={`mc-card${m.anchor ? ' mc-anchor' : ' mc-card-trunk'}`}
          style={{ left: 0, top: 0, width: m.w, height: m.h, padding: pad, gap: Math.round(14 * k), borderRadius: Math.round(14 * k) }}
          title={`${m.movie.label} (${m.year})`}
          {...handlers}
        >
          <Poster film={m} w={posterW} h={posterH} radius={Math.round(7 * k)} />
          <div className="mc-card-body" style={{ gap: Math.round((m.anchor ? 10 : 6) * k) }}>
            {m.anchor ? (
              <>
                <div className="mc-eyebrow" style={{ fontSize: fs(11) }}>{m.year}</div>
                <div className="mc-title mc-title-anchor" style={{ fontSize: fs(titleSize(m.movie.label)) }}>{m.movie.label}</div>
                {terse ? null : (
                  <div className="mc-pills" style={{ gap: Math.round(8 * k) }}>
                    {imdb ? (
                      <div className="mc-pill" style={{ padding: `${Math.round(3 * k)}px ${Math.round(9 * k)}px`, gap: Math.round(6 * k) }}>
                        <span className="mc-pill-label" style={{ fontSize: fs(10) }}>IMDb</span>
                        <span className="mc-pill-value" style={{ fontSize: fs(14) }}>{imdb.toFixed(1)}</span>
                      </div>
                    ) : null}
                    {tmdb ? (
                      <div className="mc-pill" style={{ padding: `${Math.round(3 * k)}px ${Math.round(9 * k)}px`, gap: Math.round(6 * k) }}>
                        <span className="mc-pill-label" style={{ fontSize: fs(10) }}>TMDb</span>
                        <span className="mc-pill-value" style={{ fontSize: fs(14) }}>{tmdb.toFixed(1)}</span>
                      </div>
                    ) : null}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="mc-title mc-title-trunk" style={{ fontSize: fs(18) }}>{m.movie.label}</div>
                {/* Counter-scaled text past its cap would outgrow the card,
                    so the metadata row goes — but never the connection,
                    which is the answer the card exists to give. */}
                {terse ? null : (
                  <div className="mc-meta">
                    <span className="mc-year" style={{ fontSize: fs(12) }}>{m.year}</span>
                    {rating ? (
                      <span className="mc-rating-compact" style={{ fontSize: fs(12) }} title={`${rating.source} rating`}>
                        {rating.value.toFixed(1)}
                      </span>
                    ) : null}
                  </div>
                )}
                {connection ? (
                  <div className="mc-connection" style={{ fontSize: fs(11) }}>{connection}</div>
                ) : null}
                {terse ? null : more}
              </>
            )}
          </div>
          {lock}
          {explore}
        </div>
      )}
      <MapPin film={m} g={g} cardW={m.w} cardH={m.h} />
    </div>
  );
});

/** How this film reaches the one it hangs from: the person, and what they
 *  did in it. The API has returned this all along and the card never
 *  showed it, leaving the map's one question unanswered. */
export function connectionLabel(m: Pick<PlacedFilm, 'relation' | 'role' | 'anchor'>): string {
  if (m.anchor || !m.relation) return '';
  if (m.role === 'Director') return `${m.relation} · directed`;
  return m.role ? `${m.relation} · ${m.role}` : m.relation;
}

function cardLabel(m: PlacedFilm, connection: string): string {
  const base = `${m.movie.label}, ${m.year}`;
  return connection ? `${base}. Connected by ${connection.replace(' · ', ', ')}` : base;
}

/** The label the card can actually hold. Counter-scaled text on a narrow
 *  branch card is large relative to its box, and a call to action that
 *  runs off the edge of the card reads as damage. */
export function exploreLabel(cardW: number, fontSize: number): string {
  const room = cardW - 16 - 20; // card padding either side, then the pill's
  // Work Sans at these sizes averages a little over half the em per glyph.
  const fits = (text: string) => text.length * fontSize * 0.55 <= room;
  if (fits('Explore from here →')) return 'Explore from here →';
  if (fits('Explore →')) return 'Explore →';
  return '→';
}

/** Holds this card's connections lit. Shown with the explore pill, on the
 *  card the pointer is already asking about. */
export function LockButton({
  filmId,
  locked,
  onLock,
  className,
}: {
  filmId: string;
  locked: boolean;
  onLock: (filmId: string) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`mc-lock${locked ? ' mc-lock-on' : ''}${className ? ` ${className}` : ''}`}
      aria-pressed={locked}
      aria-label={locked ? 'Unlock this movie' : 'Lock this movie'}
      title={locked ? 'Unlock' : 'Lock connections'}
      onPointerDown={(ev) => ev.stopPropagation()}
      onClick={(ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        onLock(filmId);
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {locked ? (
          <>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </>
        ) : (
          <>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 7.5-2" />
          </>
        )}
      </svg>
    </button>
  );
}

/** Search-sized blow-out from this card. A labelled pill, not an icon:
 *  it appears only on the active card, where there is room to say what it
 *  does. */
function ExploreButton({
  filmId,
  label,
  height,
  fontSize,
  onDeepen,
  deepening,
}: {
  filmId: string;
  label: string;
  height: number;
  fontSize: number;
  onDeepen?: (filmId: string) => void;
  deepening?: boolean;
}) {
  return (
    <button
      type="button"
      className={`mc-explore${deepening ? ' mc-explore-busy' : ''}`}
      aria-label="Explore from here"
      style={{ height, fontSize }}
      disabled={!!deepening || !onDeepen}
      onPointerDown={(ev) => ev.stopPropagation()}
      onClick={(ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        onDeepen?.(filmId);
      }}
    >
      {deepening ? (
        <span className="mc-explore-spin" aria-hidden="true" />
      ) : (
        label
      )}
    </button>
  );
}

/** Place a card in page pixels. Zoom is a per-node scale so Safari never
 *  allocates a compositor layer the size of the whole timeline. The box
 *  covers the pin as well as the card, so the whole node is one target. */
export function placeStyle(m: PlacedFilm, g: Geometry, zoom: number): CSSProperties {
  return {
    left: (m.x - m.w / 2) * zoom,
    top: (m.y - g.stem - m.h) * zoom,
    width: m.w,
    height: m.h + g.stem,
    transform: zoom === 1 ? undefined : `scale(${zoom})`,
    transformOrigin: '0 0',
  };
}

/** Page-pixel shift from this card's slot back to the anchor's, so the
 *  card can start there and glide out. */
export function bloomShift(film: PlacedFilm, anchor: PlacedFilm, stem: number, zoom: number): { x: number; y: number } {
  return {
    x: ((anchor.x - anchor.w / 2) - (film.x - film.w / 2)) * zoom,
    y: ((anchor.y - stem - anchor.h) - (film.y - stem - film.h)) * zoom,
  };
}

function nodeStyle(
  m: PlacedFilm,
  g: Geometry,
  zoom: number,
  bloom?: { x: number; y: number } | null,
): CSSProperties {
  const style = placeStyle(m, g, zoom);
  if (!bloom) return style;
  return {
    ...style,
    ['--bloom-x' as string]: `${bloom.x}px`,
    ['--bloom-y' as string]: `${bloom.y}px`,
    ['--bloom-delay' as string]: `${Math.min(160, Math.round(Math.hypot(bloom.x, bloom.y) * 0.045))}ms`,
  };
}

/** Teardrop map marker. Tip sits on the route at the film's year; the head
 *  tucks under the card so the card reads as pinned to the map, not as
 *  another gold line dropping onto the path. */
function MapPin({ film: m, g, cardW, cardH }: { film: PlacedFilm; g: Geometry; cardW: number; cardH: number }) {
  const overlap = m.anchor ? 6 : 4;
  const h = g.stem + overlap;
  const w = Math.max(14, Math.round(h * 0.58));
  const kind = m.anchor ? 'anchor' : m.trunk ? 'trunk' : 'branch';
  return (
    <svg
      className={`mc-pin mc-pin-${kind}`}
      width={w}
      height={h}
      viewBox="0 0 24 36"
      style={{ left: Math.round((cardW - w) / 2), top: Math.round(cardH - overlap) }}
      aria-hidden="true"
    >
      <ellipse className="mc-pin-ground" cx="12" cy="34.6" rx="4.2" ry="1.35" />
      <path d="M12 0C5.37 0 0 5.46 0 12.2 0 21.15 12 36 12 36s12-14.85 12-23.8C24 5.46 18.63 0 12 0z" />
      <circle className="mc-pin-hole" cx="12" cy="12.2" r="4.6" />
    </svg>
  );
}

/** Prefer IMDb when we have it; otherwise TMDb. Null if neither is set. */
export function compactRating(movie: { imdb_rating?: number; rating?: number }): { value: number; source: 'IMDb' | 'TMDb' } | null {
  if (movie.imdb_rating != null) return { value: movie.imdb_rating, source: 'IMDb' };
  if (movie.rating != null) return { value: movie.rating, source: 'TMDb' };
  return null;
}

/** The anchor title is set large, but not so large that the title does
 *  not fit its card: long titles step down, and the CSS allows two lines. */
export function titleSize(title: string): number {
  if (title.length <= 9) return 30;
  if (title.length <= 16) return 24;
  return 19;
}

/** TMDb resize buckets that work for both posters and backdrops. */
const TMDB_WIDTHS = [92, 154, 185, 342, 500, 780, 1280] as const;

/** Rewrite a TMDb image URL to the smallest bucket that covers `cssPx`
 *  at `dpr` (capped at 2× so a 3× phone does not decode a w780 for a
 *  110 px branch card). Non-TMDb URLs pass through. */
export function sizedTmdbUrl(url: string | undefined, cssPx: number, dpr = 2): string | undefined {
  if (!url) return;
  if (!/\/t\/p\/w\d+\//.test(url)) return url;
  const need = Math.ceil(Math.max(1, cssPx) * Math.min(Math.max(dpr, 1), 2));
  const w = TMDB_WIDTHS.find((s) => s >= need) ?? 1280;
  return url.replace(/\/t\/p\/w\d+\//, `/t/p/w${w}/`);
}

/** A movie image. Wide tiles use the landscape backdrop when TMDb has one;
 *  a portrait poster in a landscape box is cropped to its top, where a
 *  poster's title usually is, rather than its middle. */
function Poster({ film, w, h, radius, wide = false }: { film: PlacedFilm; w: number; h: number; radius: number; wide?: boolean }) {
  const style = { width: w, height: h, borderRadius: radius, ['--poster-colour' as string]: colourFor(film.movie.label) };
  const raw = wide ? film.movie.backdrop ?? film.movie.poster : film.movie.poster;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 2;
  const src = sizedTmdbUrl(raw, w, dpr);
  if (src) {
    const position = wide && !film.movie.backdrop ? 'center top' : 'center';
    return <img className="mc-poster" src={src} alt="" width={w} height={h} decoding="async" style={{ ...style, objectPosition: position }} />;
  }
  return <div className="mc-poster" style={style} />;
}

/** A stable, muted colour per title for films with no poster art. */
export function colourFor(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 28% 22%)`;
}

/** A placeholder in the loading band: same footprint, shimmering bars. */
export const Skeleton = memo(function Skeleton({
  film: m,
  g,
  zoom,
  bloom,
  onBloomEnd,
}: {
  film: PlacedFilm;
  g: Geometry;
  zoom: number;
  bloom?: { x: number; y: number } | null;
  onBloomEnd?: () => void;
}) {
  const k = typeScale(g);
  const fs = (px: number) => Math.round(fontPx(px, k, zoom));
  const pad = Math.round(14 * k);
  const posterH = Math.round((m.h - pad * 2) * 0.86);
  const pinH = g.stem + 4;
  const pinW = Math.max(12, Math.round(pinH * 0.58));
  return (
    <div
      className={`mc-skeleton${bloom ? ' mc-bloom' : ''}`}
      style={nodeStyle(m, g, zoom, bloom)}
      onAnimationEnd={bloom ? (ev) => { if (ev.target === ev.currentTarget) onBloomEnd?.(); } : undefined}
    >
      <svg
        className="mc-skel-pin"
        width={pinW}
        height={pinH}
        viewBox="0 0 24 36"
        style={{ left: Math.round((m.w - pinW) / 2), top: Math.round(m.h - 4) }}
        aria-hidden="true"
      >
        <path d="M12 0C5.37 0 0 5.46 0 12.2 0 21.15 12 36 12 36s12-14.85 12-23.8C24 5.46 18.63 0 12 0z" />
        <circle cx="12" cy="12.2" r="4.6" />
      </svg>
      <div className="mc-skel-card" style={{ left: 0, top: 0, width: m.w, height: m.h, padding: pad, gap: pad, borderRadius: Math.round(12 * k) }}>
        <div className="mc-skel-bar" style={{ width: Math.round(posterH / 1.5), height: posterH, borderRadius: Math.round(6 * k), flexShrink: 0 }} />
        <div className="mc-skel-body">
          <div className="mc-skel-bar" style={{ height: fs(12), width: '88%' }} />
          <div className="mc-skel-bar" style={{ height: fs(10), width: '56%' }} />
        </div>
      </div>
    </div>
  );
});
