import { describe, expect, it } from 'vitest';
import { headerGoes, HEADER_SLOP } from './overHeader';

describe('headerGoes', () => {
  const H = 100;

  it('will not go while the reader is still on the first screen', () => {
    // Hiding it here would take the first row of the map up with it,
    // so going down this far says nothing either way.
    expect(headerGoes(0, 40, H)).toBeNull();
    expect(headerGoes(40, 90, H)).toBeNull();
  });

  it('goes once they are past it and still going down', () => {
    expect(headerGoes(200, 300, H)).toBe(true);
  });

  it('comes back on the way up', () => {
    expect(headerGoes(300, 200, H)).toBe(false);
  });

  it('comes back at the top however they got there', () => {
    expect(headerGoes(300, 0, H)).toBe(false);
  });

  it('ignores a thumb that is barely moving', () => {
    expect(headerGoes(300, 300 + HEADER_SLOP, H)).toBeNull();
    expect(headerGoes(300, 300 - HEADER_SLOP, H)).toBeNull();
  });
});
