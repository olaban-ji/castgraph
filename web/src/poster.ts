/** Poster addresses, and what a frame shows when there is no poster.
 *
 *  Posters come from OMDb now, which returns Amazon's own image host.
 *  Those URLs carry their own size instruction in the path, so a card
 *  can ask for the width it actually draws instead of downloading a
 *  full-size sheet to paint at 92px. */

/** Amazon's images take a chain of directives between `._` and `_.jpg`.
 *  `SX342` is "scale to 342 wide". Anything already carrying directives
 *  is left alone rather than guessed at. */
const AMAZON = /^(https:\/\/m\.media-amazon\.com\/images\/[^.]+)\.[^/]*(\.jpg|\.png)$/i;

/** TMDb names the width in the path instead: `/t/p/w780/abc.jpg`. The
 *  fallback fetch stores these for films OMDb had no picture for, and
 *  without this a 104px tile would download the 780px sheet. */
const TMDB = /^(https:\/\/image\.tmdb\.org\/t\/p\/)w\d+(\/.+)$/i;

/** The widths a poster is asked for. A short ladder keeps one file in
 *  the browser cache across cards of similar size. */
const WIDTHS = [92, 154, 185, 342, 500, 780];

/** The width the expansion panel draws a poster at. Cards on screen
 *  ask for this same file before anyone opens one, so the panel does
 *  not start a download of its own. It has to stay the width in
 *  `.cd-sheet-poster`. */
export const SHEET_POSTER_PX = 92;

/** The poster the panel will show, at the width it draws. */
export function sheetPosterURL(url: string | undefined): string | undefined {
  return posterURL(url, SHEET_POSTER_PX);
}

/** The address to draw a poster from at this size, or undefined when
 *  there is no poster. A host this does not recognise is returned
 *  unchanged: an unfamiliar URL still works, it is just not resized. */
export function posterURL(url: string | undefined, cssPx: number, dpr = 2): string | undefined {
  if (!url) return;
  const amazon = AMAZON.exec(url);
  const tmdb = amazon ? null : TMDB.exec(url);
  if (!amazon && !tmdb) return url;
  const need = Math.ceil(Math.max(1, cssPx) * Math.min(Math.max(dpr, 1), 2));
  const want = WIDTHS.find((w) => w >= need) ?? WIDTHS[WIDTHS.length - 1];
  // TMDb's own ladder is w92/154/185/342/500/780, which is the ladder
  // above — the same file is reused across cards of similar size on
  // either host.
  return tmdb ? `${tmdb[1]}w${want}${tmdb[2]}` : `${amazon![1]}._SX${want}_${amazon![2]}`;
}

/** How long an image edge keeps a miss. The 404s come back with
 *  `max-age=300`; the extra few seconds are so a retry does not land
 *  in the same stored miss. The browser keeps that miss for the same
 *  stretch, so the later try has to be an address it has not stored. */
export const POSTER_MISS_MS = 5 * 60 * 1000 + 15 * 1000;

/** The addresses to try, in order.
 *
 *  The resized file and the stored one are different cache entries, so
 *  the stored one is worth a try the moment the resize misses. The same
 *  address is only worth trying again once the edge has dropped the
 *  miss, and only with a query the browser has not cached — the edge
 *  ignores the query, the browser does not. */
export function posterAttempts(
  preferred: string | undefined,
  stored: string | undefined,
): { url: string; delayMs: number }[] {
  if (!preferred) return [];
  const original = stored && stored !== preferred ? stored : preferred;
  const attempts = [{ url: preferred, delayMs: 0 }];
  if (original !== preferred) attempts.push({ url: original, delayMs: 0 });
  const join = original.includes('?') ? '&' : '?';
  attempts.push({ url: `${original}${join}r=1`, delayMs: POSTER_MISS_MS });
  return attempts;
}

/** A film's hue, 0–359, from its title: a string hash, so one film is
 *  always the same hue and the grid does not flicker through a palette.
 *
 *  It runs over UTF-16 code units, because that is what charCodeAt
 *  gives, and the share card (cmd/api/og.go) hashes the same units the
 *  same way, so the card and the map agree about a given film. */
export function hueOf(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** What a poster frame shows before its picture loads, and instead of
 *  one when there is none: a gradient in the film's own hue.
 *
 *  The hue is the film's; the lightness is the theme's. A dark frame on
 *  paper reads as a hole in the page, so on light the same hue comes
 *  back pale. It is passed in rather than read here: this file is pure,
 *  and the caller already knows which theme it is drawing.
 *
 *  A CSS background, set inline from here rather than written in the
 *  stylesheet. The build rewrites a stylesheet's oklch() as hex, and a
 *  gradient between hex stops is mixed in sRGB rather than OKLab, which
 *  greys out its middle; a value set from script reaches the browser as
 *  written. */
export function posterFallback(title: string, theme: 'light' | 'dark' = 'dark'): string {
  const h = hueOf(title);
  return theme === 'light'
    ? `linear-gradient(165deg, oklch(0.88 0.05 ${h}), oklch(0.78 0.06 ${h}))`
    : `linear-gradient(165deg, oklch(0.45 0.07 ${h}), oklch(0.28 0.05 ${h}))`;
}
