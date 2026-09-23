import { useEffect, useMemo, useState } from 'react';
import { requestHistory } from '../net/socket.js';
import { useStore } from '../store.js';
import { type AwayReport, awayReport, awaySpan } from './away.js';
import { formatTokens } from './format.js';

/**
 * "While you were away" — two lines about what the office did since somebody
 * was last in it, shown once per real absence.
 *
 * Quiet furniture, in the same idiom and the same corner as the empty-avatar
 * nudge: no scrim, the office stays walkable behind it, a click anywhere sends
 * it away, and it goes by itself if nobody touches it. Everything in it is
 * arithmetic over the history answer the board and the week strips already
 * share, so the panel costs no extra request and cannot be told a different
 * story about a day than the panel next to it.
 */

/** How long it sits there untouched. Long enough to read twice, unhurried. */
const VISIBLE_MS = 12_000;
/** The fade. Matched to `greet-out` in the stylesheet, and off under reduced motion. */
const LEAVE_MS = 320;

/**
 * What the office did, in at most two sentences, warmest first.
 *
 * The personal one leads, and it is the reason this panel exists: a machine
 * that kept working while nobody was watching is the fact nothing else in the
 * product will ever tell you. A member who withholds their numbers has no such
 * line — their collector never sent the tokens, so the office genuinely has
 * nothing of theirs to hand back — and the room's line stands on its own.
 *
 * Nothing at all is said with a number of zero. "Your agents burned 0" is not a
 * sentence, and a room that burned nothing gets the one line it has earned:
 * that it was quiet, which is true, warm, and the thing somebody came here to
 * find out. No streaks, no counting of days missed, nothing lit red.
 */
function lines(report: AwayReport): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  if (report.mine > 0) {
    out.push(
      <>
        Your agents kept going — <b>{formatTokens(report.mine)}</b> tok.
      </>,
    );
  }
  if (report.top && report.movers === 1) {
    out.push(
      <>
        <b>{report.top.displayName}</b> burned <b>{formatTokens(report.top.total)}</b> tok.
      </>,
    );
  } else if (report.top) {
    const rest = formatTokens(report.others);
    const front = formatTokens(report.top.total);
    // `others` and the leader's figure round to 2-3 significant digits, and
    // when both print the same the sentence's structure collapses — "burned
    // 1M, out front with 1M". One number is enough there; the leader's is
    // the one with a name on it.
    out.push(
      rest === front ? (
        <>
          <b>{report.top.displayName}</b> led the rest with <b>{front}</b> tok.
        </>
      ) : (
        <>
          The rest of the office burned <b>{rest}</b> tok — <b>{report.top.displayName}</b> out
          front with <b>{front}</b>.
        </>
      ),
    );
  }
  if (out.length === 0) out.push(<>Nothing burned in that time — the office has been quiet.</>);
  return out;
}

export function Greeting() {
  const lastHereDay = useStore((s) => s.lastHereDay);
  const you = useStore((s) => s.you);
  const history = useStore((s) => s.history);
  const dismissGreeting = useStore((s) => s.dismissGreeting);
  const [leaving, setLeaving] = useState(false);

  // The same cached answer the board's day switch and every week strip read,
  // asked for the same idempotent way: one request per connection however many
  // of the three want it. The greeting never fetches on its own account — the
  // history budget is six a minute and a panel that spent one of them per
  // arrival would be the feature taxing the rest of the office.
  useEffect(() => {
    if (lastHereDay) requestHistory();
  }, [lastHereDay]);

  const report = useMemo(
    () => (lastHereDay && history && you ? awayReport(history, lastHereDay, you) : null),
    [lastHereDay, history, you],
  );
  // Whether there is anything on screen to time out. Kept separate from the
  // report object so the timers key on a boolean and a day string rather than
  // on a value recomputed whenever the office re-renders.
  const showing = report !== null;

  useEffect(() => {
    if (!showing) return;
    // A fresh greeting starts un-faded. The flag survives the last one going
    // away, and a second arrival would otherwise open already dissolving.
    setLeaving(false);
    const fade = setTimeout(() => setLeaving(true), VISIBLE_MS);
    const gone = setTimeout(() => dismissGreeting(), VISIBLE_MS + LEAVE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, [showing, dismissGreeting]);

  // Nothing is drawn while the answer is still in flight, and nothing is drawn
  // if it never arrives: a heading over an empty body, or a spinner where a
  // greeting should be, is worse than the office simply not mentioning it.
  if (!report || !lastHereDay) return null;

  return (
    <div className={`hud-greeting panel${leaving ? ' greeting-leaving' : ''}`}>
      <p className="greet-title" role="status">
        While you were away <span className="greet-span">· {awaySpan(report, lastHereDay)}</span>
      </p>
      {lines(report).map((line, i) => (
        // Index keys: these are two fixed slots in a panel that is built once
        // and never reordered, and the sentences carry no id of their own.
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed, never reordered
        <p className="greet-line" key={i}>
          {line}
        </p>
      ))}
      {/* Full-bleed and transparent, so "click anywhere on it" is one real
          button rather than a div pretending: one thing to focus, one accessible
          name, and the × is only its visible mark. */}
      <button
        type="button"
        className="greet-dismiss"
        aria-label="dismiss"
        onClick={dismissGreeting}
      >
        ×
      </button>
    </div>
  );
}
