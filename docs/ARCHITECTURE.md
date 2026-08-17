# Architecture

sloppers is a virtual office for teams that run coding agents. Everyone walks
around a shared pixel-art space in the browser; each avatar carries a live
status derived from the coding-agent sessions (Claude Code, Codex CLI, ...)
running on that person's machine — which agents are active, what project
they're on, how many tokens they're burning, whether the human is at the
keyboard or the agents are cooking alone.

This document describes how the system fits together and the reasoning behind
the load-bearing decisions. If you want to add support for another agent
harness, read [Adapters](#harness-adapters) and then `CONTRIBUTING.md`.

## System shape

Three runtime pieces, one wire contract:

```
┌─────────────────────────┐
│  dev machine            │
│                         │
│  ~/.claude/projects ────┼──┐
│  ~/.codex/sessions ─────┼──┤ file watching (read-only)
│                         │  ▼
│  ┌───────────────────┐  │        WebSocket (derived state only)
│  │ collector (npx)   │──┼──────────────────────────┐
│  └───────────────────┘  │                          ▼
└─────────────────────────┘               ┌────────────────────┐
                                          │ server (Node)      │
┌─────────────────────────┐   WebSocket   │  · rooms           │
│  browser                │◄─────────────►│  · presence        │
│  ┌───────────────────┐  │  positions,   │  · token ledger    │
│  │ web (Phaser+React)│  │  presence,    │  · SQLite          │
│  └───────────────────┘  │  leaderboard  │  · serves web app  │
└─────────────────────────┘               └────────────────────┘
```

| package              | runs where     | what it does                                                                 |
| -------------------- | -------------- | ---------------------------------------------------------------------------- |
| `packages/protocol`  | everywhere     | zod schemas for every message that crosses a process boundary                |
| `packages/collector` | dev machines   | watches harness session files, derives status, pushes snapshots              |
| `packages/server`    | one host       | rooms, presence fan-out, token accounting, serves the built web app          |
| `packages/web`       | browsers       | the walkable office: Phaser 3 world + React overlay                          |

A single server process self-hosts the whole thing: `npx` it or
`docker compose up`, state lives in one SQLite file.

## Design principles

1. **Join in the browser; share from the terminal.** Walking around requires
   nothing but a URL and an invite code. Sharing your agent activity requires
   code running on your machine — a browser cannot read `~/.claude` — so that
   step is one pasted command, generated pre-paired by the web app, run once.
2. **Privacy is enforced at the source.** Visibility filtering happens in the
   collector, before data leaves the machine. If "hide project names" is on,
   the server never sees a project name. Raw prompts, code, and file contents
   are never read off the transcript beyond what status derivation needs, and
   never transmitted at all.
3. **Snapshots, not diffs.** Collectors send their full current state (all
   live sessions on the machine) on every change, debounced. The server holds
   no per-collector sync state; any restart or reconnect self-heals on the
   next snapshot. The payload is small — this trade is all upside at our
   scale.
4. **The wire protocol is the contract.** Anything that speaks
   `packages/protocol` can replace anything else — a Rust collector, a native
   client, a TUI office — without touching the rest.

## Identity and rooms

There is no authentication in v1; the trust model is "people who share an
invite code trust each other". The pieces:

- A **room** is created on first use of an invite code. World state
  (positions, presence) is in memory; durable stats are in SQLite.
- A **member** is `(room, displayName, avatar)` created when someone joins
  from the browser.
- A **pairing code** is a short-lived (10 min) token minted by the web app
  for a member. `npx sloppers share <code>` redeems it once; the collector
  receives a device key and is permanently linked to that member. The device
  key — not the pairing code — authenticates subsequent collector
  connections.

A member can be browser-only (walks, shares nothing), collector-only (their
avatar idles at a desk while their status stays live), or both.

## Presence model

Each member resolves to one of five states, in priority order:

| state             | meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `needs-attention` | an agent is blocked waiting for human input                |
| `active`          | human present, at least one agent session working          |
| `grinding`        | agents working, human away — the machines are cooking      |
| `afk`             | human away, no agent activity                              |
| `offline`         | no browser tab and no collector heartbeat                  |

"Human present" means a focused/recently-active browser tab, or machine input
activity reported by the collector (macOS: HID idle time via `ioreg`; other
platforms fall back to agent-event recency).

## Token accounting

Collectors report **cumulative** per-session token totals (Claude Code usage
is summed per assistant message as the transcript is read; Codex reports
cumulative totals natively). The server keeps a watermark per session ID and
folds only the monotonic delta into that member's daily bucket. Re-sent
snapshots, collector restarts, and server restarts therefore never
double-count. Buckets are per `(member, day, harness)` and power the daily
leaderboard; history is retained for future dashboards.

## Harness adapters

An adapter teaches the collector to read one harness's on-disk session
format. The core owns everything hard — filesystem watching, byte-offset
cursors (only appended bytes are ever re-parsed, UTF-8-safely), debouncing,
state timers, snapshot projection — so an adapter is a pure per-line fold:

```ts
interface HarnessAdapter {
  id: HarnessId;
  /** Directories to watch, e.g. ~/.claude/projects. May not exist. */
  roots(): string[];
  /** Is this path a session file this adapter understands? */
  matches(filePath: string): boolean;
  newAccumulator(filePath: string): SessionAccumulator;
  /** Fold one complete transcript line into the accumulator. */
  ingestLine(line: string, acc: SessionAccumulator): void;
}
```

The core projects accumulators into wire snapshots, deriving each session's
state from the adapter's last-event classification plus elapsed quiet time.
There is deliberately no process-liveness check — `ps` is unreliable in
sandboxes — so sessions age out on recency alone: quiet 10 minutes reads as
idle, quiet 30 drops the session from snapshots.

Built-in adapters:

- **claude-code** — `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. Each
  line is a typed entry; assistant entries carry `message.model` and
  `message.usage` (input/output/cache tokens). Project and branch come from
  `cwd`/`gitBranch` fields; state from the last entry type and file recency.
- **codex** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. A
  `session_meta` line gives cwd/model/CLI version; `event_msg` entries of
  type `token_count` give cumulative usage.

State derivation is shared and time-based: a finished agent turn reads as
`waiting` immediately; an unanswered tool call reads as `working` until it
stalls ~90 s (then `waiting` — usually a permission prompt); anything else
reads as `working`. Quiet ≥10 min is `idle`; quiet ≥30 min drops the session
from snapshots entirely.

## Server

One Node process (Hono over `ws`):

- `GET /*` — the built web app and assets
- `POST /api/rooms` / `POST /api/pair` — room creation, pairing-code minting
- `WS /ws/web` — join, movement (≤15 Hz fan-out), presence + leaderboard push
- `WS /ws/collector` — device-key hello, snapshot ingest

SQLite (WAL) holds members, device keys, session watermarks, and daily stats.
Position updates are broadcast raw; presence and leaderboard updates are
broadcast on change. There is no server-side game logic beyond "positions are
clamped to the map" — the world is cosmetic, the data is the product.

`--demo` starts a room populated with simulated members whose agents work,
idle, and block on input — useful for development, screenshots, and trying
the thing without three friends on hand.

## Web

Phaser 3 renders the world — tilemap office, avatars with four-direction walk
cycles, camera follow, collision — and React renders everything flat: join
flow, popups, leaderboard, settings, share-agents modal. The two layers meet
in a thin event bridge; game state lives in a zustand store both can read.

Remote avatars interpolate toward their latest known position. Walking near
someone (or clicking them) opens their status card: per-session harness,
project, branch, model, state, tokens — whatever their visibility settings
share.

## Testing

- **protocol** — schema round-trip and rejection tests.
- **collector** — adapters are TDD'd against synthetic fixture transcripts
  (same shapes as real files, fabricated content); cursor logic tested for
  partial-line appends, truncation, and rotation.
- **server** — room lifecycle, pairing, and watermark accounting (including
  restart/re-send idempotency) as unit tests over the real SQLite layer.
- **e2e** — a scripted fake collector drives a real server; Playwright
  asserts avatars, popups, and leaderboard render and update.

## Not in v1 (deliberately)

Authentication and multi-team management, historical dashboards beyond the
daily board, LLM-generated "what are they working on" prose summaries, a
menubar tray app, and non-macOS machine-idle detection. Each has a designed
seam and none blocks the core loop.
