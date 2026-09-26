import { describe, expect, it } from 'vitest';
import { SEARCH_INVITE, isSearchShortcut, isTyping, searchPlaceholder } from './search';

describe('searchPlaceholder', () => {
  it('names the film being fetched while a map is on its way', () => {
    expect(searchPlaceholder(true, 'Memento', 'The Matrix')).toBe('Memento');
  });

  it('invites a search while loading a film whose title is not known', () => {
    // Back, Forward or a reloaded link: the old map's title would name
    // the wrong film.
    expect(searchPlaceholder(true, null, 'The Matrix')).toBe(SEARCH_INVITE);
    expect(searchPlaceholder(true, undefined, undefined)).toBe(SEARCH_INVITE);
  });

  it('names the searched film on a map, and invites a search anywhere else', () => {
    expect(searchPlaceholder(false, 'Memento', 'The Matrix')).toBe('The Matrix');
    expect(searchPlaceholder(false, null, undefined)).toBe(SEARCH_INVITE);
    expect(SEARCH_INVITE).toBe('Search a movie');
  });
});

describe('isSearchShortcut', () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });

  it('takes ⌘K and Ctrl+K from anywhere, typing or not', () => {
    for (const typing of [false, true]) {
      expect(isSearchShortcut(key('k', { metaKey: true }), typing)).toBe(true);
      expect(isSearchShortcut(key('k', { ctrlKey: true }), typing)).toBe(true);
    }
  });

  it('takes a bare slash only when the reader is not typing', () => {
    expect(isSearchShortcut(key('/'), false)).toBe(true);
    expect(isSearchShortcut(key('/'), true)).toBe(false);
  });

  it('leaves every other key alone', () => {
    expect(isSearchShortcut(key('k'), false)).toBe(false);
    expect(isSearchShortcut(key('K', { metaKey: true }), false)).toBe(false);
    expect(isSearchShortcut(key('k', { metaKey: true, altKey: true }), false)).toBe(false);
    expect(isSearchShortcut(key('/', { metaKey: true }), false)).toBe(false);
    expect(isSearchShortcut(key('/', { ctrlKey: true }), false)).toBe(false);
    expect(isSearchShortcut(key('Escape'), false)).toBe(false);
  });
});

describe('isTyping', () => {
  const el = (tagName: string, type?: string, editable = false) =>
    ({
      tagName,
      isContentEditable: editable,
      getAttribute: (name: string) => (name === 'type' ? (type ?? null) : null),
    }) as unknown as Element;

  it('is true in anything that takes typed text', () => {
    expect(isTyping(el('INPUT'))).toBe(true);
    expect(isTyping(el('INPUT', 'search'))).toBe(true);
    expect(isTyping(el('INPUT', 'Text'))).toBe(true);
    expect(isTyping(el('TEXTAREA'))).toBe(true);
    expect(isTyping(el('SELECT'))).toBe(true);
    expect(isTyping(el('DIV', undefined, true))).toBe(true);
  });

  it('is false on buttons, sliders, checkboxes and nothing at all', () => {
    expect(isTyping(el('BUTTON'))).toBe(false);
    expect(isTyping(el('DIV'))).toBe(false);
    expect(isTyping(el('INPUT', 'checkbox'))).toBe(false);
    expect(isTyping(el('INPUT', 'range'))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});
