import { describe, expect, it } from 'vitest';
import { AWAY_MS, lastHereDay } from './absence.js';

/**
 * The two gates that decide whether anybody is greeted at all. Everything the
 * panel says downstream is arithmetic over data that already exists; this is
 * the only place a judgement is made, so it is the place to pin.
 */

const HOUR = 60 * 60 * 1000;
/** Fixed instants in a zone with no DST, so every arithmetic below is plain. */
const ZONE = 'Asia/Kolkata';
const at = (day: string, hhmm: string): number =>
  // +05:30 written out, so the day boundary in `ZONE` is unambiguous here.
  Date.parse(`${day}T${hhmm}:00+05:30`);

describe('what counts as having been away', () => {
  it('greets somebody back after a night', () => {
    const left = at('2026-09-21', '23:10');
    const back = at('2026-09-22', '09:20');
    expect(back - left).toBeGreaterThan(AWAY_MS);
    expect(lastHereDay(left, back, ZONE)).toBe('2026-09-21');
  });

  it('greets somebody back after a weekend, naming the day they left on', () => {
    expect(lastHereDay(at('2026-09-18', '18:00'), at('2026-09-21', '09:00'), ZONE)).toBe(
      '2026-09-18',
    );
  });

  /**
   * The needy failure this whole mechanism exists to avoid. A reload, a wifi
   * blip and a tab switch are all this, and none of them is somebody coming
   * back.
   */
  it('says nothing about a ninety-second blip', () => {
    const left = at('2026-09-22', '14:00');
    expect(lastHereDay(left, left + 90_000, ZONE)).toBeUndefined();
  });

  it('says nothing about a blip that happens to straddle midnight', () => {
    // The day gate alone would call this a return — it crosses into a new
    // office day — which is exactly why the hours gate stands beside it.
    const left = at('2026-09-21', '23:59');
    expect(lastHereDay(left, left + 90_000, ZONE)).toBeUndefined();
  });

  it('says nothing at five hours, and says something at seven', () => {
    const back = at('2026-09-22', '06:00');
    expect(lastHereDay(back - 5 * HOUR, back, ZONE)).toBeUndefined();
    expect(lastHereDay(back - 7 * HOUR, back, ZONE)).toBe('2026-09-21');
  });

  /**
   * Away all day and back the same evening. Genuinely absent, and the office
   * still says nothing: its numbers are bucketed by day, so it cannot separate
   * this person's own morning from the room's afternoon, and handing somebody
   * their own work back as news is the one thing the panel must not do.
   */
  it('stays quiet about an absence that began and ended inside one office day', () => {
    expect(lastHereDay(at('2026-09-22', '08:00'), at('2026-09-22', '19:00'), ZONE)).toBeUndefined();
  });

  it('has no absence to report for somebody who has never been here', () => {
    expect(lastHereDay(0, at('2026-09-22', '09:00'), ZONE)).toBeUndefined();
  });

  /**
   * The office's own clock decides, not the server's. The same pair of
   * instants is one day in Kolkata and two in Los Angeles, and only the
   * office's setting may say which.
   */
  it('cuts the day on the office it is asked about', () => {
    const left = Date.parse('2026-09-22T05:00:00Z');
    const back = Date.parse('2026-09-22T17:00:00Z');
    expect(lastHereDay(left, back, 'Asia/Kolkata')).toBeUndefined();
    expect(lastHereDay(left, back, 'America/Los_Angeles')).toBe('2026-09-21');
  });
});
