import { describe, expect, it } from 'vitest';
import { prefFrom, resolved } from './theme';
import { colourFor } from './poster';

describe('the stored theme preference', () => {
  it('takes only the three it knows, and defaults to the machine', () => {
    expect(prefFrom('light')).toBe('light');
    expect(prefFrom('dark')).toBe('dark');
    expect(prefFrom('system')).toBe('system');
    expect(prefFrom(null)).toBe('system');
    expect(prefFrom('sepia')).toBe('system');
  });

  it('resolves a stated choice without asking the machine', () => {
    expect(resolved('light')).toBe('light');
    expect(resolved('dark')).toBe('dark');
  });
});

describe('the poster fallback colour', () => {
  it('keeps a film its own hue and takes the lightness from the theme', () => {
    const dark = colourFor('The Matrix', 'dark');
    const light = colourFor('The Matrix', 'light');
    const hue = /hsl\((\d+)/;
    expect(hue.exec(dark)![1]).toBe(hue.exec(light)![1]);
    expect(dark).toContain('28% 22%');
    expect(light).toContain('30% 84%');
  });

  it('draws dark when nobody says otherwise', () => {
    expect(colourFor('The Matrix')).toBe(colourFor('The Matrix', 'dark'));
  });
});
