import { MotionConfig, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { fetchRoomPreview } from '../net/socket.js';
import { HowItWorks } from './HowItWorks.js';
import { OfficeStrip } from './OfficeStrip.js';
import { Reveal } from './Reveal.js';
import { TaglineReveal } from './TaglineReveal.js';
import { Ticker } from './Ticker.js';

/**
 * The front door for people with no invite. Not a pitch — a window: the
 * office runs right on the page, and the way in is one button. Invite
 * links and returning visitors never see this; they land straight where
 * they were headed.
 */

const EASE = [0.32, 0.72, 0, 1] as const;

export function Landing({ onOpenOffice }: { onOpenOffice: () => void }) {
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [knownOffices, setKnownOffices] = useState<{ code: string; name: string }[]>([]);

  useEffect(() => {
    void fetchRoomPreview('demo').then((found) => setDemoAvailable(found !== null));
    const codes: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('sloppers:identity:')) codes.push(key.slice('sloppers:identity:'.length));
    }
    void Promise.all(
      codes.slice(0, 3).map(async (code) => {
        const room = await fetchRoomPreview(code);
        return room ? { code, name: room.name } : null;
      }),
    ).then((offices) => setKnownOffices(offices.filter((o) => o !== null)));
  }, []);

  return (
    // Every entrance on this page is an inline style the animation library
    // writes, so no stylesheet can reach them — this is where somebody who has
    // asked their system for less motion is heard. `user` rather than
    // `always`: it defers to the setting, and it keeps the fades while
    // dropping the travel and the blur, so nothing arrives without arriving.
    // The CSS-driven half is the reduced-motion block at the end of
    // styles/landing.css.
    <MotionConfig reducedMotion="user">
      <div className="scanlines absolute inset-0 z-30 overflow-y-auto bg-ink text-parchment">
        <a
          href="#open-office"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-lamp focus:px-3 focus:py-2 focus:font-mono focus:text-sm focus:text-ink"
        >
          Skip to the door
        </a>

        <nav
          aria-label="main"
          className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5"
        >
          <span className="font-display text-lg text-parchment" aria-current="page">
            sloppers<span className="text-lamp">_</span>
          </span>
          <a
            className="font-mono text-sm text-wire no-underline transition-colors duration-300 hover:text-parchment hover:underline focus-visible:outline-2 focus-visible:outline-crt"
            href="https://github.com/Rythm18/sloppers"
            target="_blank"
            rel="noreferrer"
          >
            github ↗
          </a>
        </nav>

        <main>
          <header className="mx-auto max-w-3xl px-6 pt-14 pb-10 text-center">
            <motion.h1
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: EASE }}
              className="landing-heading-ink font-display text-4xl leading-tight [text-wrap:balance] md:text-5xl"
            >
              <span className="md:whitespace-nowrap">your coding agents,</span>
              <br />
              at the office
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.12, ease: EASE }}
              className="mx-auto max-w-xl pt-5 font-mono text-base text-wire [text-wrap:pretty]"
            >
              A tiny pixel world for your team. Wander over to a teammate, peek at what their agents
              are building, and watch the token meter climb. Free and open source.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.22, ease: EASE }}
              className="flex flex-wrap items-center justify-center gap-3 pt-8"
              id="open-office"
            >
              <button type="button" className="pixel-btn" onClick={onOpenOffice}>
                Open an office
              </button>
              {demoAvailable ? (
                <a className="pixel-btn pixel-btn-quiet" href="/?room=demo">
                  Walk the demo
                </a>
              ) : null}
            </motion.div>
            {knownOffices.length > 0 ? (
              <div className="flex flex-wrap items-center justify-center gap-4 pt-6">
                {knownOffices.map((office) => (
                  <a
                    key={office.code}
                    className="font-mono text-sm text-crt hover:underline focus-visible:outline-2 focus-visible:outline-crt"
                    href={`/?room=${encodeURIComponent(office.code)}`}
                  >
                    step back into {office.name} →
                  </a>
                ))}
              </div>
            ) : null}
          </header>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.2, delay: 0.35, ease: EASE }}
          >
            <OfficeStrip />
            <Ticker />
          </motion.div>

          <TaglineReveal />

          <HowItWorks />

          <Reveal>
            <section aria-label="privacy" className="mx-auto max-w-2xl px-6 pb-24 text-center">
              <p className="font-mono text-sm text-wire [text-wrap:pretty]">
                Nothing to sell, nothing collected. The collector reads agent session files on your
                machine and shares only derived status — never prompts, never code. Every field can
                be hidden, and <span className="text-parchment">sloppers pause</span> means paused.
              </p>
            </section>
          </Reveal>
        </main>

        <footer className="border-t border-panel">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-6 font-mono text-xs text-wire">
            <span>MIT licensed · made for the tokenmaxers</span>
            <span className="flex gap-4">
              <a
                className="text-wire no-underline hover:text-parchment hover:underline focus-visible:outline-2 focus-visible:outline-crt"
                href="https://github.com/Rythm18/sloppers"
                target="_blank"
                rel="noreferrer"
              >
                source
              </a>
              <a
                className="text-wire no-underline hover:text-parchment hover:underline focus-visible:outline-2 focus-visible:outline-crt"
                href="https://github.com/Rythm18/sloppers#readme"
                target="_blank"
                rel="noreferrer"
              >
                privacy &amp; docs
              </a>
            </span>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}
