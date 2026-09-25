import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { fetchPosterStandIn } from './api';
import { posterAttempts, posterURL } from './poster';

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

/** TMDb's own image host. A miss there is not a reason to ask TMDb
 *  for the same file again. */
function fromTMDb(url: string | undefined): boolean {
  return !!url && url.includes('://image.tmdb.org/');
}

/** Which file to ask for, and when.
 *
 *  A miss asks TMDb for a replacement first. Only when that has no
 *  picture does the card fall back to the address it already had: the
 *  stored file now, and the same file again once an edge has stopped
 *  replaying the miss. Until there are pixels it keeps the plain block. */
export function usePosterSrc(stored: string | undefined, cssPx?: number, id?: string) {
  const [standFor, setStandFor] = useState(id);
  const [standIn, setStandIn] = useState<string | undefined>(undefined);
  const askedFor = useRef<string | undefined>(undefined);
  if (standFor !== id) {
    askedFor.current = undefined;
    setStandFor(id);
    setStandIn(undefined);
  }
  const replacement = standFor === id ? standIn : undefined;
  const base = replacement ?? stored;
  const preferred = !base ? undefined : cssPx != null ? posterURL(base, cssPx) : base;
  const planKey = `${id ?? ''}\n${preferred ?? ''}\n${stored ?? ''}`;
  const plan = posterAttempts(preferred, stored);
  const planRef = useRef(plan);
  planRef.current = plan;

  const [step, setStep] = useState(0);
  const [hold, setHold] = useState(false);
  const [failed, setFailed] = useState(false);
  const stepRef = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const asking = useRef(false);
  const idRef = useRef(id);
  idRef.current = id;
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const cssPxRef = useRef(cssPx);
  cssPxRef.current = cssPx;
  const [seen, setSeen] = useState(planKey);
  if (seen !== planKey) {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    stepRef.current = 0;
    setSeen(planKey);
    setStep(0);
    setHold(false);
    setFailed(false);
  }

  useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, [planKey]);

  const advance = () => {
    const nextIndex = stepRef.current + 1;
    const next = planRef.current[nextIndex];
    if (!next) {
      setFailed(true);
      setHold(false);
      return;
    }
    if (next.delayMs <= 0) {
      stepRef.current = nextIndex;
      setHold(false);
      setStep(nextIndex);
      return;
    }
    // Already waiting out this miss. A second error from the same file
    // must not start another wait.
    if (timer.current != null) return;
    setHold(true);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      stepRef.current = nextIndex;
      setHold(false);
      setStep(nextIndex);
    }, next.delayMs);
  };
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  const onError = useCallback(() => {
    const film = idRef.current;
    const current = planRef.current[stepRef.current]?.url;
    if (
      film &&
      askedFor.current !== film &&
      !asking.current &&
      !fromTMDb(current) &&
      !fromTMDb(storedRef.current)
    ) {
      askedFor.current = film;
      asking.current = true;
      setHold(true);
      void fetchPosterStandIn(film).then((url) => {
        asking.current = false;
        if (idRef.current !== film) return;
        const px = cssPxRef.current;
        const next = !url ? undefined : px != null ? (posterURL(url, px) ?? url) : url;
        const showing = planRef.current[stepRef.current]?.url;
        if (!next || next === showing) {
          advanceRef.current();
          return;
        }
        setStandIn(url);
      });
      return;
    }
    if (asking.current) return;
    advanceRef.current();
  }, []);

  // The render that notices a new poster has not committed the reset
  // yet, and should not briefly ask for the previous film's file.
  const stepNow = seen === planKey ? step : 0;
  const quiet = seen === planKey && (failed || hold);
  const src = quiet ? undefined : plan[stepNow]?.url;
  return { src, onError };
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
  id,
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
  /** IMDb title id, so a miss can ask for a TMDb replacement. */
  id?: string;
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
  const { src, onError } = usePosterSrc(url, cssPx, id);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [attempt, setAttempt] = useState(src);
  const [shown, setShown] = useState(false);
  if (attempt !== src) {
    setAttempt(src);
    setShown(false);
  }

  useLayoutEffect(() => {
    if (!src || shown) return;
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
      if (!live) return;
      // One miss, one decision. Safari can report it twice — the error
      // event and a completed image with no pixels — and each one would
      // otherwise spend a try.
      live = false;
      onErrorRef.current();
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
  }, [src, shown]);

  if (!src || !shown) {
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
      onError={() => onErrorRef.current()}
    />
  );
}
