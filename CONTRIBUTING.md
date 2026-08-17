# Contributing

Thanks for looking at sloppers. The codebase is a small pnpm monorepo:

| package | what it is |
| --- | --- |
| `packages/protocol` | zod schemas for every message that crosses a process boundary — the contract |
| `packages/collector` | the daemon devs run; harness adapters live here |
| `packages/server` | rooms, presence, pairing, token ledger (Hono + ws + SQLite) |
| `packages/web` | the office (Phaser 3 + React) |
| `packages/e2e` | headless smoke test of the whole loop |

## Setup

```sh
pnpm install
pnpm build
pnpm test
```

`pnpm demo` builds everything and serves an office with simulated teammates
at `http://localhost:8787/?room=demo`. To run against your own live agent
sessions, click **Share agents** in the office and run the command with
`node packages/collector/dist/cli.js share <code>`.

Before opening a PR: `pnpm lint && pnpm typecheck && pnpm test`. CI runs the
same three.

## Writing a harness adapter

This is the most valuable contribution there is. An adapter teaches the
collector to read one harness's on-disk session format; the core owns the
hard parts (file watching, incremental byte-cursor reads, debouncing, state
timing, privacy filtering), so an adapter is a pure per-line fold —
typically ~100 lines.

The interface, from `packages/collector/src/core/types.ts`:

```ts
interface HarnessAdapter {
  id: HarnessId;                       // 'my-harness', lowercase kebab-case
  roots(): string[];                   // dirs to watch, e.g. ~/.myharness/logs
  matches(filePath: string): boolean;  // is this file a session log?
  newAccumulator(filePath: string): SessionAccumulator;
  ingestLine(line: string, acc: SessionAccumulator): void;
}
```

Your `ingestLine` fills the accumulator from whatever your harness logs:

- `sessionId` — stable id for the session
- `cwd`, `branch`, `model`, `title` — whatever the format offers; all optional
- `tokens` — **cumulative** totals for the session (the server turns these
  into daily deltas via watermarks; never send per-event increments)
- `startedAtMs` — first event timestamp
- `lastEventKind` — who acts next: `'agent-final'` (turn over, human's move),
  `'agent-tool'` (tool call in flight or permission prompt), `'other'`
- `ignored` — set true to drop non-session files (see the Claude Code
  adapter's sidechain handling)

Steps:

1. Copy `packages/collector/src/adapters/codex.ts` as a starting point — it's
   the simpler of the two built-ins.
2. Write the adapter as pure line-folding; no I/O, no timers. Malformed lines
   must be skipped, never thrown on.
3. Add it to `builtinAdapters()` in `packages/collector/src/adapters/index.ts`.
4. Test it the way the built-ins are tested: synthetic fixture lines that
   mirror the real format (`claude-code.test.ts` / `codex.test.ts`). Include
   at least: identity extraction, token mapping (document how your harness
   counts cached input!), turn classification, and a malformed-line case.
5. In the PR description, paste a scrubbed sample of the real log format so
   reviewers can check the mapping.

Token mapping matters: `TokenTotals` keeps `input`, `output`, `cacheRead`,
`cacheWrite` **disjoint**. If your harness reports input inclusive of cache
hits (Codex does), subtract cached out of input — see `codex.ts`.

## Style

- TypeScript strict; `pnpm lint` (biome) is the formatter — don't hand-format.
- Comments explain constraints the code can't show, not what the next line
  does.
- Every behavioral change needs a test that fails without it.

## Privacy is a feature

Anything that widens what leaves a dev's machine gets extra scrutiny. New
shared fields must be optional in the protocol, default-off or clearly
user-visible, and filtered in the **collector** (`core/visibility.ts`) —
never rely on the server or UI to hide data.
