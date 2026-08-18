/**
 * A terminal-flavored marquee of office activity — the product's data
 * exhaust as ambience. Content duplicates once for a seamless loop; the
 * animation lives in CSS and pauses on hover and for reduced motion.
 */

const ENTRIES = [
  ['maya', 'claude', 'working', '1.4M tok'],
  ['arjun', 'codex', 'needs input', '847k tok'],
  ['theo', 'claude', 'grinding', '2.1M tok'],
  ['zoe', 'claude', 'at the desk', '389k tok'],
  ['ravi', 'codex', 'grinding', '976k tok'],
  ['nina', 'claude', 'working', '612k tok'],
  ['sam', 'codex', 'idle', '203k tok'],
  ['priya', 'claude', 'working', '1.1M tok'],
] as const;

const STATE_COLOR: Record<string, string> = {
  working: 'text-crt',
  'at the desk': 'text-crt',
  grinding: 'text-lamp',
  'needs input': 'text-alert',
  idle: 'text-wire',
};

function Row() {
  return (
    <>
      {ENTRIES.map(([name, harness, state, tokens]) => (
        <span
          key={`${name}-${tokens}`}
          className="inline-flex items-baseline gap-2 px-6 font-mono text-sm"
        >
          <span className="text-parchment">{name}</span>
          <span className="text-wire">·</span>
          <span className="text-wire">{harness}</span>
          <span className="text-wire">·</span>
          <span className={STATE_COLOR[state] ?? 'text-wire'}>{state}</span>
          <span className="text-wire">·</span>
          <span className="text-crt">{tokens}</span>
        </span>
      ))}
    </>
  );
}

export function Ticker() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden border-y border-panel bg-ink py-2 whitespace-nowrap"
    >
      <div className="ticker-track inline-block whitespace-nowrap">
        <Row />
        <Row />
      </div>
    </div>
  );
}
