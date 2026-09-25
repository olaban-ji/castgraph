/** Poster addresses and the colour a card falls back to.
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

/** The colour a card shows before its poster loads, and instead of one
 *  when there is none. Derived from the title, so a given film is always
 *  the same shade and the grid does not flicker through a palette.
 *
 *  The hue is the film's; the lightness is the theme's. A dark square
 *  on paper reads as a hole in the page, so on light the same hue comes
 *  back as a tint. It is passed in rather than read here: this file is
 *  pure, and the caller already knows which theme it is drawing. */
export function colourFor(title: string, theme: 'light' | 'dark' = 'dark'): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return theme === 'light' ? `hsl(${h % 360} 30% 84%)` : `hsl(${h % 360} 28% 22%)`;
}
