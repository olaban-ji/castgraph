import { describe, expect, it } from 'vitest';
import html from '../index.html?raw';
import { THEME_COLORS, prefFrom, resolved } from './theme';
import { posterFallback } from './poster';

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

describe('the poster fallback', () => {
  it('keeps a film its own hue and takes the lightness from the theme', () => {
    // The design's gradients, exactly. They replaced the flat hsl()
    // tints (28% 22% dark, 30% 84% light) this used to pin. "The
    // Matrix" hashes to hue 24.
    expect(posterFallback('The Matrix', 'dark')).toBe(
      'linear-gradient(165deg, oklch(0.45 0.07 24), oklch(0.28 0.05 24))',
    );
    expect(posterFallback('The Matrix', 'light')).toBe(
      'linear-gradient(165deg, oklch(0.88 0.05 24), oklch(0.78 0.06 24))',
    );
  });

  it('draws dark when nobody says otherwise', () => {
    expect(posterFallback('The Matrix')).toBe(posterFallback('The Matrix', 'dark'));
  });
});

describe('the browser chrome colour', () => {
  it('is each theme\'s ground, as hex', () => {
    expect(THEME_COLORS).toEqual({ dark: '#13100d', light: '#f9f4ee' });
  });

  it('is the same in the first paint as after it', () => {
    // index.html sets theme-color before any script module has loaded,
    // and apply() takes over from there. If the two disagreed, the
    // browser's bar would change colour a moment after the page opened.
    expect(html).toContain(`(t === 'light' ? '${THEME_COLORS.light}' : '${THEME_COLORS.dark}')`);
    expect(html).toContain(`<noscript><meta name="theme-color" content="${THEME_COLORS.dark}" /></noscript>`);
  });
});
