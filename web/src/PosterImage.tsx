import { useEffect, useState, type CSSProperties } from 'react';
import { posterURL } from './poster';

/** A poster that gives up quietly. A missing file otherwise leaves the
 *  browser's broken-image icon in the card; the plain block is what a
 *  card already shows when it has no poster at all. */
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
  const [dead, setDead] = useState(false);
  useEffect(() => {
    setDead(false);
  }, [src]);

  if (!src || dead) {
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
