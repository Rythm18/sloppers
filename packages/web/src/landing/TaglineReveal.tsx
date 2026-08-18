import { motion } from 'motion/react';

/**
 * The page's one big-type moment: words surface from the dusk one at a
 * time as the section scrolls into view, in reading order, on the heavy
 * spring the rest of the page uses.
 */

const LINES = [
  ['half', 'standup,', 'half', 'aquarium.'],
  ['your', 'agents,', 'finally', 'visible.'],
];

const EASE = [0.32, 0.72, 0, 1] as const;

export function TaglineReveal() {
  let wordIndex = 0;
  return (
    <section aria-label="tagline" className="mx-auto max-w-3xl px-6 py-24 text-center">
      <p className="font-display text-4xl leading-tight text-parchment md:text-5xl">
        {LINES.map((line) => (
          <span key={line.join(' ')} className="block [text-wrap:balance]">
            {line.map((word) => {
              const delay = wordIndex * 0.14;
              wordIndex += 1;
              return (
                <motion.span
                  key={`${word}-${delay}`}
                  className="inline-block"
                  initial={{ opacity: 0.28, y: 10 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '0px 0px -15% 0px' }}
                  transition={{ duration: 0.8, delay, ease: EASE }}
                >
                  {word}
                  {' '}
                </motion.span>
              );
            })}
          </span>
        ))}
      </p>
    </section>
  );
}
