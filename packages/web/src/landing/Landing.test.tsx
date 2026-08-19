// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { MotionConfigContext } from 'motion/react';
import { useContext } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRoomPreview } from '../net/socket.js';
import { Landing } from './Landing.js';

/**
 * The entrances on this page are inline styles the animation library writes,
 * so no stylesheet reaches them and no amount of CSS review would catch them
 * ignoring somebody's reduced-motion setting. `MotionConfig` is what does, and
 * what it is worth is exactly how much of the page it covers — so this reads
 * the setting from inside the tree, standing where a `motion.*` element
 * stands, rather than trusting that the wrapper is still around everything.
 */

/** Reports the motion setting reaching it, from wherever it is mounted. */
function Probe() {
  const { reducedMotion } = useContext(MotionConfigContext);
  return <span data-testid="motion-setting">{String(reducedMotion)}</span>;
}

vi.mock('../net/socket.js', () => ({ fetchRoomPreview: vi.fn() }));
// Stands in for the page's canvas simulation — jsdom has no canvas, and this
// is a convenient deep spot in the tree to read the setting from.
vi.mock('./OfficeStrip.js', () => ({ OfficeStrip: () => <Probe /> }));
// The typing terminal inside it wants an IntersectionObserver, which jsdom
// also lacks, and none of it is about motion configuration.
vi.mock('./HowItWorks.js', () => ({ HowItWorks: () => null }));

const previewMock = vi.mocked(fetchRoomPreview);

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

describe('Landing', () => {
  beforeEach(() => {
    previewMock.mockReset();
    previewMock.mockResolvedValue(null);
    localStorage.clear();
    vi.stubGlobal('IntersectionObserver', NoopObserver);
  });

  afterEach(cleanup);

  it('defers to the reader on motion, everywhere on the page', async () => {
    await act(async () => {
      render(<Landing onOpenOffice={() => {}} />);
    });

    // `user`, not `always`: somebody who has asked for nothing keeps the page
    // they were shown, and somebody who has asked keeps the fades while the
    // travel and the blur go away.
    expect(screen.getByTestId('motion-setting').textContent).toBe('user');
  });
});
