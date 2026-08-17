import { describe, expect, it } from 'vitest';
import { deriveSessionState, EXPIRE_MS, IDLE_MS } from './state.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe('deriveSessionState', () => {
  it('is working while the transcript is moving', () => {
    expect(deriveSessionState('other', 2 * SECOND)).toBe('working');
    expect(deriveSessionState('other', 5 * MINUTE)).toBe('working');
  });

  it('is waiting once the agent ends its turn, no matter how recently', () => {
    expect(deriveSessionState('agent-final', 1 * SECOND)).toBe('waiting');
    expect(deriveSessionState('agent-final', 9 * MINUTE)).toBe('waiting');
  });

  it('treats a fresh tool call as working but a stalled one as waiting', () => {
    expect(deriveSessionState('agent-tool', 10 * SECOND)).toBe('working');
    expect(deriveSessionState('agent-tool', 2 * MINUTE)).toBe('waiting');
  });

  it('goes idle after the idle window regardless of last event', () => {
    expect(deriveSessionState('agent-final', IDLE_MS)).toBe('idle');
    expect(deriveSessionState('agent-tool', IDLE_MS)).toBe('idle');
    expect(deriveSessionState('other', IDLE_MS + 1)).toBe('idle');
  });

  it('expiry window is longer than the idle window', () => {
    expect(EXPIRE_MS).toBeGreaterThan(IDLE_MS);
  });
});
