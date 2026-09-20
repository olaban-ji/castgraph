import type { Geometry, PlacedFilm } from './layout';
import { typeScale } from './layout';

interface Props {
  film: PlacedFilm;
  g: Geometry;
  /** Dimmed because an edge elsewhere is being traced. */
  dim: boolean;
  onHover?: (x: number, y: number) => void;
  onLeave?: () => void;
}

/** One stop on the map: a location pin on the route and the card above it.
 *  The card is one of three tiers — anchor, trunk, branch — that carry
 *  less detail the further they sit from the anchor. */
export function Node({ film: m, g, dim, onHover, onLeave }: Props) {
  const k = typeScale(g);
  const fs = (px: number) => Math.max(10, Math.round(px * k));
  const left = Math.round(m.x - m.w / 2);
  const top = Math.round(m.y - g.stem - m.h);
  const pad = m.anchor ? Math.round(18 * k) : Math.round(14 * k);
  const posterH = m.anchor ? m.h - pad * 2 : Math.round((m.h - pad * 2) * 0.86);
  const posterW = Math.round(posterH / 1.5);
  const imdb = m.movie.imdb_rating;
  const tmdb = m.movie.rating;
  const rating = compactRating(m.movie);

  const hover = onHover
    ? {
        onMouseEnter: (ev: { clientX: number; clientY: number }) => onHover(ev.clientX, ev.clientY),
        onMouseMove: (ev: { clientX: number; clientY: number }) => onHover(ev.clientX, ev.clientY),
        onMouseLeave: () => onLeave?.(),
      }
    : {};

  return (
    <div className={`mc-node${dim ? ' mc-node-dim' : ''}`}>
      {m.tier === 'branch' ? (
        <div
          className="mc-card mc-branch"
          tabIndex={0}
          style={{ left, top, width: m.w, height: m.h, borderRadius: Math.round(10 * k) }}
          title={`${m.movie.label} (${m.year})`}
          {...hover}
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
          <div className="mc-branch-title" style={{ padding: Math.round(10 * k) }}>
            <div className="mc-title mc-title-branch" style={{ fontSize: fs(15) }}>{m.movie.label}</div>
            {m.relation ? <div className="mc-relation" style={{ fontSize: fs(11) }}>{m.relation}</div> : null}
          </div>
        </div>
      ) : (
        <div
          className={`mc-card${m.anchor ? ' mc-anchor' : ' mc-card-trunk'}`}
          style={{ left, top, width: m.w, height: m.h, padding: pad, gap: Math.round(14 * k), borderRadius: Math.round(14 * k) }}
          title={`${m.movie.label} (${m.year})`}
          {...hover}
        >
          <Poster film={m} w={posterW} h={posterH} radius={Math.round(7 * k)} />
          <div className="mc-card-body" style={{ gap: Math.round((m.anchor ? 10 : 7) * k) }}>
            {m.anchor ? (
              <>
                <div className="mc-eyebrow" style={{ fontSize: fs(11) }}>{m.year} · Anchor</div>
                <div className="mc-title mc-title-anchor" style={{ fontSize: fs(titleSize(m.movie.label)) }}>{m.movie.label}</div>
                <div className="mc-pills" style={{ gap: Math.round(8 * k) }}>
                  {imdb ? (
                    <div className="mc-pill mc-pill-imdb" style={{ padding: `${Math.round(3 * k)}px ${Math.round(9 * k)}px`, gap: Math.round(6 * k) }}>
                      <span className="mc-pill-label" style={{ fontSize: fs(10) }}>IMDb</span>
                      <span className="mc-pill-value" style={{ fontSize: fs(14) }}>{imdb.toFixed(1)}</span>
                    </div>
                  ) : null}
                  {tmdb ? (
                    <div className="mc-pill mc-pill-tmdb" style={{ padding: `${Math.round(3 * k)}px ${Math.round(9 * k)}px`, gap: Math.round(6 * k) }}>
                      <span className="mc-pill-label" style={{ fontSize: fs(10) }}>TMDb</span>
                      <span className="mc-pill-value" style={{ fontSize: fs(14) }}>{tmdb.toFixed(1)}</span>
                    </div>
                  ) : null}
                </div>
                <div className="mc-relation mc-relation-anchor" style={{ fontSize: fs(11) }}>
                  {creditLine(m.relation, m.role)}
                </div>
              </>
            ) : (
              <>
                <div className="mc-title mc-title-trunk" style={{ fontSize: fs(19) }}>{m.movie.label}</div>
                <div className="mc-meta">
                  <span className="mc-year" style={{ fontSize: fs(12) }}>{m.year}</span>
                  {rating ? (
                    <span className="mc-rating-compact" style={{ fontSize: fs(12) }} title={`${rating.source} rating`}>
                      {rating.value.toFixed(1)}
                    </span>
                  ) : null}
                </div>
                {m.relation ? <div className="mc-relation" style={{ fontSize: fs(11) }}>{m.relation}</div> : null}
              </>
            )}
          </div>
        </div>
      )}
      <MapPin film={m} g={g} />
    </div>
  );
}

