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

/** The widths a poster is asked for. A short ladder keeps one file in
 *  the browser cache across cards of similar size. */
const WIDTHS = [92, 154, 185, 342, 500, 780];

/** The address to draw a poster from at this size, or undefined when
 *  there is no poster. A host this does not recognise is returned
 *  unchanged: an unfamiliar URL still works, it is just not resized. */
export function posterURL(url: string | undefined, cssPx: number, dpr = 2): string | undefined {
  if (!url) return;
  const m = AMAZON.exec(url);
  if (!m) return url;
  const need = Math.ceil(Math.max(1, cssPx) * Math.min(Math.max(dpr, 1), 2));
  const want = WIDTHS.find((w) => w >= need) ?? WIDTHS[WIDTHS.length - 1];
  return `${m[1]}._SX${want}_${m[2]}`;
}

/** The colour a card shows before its poster loads, and instead of one
 *  when there is none. Derived from the title, so a given film is always
 *  the same shade and the grid does not flicker through a palette. */
export function colourFor(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 28% 22%)`;
}
