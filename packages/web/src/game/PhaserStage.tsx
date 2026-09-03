import Phaser from 'phaser';
import { useEffect, useRef } from 'react';
import { OfficeScene } from './scene.js';

/**
 * Mounts the Phaser game exactly once for the life of the world phase.
 * Waits for the pixel fonts so in-canvas name labels never render in a
 * fallback face.
 */
export function PhaserStage() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let game: Phaser.Game | null = null;
    let cancelled = false;

    // A failed font load should never block the office; labels fall back.
    void document.fonts
      .load('8px Silkscreen')
      .catch(() => {})
      .then(() => {
        if (cancelled) return;
        game = new Phaser.Game({
          type: Phaser.AUTO,
          parent: el,
          pixelArt: true,
          backgroundColor: '#1a1423',
          scale: {
            mode: Phaser.Scale.RESIZE,
            width: '100%',
            height: '100%',
          },
          // Said out loud rather than left to Phaser, which decides whether to
          // bind touch listeners at all from a one-shot probe of the document
          // as the game boots. When that probe is wrong the office is simply
          // unwalkable and nothing anywhere says why — and it costs a
          // mouse-only machine four listeners that never fire.
          input: { touch: true },
          scene: [OfficeScene],
        });
        // Debug handle for bug reports: inspect the live game from devtools.
        (window as Window & { __sloppers?: Phaser.Game }).__sloppers = game;
      });

    return () => {
      cancelled = true;
      game?.destroy(true);
    };
  }, []);

  return <div ref={host} className="stage" aria-hidden="true" />;
}