/** Teardrop map marker. Tip sits on the route at the film's year; the head
 *  tucks under the card so the card reads as pinned to the map, not as
 *  another gold line dropping onto the path. */
function MapPin({ film: m, g }: { film: PlacedFilm; g: Geometry }) {
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
      style={{ left: Math.round(m.x - w / 2), top: Math.round(m.y - h) }}
      aria-hidden="true"
    >
      <ellipse className="mc-pin-ground" cx="12" cy="34.6" rx="4.2" ry="1.35" />
      <path d="M12 0C5.37 0 0 5.46 0 12.2 0 21.15 12 36 12 36s12-14.85 12-23.8C24 5.46 18.63 0 12 0z" />
      <circle className="mc-pin-hole" cx="12" cy="12.2" r="4.6" />
    </svg>
  );
}

/** Actor credits read "Keanu Reeves as Neo"; directing hops drop the "as". */
export function creditLine(name: string, role: string): string {
  if (!name) return '';
  if (role === 'Director') return `${name} directed`;
  if (role) return `${name} as ${role}`;
  return name;
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

/** A movie image. Wide tiles use the landscape backdrop when TMDb has one;
 *  a portrait poster in a landscape box is cropped to its top, where a
 *  poster's title usually is, rather than its middle. */
function Poster({ film, w, h, radius, wide = false }: { film: PlacedFilm; w: number; h: number; radius: number; wide?: boolean }) {
  const style = { width: w, height: h, borderRadius: radius, ['--poster-colour' as string]: colourFor(film.movie.label) };
  const src = wide ? film.movie.backdrop ?? film.movie.poster : film.movie.poster;
  if (src) {
    const position = wide && !film.movie.backdrop ? 'center top' : 'center';
    return <img className="mc-poster" src={src} alt="" width={w} height={h} loading="lazy" decoding="async" style={{ ...style, objectPosition: position }} />;
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
export function Skeleton({ film: m, g }: { film: PlacedFilm; g: Geometry }) {
  const k = typeScale(g);
  const fs = (px: number) => Math.max(10, Math.round(px * k));
  const left = Math.round(m.x - m.w / 2);
  const top = Math.round(m.y - g.stem - m.h);
  const pad = Math.round(14 * k);
  const posterH = Math.round((m.h - pad * 2) * 0.86);
  const pinH = g.stem + 4;
  const pinW = Math.max(12, Math.round(pinH * 0.58));
  return (
    <div className="mc-skeleton">
      <svg
        className="mc-skel-pin"
        width={pinW}
        height={pinH}
        viewBox="0 0 24 36"
        style={{ left: Math.round(m.x - pinW / 2), top: Math.round(m.y - pinH) }}
        aria-hidden="true"
      >
        <path d="M12 0C5.37 0 0 5.46 0 12.2 0 21.15 12 36 12 36s12-14.85 12-23.8C24 5.46 18.63 0 12 0z" />
        <circle cx="12" cy="12.2" r="4.6" />
      </svg>
      <div className="mc-skel-card" style={{ left, top, width: m.w, height: m.h, padding: pad, gap: pad, borderRadius: Math.round(12 * k) }}>
        <div className="mc-skel-bar" style={{ width: Math.round(posterH / 1.5), height: posterH, borderRadius: Math.round(6 * k), flexShrink: 0 }} />
        <div className="mc-skel-body">
          <div className="mc-skel-bar" style={{ height: fs(12), width: '88%' }} />
          <div className="mc-skel-bar" style={{ height: fs(10), width: '56%' }} />
        </div>
      </div>
    </div>
  );
}
