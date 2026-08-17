import { describe, expect, it } from 'vitest';
import { parseShareTarget, wsUrlFor } from './pair.js';

describe('parseShareTarget', () => {
  it('gives plain hosts https', () => {
    expect(parseShareTarget('ABC-123@office.example.com')).toEqual({
      code: 'ABC-123',
      httpUrl: 'https://office.example.com',
    });
  });

  it('gives localhost http so local dev just works', () => {
    expect(parseShareTarget('ABC-123@localhost:8787')).toEqual({
      code: 'ABC-123',
      httpUrl: 'http://localhost:8787',
    });
    expect(parseShareTarget('ABC-123@127.0.0.1:8787').httpUrl).toBe('http://127.0.0.1:8787');
  });

  it('respects an explicit scheme', () => {
    expect(parseShareTarget('ABC@http://insecure.lan:9000').httpUrl).toBe(
      'http://insecure.lan:9000',
    );
  });

  it('strips trailing slashes', () => {
    expect(parseShareTarget('ABC@https://office.example.com/').httpUrl).toBe(
      'https://office.example.com',
    );
  });

  it('rejects malformed targets', () => {
    expect(() => parseShareTarget('just-a-code')).toThrow(/share code/);
    expect(() => parseShareTarget('@host-only')).toThrow(/share code/);
    expect(() => parseShareTarget('code@')).toThrow(/share code/);
  });
});

describe('wsUrlFor', () => {
  it('maps http(s) to ws(s)', () => {
    expect(wsUrlFor('https://office.example.com')).toBe('wss://office.example.com');
    expect(wsUrlFor('http://localhost:8787')).toBe('ws://localhost:8787');
  });
});
