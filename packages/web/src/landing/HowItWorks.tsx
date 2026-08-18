import { useEffect, useRef, useState } from 'react';
import { AvatarThumb } from '../ui/AvatarThumb.js';
import { Reveal } from './Reveal.js';

/**
 * Three beats, told with the app's own furniture instead of icons: the
 * invite link chip, the real avatar sprites, and a terminal that types the
 * one command sharing actually takes.
 */

const COMMAND = 'npx sloppers share K4X-P2Q@sloppers.fly.dev';

function TerminalDemo() {
  const [typed, setTyped] = useState(0);
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTyped(COMMAND.length);
      setDone(true);
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || timer) return;
        timer = setInterval(() => {
          setTyped((n) => {
            if (n >= COMMAND.length) {
              if (timer) clearInterval(timer);
              setTimeout(() => setDone(true), 350);
              return n;
            }
            return n + 1;
          });
        }, 34);
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer) clearInterval(timer);
    };
  }, []);

  return (
    <div ref={ref} className="pixel-panel px-4 py-3 text-left font-mono text-sm">
      <div className="flex gap-1.5 pb-2">
        <i className="h-2 w-2 bg-alert" />
        <i className="h-2 w-2 bg-lamp" />
        <i className="h-2 w-2 bg-crt" />
      </div>
      <div className="text-parchment">
        <span className="text-wire">$ </span>
        {COMMAND.slice(0, typed)}
        <span className="animate-pulse text-lamp">▌</span>
      </div>
      {done ? (
        <div className="pt-1 text-crt">✓ paired — your avatar is live from now on</div>
      ) : (
        <div className="pt-1 opacity-0">.</div>
      )}
    </div>
  );
}

export function HowItWorks() {
  return (
    <section aria-label="how it works" className="mx-auto max-w-5xl px-6 pb-24">
      <Reveal>
        <h2 className="pb-8 text-center font-display text-2xl text-parchment [text-wrap:balance]">
          three steps, no accounts
        </h2>
      </Reveal>
      <div className="grid gap-6 md:grid-cols-3">
        <Reveal delay={0.05}>
          <article className="pixel-panel flex h-full flex-col gap-4 p-6">
            <span className="font-display text-xs tracking-widest text-lamp uppercase">
              01 · name an office
            </span>
            <p className="font-mono text-sm text-wire">
              Pick a name, get a link. The link is the key — nobody guesses their way in.
            </p>
            <div className="mt-auto border-2 border-panel bg-ink px-3 py-2 font-mono text-xs text-crt">
              sloppers.fly.dev/?room=the-lab-k4xp2q
            </div>
          </article>
        </Reveal>
        <Reveal delay={0.15}>
          <article className="pixel-panel flex h-full flex-col gap-4 p-6">
            <span className="font-display text-xs tracking-widest text-lamp uppercase">
              02 · friends step in
            </span>
            <p className="font-mono text-sm text-wire">
              They click, pick a pixel face, and walk around. Browser only, nothing to install.
            </p>
            <div className="mt-auto flex gap-2">
              {['clementine', 'sable', 'ziggy', 'biscuit', 'plum', 'marlow'].map((id) => (
                <AvatarThumb key={id} avatar={id} scale={2} />
              ))}
            </div>
          </article>
        </Reveal>
        <Reveal delay={0.25}>
          <article className="pixel-panel flex h-full flex-col gap-4 p-6">
            <span className="font-display text-xs tracking-widest text-lamp uppercase">
              03 · agents walk in
            </span>
            <p className="font-mono text-sm text-wire">
              One pasted command on the machine where your agents live. Run it once, forget it.
            </p>
            <div className="mt-auto">
              <TerminalDemo />
            </div>
          </article>
        </Reveal>
      </div>
    </section>
  );
}
