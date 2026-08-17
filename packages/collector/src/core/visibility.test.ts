import type { SessionSnapshot } from '@sloppers/protocol';
import { defaultVisibility } from '@sloppers/protocol';
import { describe, expect, it } from 'vitest';
import { applyVisibility } from './visibility.js';

const full: SessionSnapshot = {
  id: 's1',
  harness: 'claude-code',
  state: 'working',
  title: 'Fixing the build',
  project: 'myapp',
  branch: 'main',
  model: 'claude-fable-5',
  tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  startedAt: 1,
  lastActivityAt: 2,
};

describe('applyVisibility', () => {
  it('passes everything through with default settings', () => {
    expect(applyVisibility(full, defaultVisibility)).toEqual(full);
  });

  it('strips exactly the hidden fields', () => {
    const out = applyVisibility(full, {
      title: false,
      project: false,
      branch: true,
      model: true,
      tokens: false,
    });
    expect(out).toEqual({
      id: 's1',
      harness: 'claude-code',
      state: 'working',
      branch: 'main',
      model: 'claude-fable-5',
      startedAt: 1,
      lastActivityAt: 2,
    });
  });

  it('never invents fields that were absent', () => {
    const bare: SessionSnapshot = {
      id: 's2',
      harness: 'codex',
      state: 'idle',
      startedAt: 1,
      lastActivityAt: 2,
    };
    expect(applyVisibility(bare, defaultVisibility)).toEqual(bare);
  });
});
