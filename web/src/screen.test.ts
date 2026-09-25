import { describe, expect, it } from 'vitest';
import { screenOf } from './screen';

describe('screenOf', () => {
  it('calls a narrow screen a phone, whatever its height', () => {
    expect(screenOf(390, 844)).toEqual({ phone: true, short: false, narrow: true });
    expect(screenOf(390, 400)).toEqual({ phone: true, short: false, narrow: true });
  });

  it('calls a wide but short screen short, not a phone', () => {
    // A landscape phone: the desktop layout fits across, but there is no
    // room to give the header two rows.
    expect(screenOf(844, 390)).toEqual({ phone: false, short: true, narrow: true });
  });

  it('calls an ordinary window neither', () => {
    expect(screenOf(1280, 900)).toEqual({ phone: false, short: false, narrow: false });
  });

  it('puts the boundaries where the spec puts them', () => {
    expect(screenOf(639, 900).phone).toBe(true);
    expect(screenOf(640, 900).phone).toBe(false);
    expect(screenOf(900, 499).short).toBe(true);
    expect(screenOf(900, 500).short).toBe(false);
    // The rungs come out of the header below this, so a window in the
    // 641–860 range stops wrapping them onto a second row.
    expect(screenOf(1023, 900).narrow).toBe(true);
    expect(screenOf(1024, 900).narrow).toBe(false);
  });
});
