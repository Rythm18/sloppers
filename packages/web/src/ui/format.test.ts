import { describe, expect, it } from 'vitest';
import { formatTokens, sessionLine } from './format.js';

describe('formatTokens', () => {
  it('keeps small numbers plain', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('abbreviates thousands and millions', () => {
    expect(formatTokens(1_200)).toBe('1.2k');
    expect(formatTokens(45_000)).toBe('45k');
    expect(formatTokens(999_999)).toBe('1000k');
    expect(formatTokens(5_400_000)).toBe('5.4M');
    expect(formatTokens(123_000_000)).toBe('123M');
  });

  it('drops trailing .0', () => {
    expect(formatTokens(2_000)).toBe('2k');
    expect(formatTokens(3_000_000)).toBe('3M');
  });
});

describe('sessionLine', () => {
  const base = {
    id: 's',
    harness: 'claude-code',
    state: 'working',
    startedAt: 1,
    lastActivityAt: 1,
  } as const;

  it('prefers title, then project, then harness', () => {
    expect(sessionLine({ ...base, title: 'Fixing the build', project: 'app' })).toBe(
      'Fixing the build',
    );
    expect(sessionLine({ ...base, project: 'app' })).toBe('app');
    expect(sessionLine(base)).toBe('claude session');
  });
});
