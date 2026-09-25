import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { posterURL } from './poster';

/** True once the browser has finished with this file and it contributed
 *  no pixels.
 *
 *  Safari fires `error` synchronously when `src` is set to a cached
 *  404, which is before React attaches `onError`, and it often leaves
 *  `currentSrc` empty afterwards. A lazy poster that has not started
 *  looks the same (complete, no pixels) except that it has no
 *  `currentSrc` yet, and it is not a failure. */
export function posterGaveUp(img: {
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  currentSrc: string;
  /** `"lazy"`, or anything else. An omitted attribute is eager. */
  loading: string;
}): boolean {
  if (!img.complete || img.naturalWidth > 0 || img.naturalHeight > 0) return false;
  if (img.loading === 'lazy' && img.currentSrc === '') return false;
  return true;
}

/** A poster that gives up quietly.
 *
 *  The file is loaded off to the side and the card keeps the plain
 *  block until there are pixels. Putting the `<img>` in the document
 *  first is what leaves Safari's broken-image glyph behind: a cached
 *  miss paints the glyph and sometimes never delivers `error`, so the
 *  glyph stays. The block is what a card already shows when it has no
 *  poster at all. */
export function PosterImage({
  url,
  cssPx,
  className,
  blankClassName,
  width,
  height,
  eager,
  loading,
  style,
}: {
  url?: string;
  /** When set, an Amazon address is asked for this width. */
  cssPx?: number;
  className?: string;
  /** The block left behind when the file will not load. Defaults to
   *  `className`, which is the right one wherever the image and the
   *  empty poster already share a class. */
  blankClassName?: string;
  width?: number;
  height?: number;
  eager?: boolean;
  loading?: 'lazy';
  style?: CSSProperties;
}) {
  const src = !url ? undefined : cssPx != null ? posterURL(url, cssPx) : url;
  const [attempt, setAttempt] = useState(src);
  const [dead, setDead] = useState(false);
  const [shown, setShown] = useState(false);
  if (attempt !== src) {
    setAttempt(src);
    setDead(false);
    setShown(false);
  }

  useLayoutEffect(() => {
    if (!src || shown || dead) return;
    let live = true;
    const img = new Image();
    img.decoding = 'async';
    // Priority is whatever the card had when the fetch began. `eager` is
    // left out of the dependencies on purpose: scrolling the card onto
    // the glass should not throw away a request that is already on its way.
    img.fetchPriority = eager ? 'high' : 'low';
    const show = () => {
      if (live) setShown(true);
    };
    const fail = () => {
      if (live) setDead(true);
    };
    img.addEventListener('load', show);
    img.addEventListener('error', fail);
    img.src = src;
    if (img.naturalWidth > 0) show();
    else if (posterGaveUp(img)) fail();
    const later = requestAnimationFrame(() => {
      if (!live) return;
      if (img.naturalWidth > 0) show();
      else if (posterGaveUp(img)) fail();
    });
    return () => {
      live = false;
      cancelAnimationFrame(later);
      img.removeEventListener('load', show);
      img.removeEventListener('error', fail);
    };
    // `eager` is read once, when the fetch starts. See above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, shown, dead]);

  if (!src || dead || !shown) {
    return <span className={blankClassName ?? className} style={style} aria-hidden="true" />;
  }
  return (
    <img
      className={className}
      src={src}
      alt=""
      width={width}
      height={height}
      decoding="async"
      fetchPriority={eager ? 'high' : 'low'}
      loading={loading}
      style={style}
      onError={() => setDead(true)}
    />
  );
}
