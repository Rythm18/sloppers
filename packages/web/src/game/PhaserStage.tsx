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

    void document.fonts.load('8px Silkscreen').then(() => {
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
        scene: [OfficeScene],
      });
    });

    return () => {
      cancelled = true;
      game?.destroy(true);
    };
  }, []);

  return <div ref={host} className="stage" aria-hidden="true" />;
}
