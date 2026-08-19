import { useStore } from '../store.js';

/**
 * Standing at a knock-mode door, waiting on a person rather than a server.
 *
 * The one thing this screen must not do is guess. Whether anybody who could
 * open the door is actually connected rides on the `knocking` message, and
 * the office re-sends it when that changes — so the line below is the truth
 * at the moment it is read, and it updates itself when a moderator walks in.
 * When the office says nothing (an older server), neither does this.
 */
function waitingLine(answerable: boolean | null): string {
  if (answerable === false) {
    return "Nobody's around to answer yet — this page will let you in the moment they do.";
  }
  if (answerable === true) {
    return 'Someone inside can see you waiting — this page will let you in the moment they answer.';
  }
  return 'This page will let you in the moment somebody answers.';
}

export function KnockingScreen({ officeName }: { officeName: string | null }) {
  const answerable = useStore((s) => s.doorAnswerable);

  return (
    <div className="join">
      <div className="join-card panel knock-card">
        <h1 className="join-brand">
          sloppers<span className="tick">_</span>
        </h1>
        <p className="join-tagline">
          Waiting for someone to let you into{' '}
          <strong className="join-office">{officeName ?? 'the office'}</strong>.
        </p>

        {/* Decorative: the sentence below carries the same news, in words. */}
        <div className="knock-wait" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>

        {/* Polite, not assertive: the news can change under a reader who is
            not looking at it, and it is never urgent. */}
        <p className="knock-line" aria-live="polite">
          {waitingLine(answerable)}
        </p>

        <p className="settings-note">
          Keep this tab open. Closing it takes you off the door, and you would have to knock again.
        </p>
      </div>
    </div>
  );
}
