import type { RemovalReason } from '../store.js';

/**
 * The other side of the door. Three ways to lose a seat, and they are not
 * the same thing to the person who lost it: a kick is a door closed, a
 * delete is a record erased, a ban is a decision about them.
 *
 * Only the first two offer a way back, because only the first two have one —
 * the office refuses a banned member by name, and a button that fires an op
 * the server will not honour is a worse answer than no button.
 */
interface Removal {
  /** The word for what happened, in Silkscreen and the alert colour. */
  title: string;
  /** What happened, in a sentence, naming the office. */
  what: (office: string) => string;
  /** What it costs, and what is still possible. */
  consequence: string;
  /** Whether walking back in is a thing they can do. */
  canReturn: boolean;
}

const REMOVALS: Record<RemovalReason, Removal> = {
  kicked: {
    title: 'Shown the door',
    what: (office) => `Somebody removed you from ${office}.`,
    consequence:
      'Nothing of yours was deleted, and the invite link still works — if you have it, you can walk back in.',
    canReturn: true,
  },
  banned: {
    title: 'Banned',
    what: (office) => `Somebody banned you from ${office}.`,
    consequence:
      'That is the end of it for this name. If you think it was a mistake, the only way back is to ask whoever runs the office to lift it.',
    canReturn: false,
  },
  deleted: {
    title: 'Deleted',
    what: (office) => `Your seat in ${office} is gone.`,
    consequence:
      'You and everything recorded about your agents there were deleted. You can join again, but you would arrive a stranger — no stats, no history.',
    canReturn: true,
  },
};

export function RemovedScreen({
  reason,
  officeName,
  onJoinAgain,
  onLeave,
}: {
  reason: RemovalReason;
  officeName: string;
  onJoinAgain: () => void;
  onLeave: () => void;
}) {
  const removal = REMOVALS[reason];
  const office = officeName || 'the office';

  return (
    <div className="join">
      <div className="join-card panel removed-card">
        <h1 className="join-brand">
          sloppers<span className="tick">_</span>
        </h1>
        <h2 className="removed-title">{removal.title}</h2>
        <p className="join-tagline">{removal.what(office)}</p>
        <p className="settings-note">{removal.consequence}</p>

        <div className="join-invite-row">
          {removal.canReturn ? (
            <button type="button" className="btn" onClick={onJoinAgain}>
              Join again
            </button>
          ) : null}
          <button type="button" className="btn btn-quiet" onClick={onLeave}>
            ← Back to sloppers
          </button>
        </div>
      </div>
    </div>
  );
}
