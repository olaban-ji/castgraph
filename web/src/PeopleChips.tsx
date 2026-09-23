import { useEffect } from 'react';
import type { GridPerson } from './grid';

interface Props {
  people: GridPerson[];
  /** How many films on the grid each person is in, by person id. */
  counts: Map<number, number>;
  selected: Set<number>;
  /** The person a pointer is resting on, previewing just them. */
  hovered: number | null;
  /** People on the card the pointer is resting on, which lights their chips. */
  lit: Set<number>;
  onToggle: (id: number) => void;
  onHover: (id: number | null) => void;
  onClear: () => void;
}

/** The tone a person is drawn in: cast gold, directors green. It is the
 *  only thing colour means on this screen. */
export function toneOf(role: GridPerson['role']): string {
  return role === 'director' ? 'var(--director)' : 'var(--accent)';
}

/** One line of chips: everyone, then each person in billing order. A chip
 *  selects that person; the grid dims everything they are not in. */
export function PeopleChips({
  people,
  counts,
  selected,
  hovered,
  lit,
  onToggle,
  onHover,
  onClear,
}: Props) {
  useEffect(() => () => onHover(null), [onHover]);
  return (
    <div className="cd-chips" onMouseLeave={() => onHover(null)}>
      <button
        type="button"
        className={`cd-chip cd-chip-all${selected.size === 0 ? ' cd-chip-on' : ''}`}
        onClick={onClear}
      >
        Everyone
      </button>
      {people.map((p) => {
        const on = selected.has(p.id);
        return (
          <button
            key={p.id}
            type="button"
            className={`cd-chip${on ? ' cd-chip-on' : ''}${lit.has(p.id) ? ' cd-chip-lit' : ''}`}
            style={{ ['--tone' as string]: toneOf(p.role) }}
            aria-pressed={on}
            onClick={() => onToggle(p.id)}
            onMouseEnter={() => onHover(p.id)}
            onMouseLeave={() => onHover(hovered === p.id ? null : hovered)}
          >
            <span className="cd-chip-dot" aria-hidden="true" />
            <span className="cd-chip-name">{p.name}</span>
            <span className="cd-chip-count">{counts.get(p.id) ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}

/** How many films on the grid each person is in. */
export function filmCounts(films: { people: number[] }[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const f of films) {
    // Once per film: a person credited twice is still one card.
    for (const id of new Set(f.people)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
