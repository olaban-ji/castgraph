/** The mark stands in for the C of "Cinedikt": a C left open on the right,
 *  its top end rising into the hooked neck of a lowercase delta — δίκτυο,
 *  network — with a gold dot at the centre for the searched film.
 *
 *  The gold is the dot's alone. The stroke takes `currentColor` so the
 *  mark darkens and lightens with the text beside it. */
export function Mark({ size }: { size: number }) {
  return (
    <svg
      className="cd-mark"
      viewBox="15.5 9.5 29.5 45"
      width={Math.round(size * 0.7 * 10) / 10}
      height={Math.round(size * 1.07 * 10) / 10}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M42.7 47 A14 14 0 1 1 42.7 29 C38 23.5 31 19 29 13 C33 11.8 37.5 11.6 41.5 12.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="38" r="5" fill="#ffd700" />
    </svg>
  );
}

interface Props {
  /** True on phones, where only the mark shows. */
  markOnly: boolean;
  href: string;
  onClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

/** A link home. On a phone the mark carries it alone, at a 40×44 target;
 *  everywhere else "inedikt" follows it on the same baseline. */
export function Wordmark({ markOnly, href, onClick }: Props) {
  return (
    <a
      className={`cd-wordmark${markOnly ? ' cd-wordmark-mark' : ''}`}
      href={href}
      onClick={onClick}
      aria-label="Cinedikt, home"
    >
      <Mark size={markOnly ? 22 : 20} />
      {!markOnly && <span aria-hidden="true">inedikt</span>}
    </a>
  );
}
