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
┌─────────────────────────┐   WebSocket   │  · workspaces      │
│  browser                │◄─────────────►│  · presence        │
│  ┌───────────────────┐  │  positions,   │  · usage ledger    │
│  │ web (Phaser+React)│  │  presence,    │  · SQLite          │
│  └───────────────────┘  │  leaderboard  │  · serves web app  │
└─────────────────────────┘               └────────────────────┘
```

| package              | runs where     | what it does                                                                 |
| -------------------- | -------------- | ---------------------------------------------------------------------------- |
| `packages/protocol`  | everywhere     | zod schemas for every message that crosses a process boundary                |
| `packages/collector` | dev machines   | watches harness session files, derives status, routes and pushes snapshots   |
| `packages/server`    | one host       | workspaces, presence fan-out, usage accounting, serves the built web app     |
| `packages/web`       | browsers       | the walkable office: Phaser 3 world + React overlay                          |

A single server process self-hosts the whole thing: `npx` it or
`docker compose up`, state lives in one SQLite file.

One collector is not one office. A machine can hold several pairings, each
claiming a set of directory globs, and every live session is routed to the
first pairing whose globs contain its working directory — so work directories
map to workspaces, and each pairing holds its own connection, device key,
visibility settings and pause switch. See [Routing](#routing).

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
5. **Days belong to the machine that did the work.** Every usage count is
   stamped with the local day the harness wrote it on, and the server files
   it under that day rather than its own. The server's clock decides only
   which day *it* is currently serving as "today".

## Identity, workspaces, and the door

There are no accounts; capabilities do the work:

- A **workspace** has a permanent internal id and a separate **invite code**
  (`<vanity-slug>-<random suffix>`) that the URL carries. The split is what
  makes rotation possible: the owner mints a fresh code and every old link
  dies, while members, devices and stats — all keyed on the id — survive
  untouched. The code is unguessable in practice (≈30 bits plus per-IP join
  rate limiting). Workspaces are never created by joining an unknown code; a
  dead invite is a clear error, not a new empty office. World state
  (positions, presence) is in memory; everything durable is in SQLite.
- A **member** is `(workspace, displayName, avatar, role)` created when
  someone joins from the browser. The browser keeps the member id + a random
  secret in localStorage — that pair is the identity.
- A **pairing code** is a short-lived (10 min) token minted by the web app
  for a member. `npx sloppers share <code>` redeems it once; the collector
  receives a device key and is permanently linked to that member. The device
  key — not the pairing code — authenticates subsequent collector
  connections.
- **Relink** closes the recovery loop: a paired device key can mint a
  one-shot, short-lived URL (`sloppers relink`) that signs any fresh browser
  in as that member. The same token is available from inside the office
  (**Settings → This device**) for anyone who is already signed in somewhere,
  so cleared storage and second devices recover without a login system.

A member can be browser-only (walks, shares nothing), collector-only (their
avatar idles at a desk while their status stays live), or both.

### Roles

Three, and `domain/permissions.ts` is the only place any of them is compared:
one `can(role, action)` table, plus a `canActOn(actor, target)` rank rule so
moderators cannot reach each other and nobody reaches the owner. Every admin
op goes through that choke point, which is what keeps a new op from quietly
shipping without a check.

| role        | may                                                                           |
| ----------- | ----------------------------------------------------------------------------- |
| `owner`     | everything: rename, settings, rotate invite, promote/demote, delete, transfer  |
| `moderator` | answer knocks, kick, ban, unban                                                |
| `member`    | nothing administrative                                                         |

Exactly one owner per workspace, assigned by adoption rather than by "first
ever member": whoever joins an office that currently has no active owner
takes the keys. That covers a workspace migrated from the pre-roles schema, a
deleted owner, and a banned one, without a repair script. An owner must hand
the keys on before deleting themselves.

Kick and ban both remove someone; the difference is the row left behind. A
kicked member may rejoin freely. A banned one keeps a tombstone — the ban
*is* that row, so it is exempt from the stale-member sweep and ends only with
an unban, which returns them to "may rejoin as somebody new" rather than to
their old seat (banning frees the display name, and someone else may hold it
by now).

### The door

`joinMode` is a workspace setting with three values, enforced in one place —
`ws.ts`, at the moment a `join` arrives:

| mode     | behaviour                                                        |
| -------- | ---------------------------------------------------------------- |
| `link`   | the code is enough; they are a member immediately                |
| `knock`  | they wait at the door until a moderator or the owner decides     |
| `locked` | refused with `workspace-locked`; existing members are unaffected |

Knocks are deliberately in memory and tied to the waiting socket: close the
tab and the knock is gone, which needs no table, no expiry sweep and no
cleanup path, and the connection budget already caps how many can exist. A
knock writes nothing until it is admitted, so a name is only claimed at the
moment the door opens — which is also where it can still fail, if the name
was taken or the office filled up while they waited. The waiting page is told
whether anybody who *could* answer is online, and is told again when that
changes, so an unanswered knock is distinguishable from an empty office.

Durability across a moderator being offline is deliberately out of scope: a
knock is a person standing at a door, not a ticket.

## Routing

A collector holds a list of pairings, each with `match` — directory globs —
and every live session is routed to the first pairing whose globs contain its
`cwd`. The order is not config order: a pairing that claims *every*
directory sorts behind every specific one, so the catch-all an upgraded
single-workspace config inherits cannot starve a workspace added later. A
pairing that genuinely would shadow a new one is reported by
`sloppers share` at the moment it becomes true, because "connected, and
permanently empty" is otherwise invisible from the outside.

Whether a pairing is a catch-all is decided by behaviour rather than by
spelling: it is one when it matches every path in a set of probes. So every
equivalent spelling of "everything" qualifies, and `~/**` — which looks
sweeping but claims nothing under `/srv` — correctly does not.

The `cwd` a session is routed by never goes on the wire. It sits beside the
snapshot rather than inside it, so no code that builds an outgoing message
can reach a directory path by accident; the wire carries `project`, the
basename. A session whose harness never reported a `cwd` routes as the empty
path, which only a catch-all claims — the 0.1.1 behaviour, preserved.

Sessions that match no pairing are shared with nobody. That is correct and
silent, so `sloppers status` lists them.

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

## Usage accounting

A collector reports **buckets**: totals keyed by the local day and the model
the work actually happened on, cumulative *within each bucket*. The day is
cut on the collector's clock, never the server's — the server runs UTC and
the people doing the work do not, so a day computed server-side would file
their evenings under tomorrow.

The server keeps a watermark per `(session, member, day, model)` and banks
only the monotonic growth above it. Re-sending a snapshot adds exactly
nothing, so collector restarts, reconnects and server restarts are all free,
and work is credited to the day it was done rather than the day it was seen.
The alternative — one flat cumulative per session — filed a session that ran
past midnight entirely under whichever day it ended on, and could not tell a
model switch from more of the same.

Three guards sit on top of that, none of them cosmetic:

- **Resume.** `--resume` copies a transcript into a new file under a new
  session id, replaying the original's entries and request ids verbatim. The
  collector refuses a replayed request id while the original's claim is under
  24h old; the server absorbs everything older by *seeding* rather than
  banking a session it has never seen whose `startedAt` predates today. The
  cost is that a session first seen after it started contributes nothing
  retroactively — deliberate, because on a number people compete over,
  understating beats overstating.
- **Scheme changes.** A collector upgrade mid-session restates the same spend
  under keys the old watermarks cannot see. That is re-attribution, not new
  spend, so it re-bases instead of banking, and the gap between what was
  accounted and what is now reported is recovered once, under `unknown`, on
  the day it arrived.
- **Bucket migration.** A request restated after midnight or after a model
  switch moves between bucket keys, and the destination has no watermark of
  its own. A vanished bucket hands back exactly what it banked — never
  another session's share of the same row — and the fact that it held
  unbanked watermark travels with it, so a seeded session cannot launder its
  history through a rename.

**Active minutes** are measured, not inferred: each day is a 1440-bit bitmap
of which minutes saw agent activity, built from the timestamps in the
transcripts, ORed into the member's stored bitmap for that day. Two sessions
sharing a minute count once and a re-send changes nothing. A collector too
old to report bitmaps falls back to a coarse server-side mark, and the two
are never mixed for one member, because they cut days on different clocks.

**Cost** is an estimate from published list prices (`protocol/pricing.ts`),
refreshed by re-reading the vendors' pages — never from memory, and never by
interpolating a missing model from a neighbouring one. A model with no entry
yields `null`, not `0`, and a day containing any unpriced model surfaces
`null` for the whole day: a partial sum would read as a complete, smaller
one. The UI says "no est." and why.

`daily_usage` rows are `(member, day, harness, model)`, which is what powers
the leaderboard and the per-model breakdown; the harness split is stored but
not displayed.

Collectors that predate buckets are still supported and still in the wild.
They send one flat, session-cumulative total, which is synthesized into a
single `(today, unknown)` bucket whose watermark is read forward across day
boundaries — the only way to measure a total that spans days. The two schemes
are never mixed for one session: a collector upgrading mid-session re-bases,
as above.

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

One displayed session is a **group of files**, not a file. A subagent writes
its own transcript carrying its *parent's* session id, so an adapter marks
such a file `usageOnly`: its spend is folded into the parent's session, and
its identity never surfaces. Discarding those files — which is what happened
before — threw away roughly half of all billed tokens; showing them would put
the same session in the room twice. Expiry is group-wide for the same reason:
a parent transcript is not appended to while its subagent runs, so per-file
expiry would reap a parent out from under live work.

Built-in adapters:

- **claude-code** — `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. Each
  line is a typed entry; assistant entries carry `message.model`,
  `message.usage` (input/output/cache tokens) and a `requestId` that
  deduplicates one request appearing on several entries. Project and branch
  come from `cwd`/`gitBranch` fields; state from the last entry type and file
  recency; `isSidechain` marks a subagent transcript.
- **codex** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. A
  `session_meta` line gives cwd/model/CLI version; `event_msg` entries of
  type `token_count` give cumulative usage, of which the *growth* is what
  gets bucketed.

Each usage-bearing entry is filed under the local day of its own timestamp
and the model it names, so a session that crossed midnight or switched models
reaches the server already split. Wire ids are
`` `${sessionId}#${fingerprint(path)}` `` — a pure function of the session's
own id and file path, with no reference to what else is live — because two
rollouts really can share a session id, and the ledger's watermarks are keyed
on that id.

State derivation is shared and time-based: a finished agent turn reads as
`waiting` immediately; an unanswered tool call reads as `working` until it
stalls ~90 s (then `waiting` — usually a permission prompt); anything else
reads as `working`. Quiet ≥10 min is `idle`; quiet ≥30 min drops the session
from snapshots entirely.

## Server

One Node process (Hono over `ws`):

- `GET /*` — the built web app and assets; `GET /healthz`
- `GET /api/rooms/:code` — does this invite exist, and what is it called
- `POST /api/pair` / `POST /api/pair/redeem` — mint and redeem a pairing code
- `POST /api/relink` / `POST /api/relink/redeem` — mint and redeem a relink
  token
- `WS /ws/web` — join or knock, movement (≤15 Hz fan-out), admin ops,
  presence + leaderboard + roster push
- `WS /ws/collector` — device-key hello, snapshot ingest

Offices are created over the websocket, not over HTTP: `join` carries either
an invite code or a name to open a new one, so the door check and the creation
path are the same code.

SQLite (WAL) holds workspaces, members and their roles, device keys, relink
and pairing tokens, an append-only `workspace_events` audit log, per-bucket
`usage_watermarks`, `daily_usage`, and `daily_activity` minute bitmaps.
Schema changes go through an ordered, append-only migration list tracked by
SQLite's `user_version`, each running once inside a transaction; a shipped
migration is never edited, only followed by another.

Every inbound websocket message kind has its own token bucket — `move` is
generous because it is a tick-rate stream, `join` and `admin` are tight — and
in front of those sit a per-IP sliding-window join limiter and a per-IP and
global concurrent-socket budget. Position updates are broadcast
raw; presence, leaderboard and roster updates are broadcast on change, and
the roster only to the people entitled to see it. There is no server-side
game logic beyond "positions are clamped to the map" — the world is cosmetic,
the data is the product.

`--demo` starts an office populated with simulated members whose agents work,
idle, and block on input — useful for development, screenshots, and trying
the thing without three friends on hand. Its settings are rewritten on every
boot, so a demo office cannot be locked or renamed into something else.

## Web

Phaser 3 renders the world — tilemap office, avatars with four-direction walk
cycles, camera follow, collision — and React renders everything flat: join
flow, the waiting-at-the-door screen, popups, leaderboard, settings panel,
share-agents modal. The two layers meet in a thin event bridge; game state
lives in a zustand store both can read.

Remote avatars interpolate toward their latest known position. Walking near
someone (or clicking them) opens their status card: per-session harness,
project, branch, model, state, tokens — whatever their visibility settings
share — over today's totals, per-model split, active minutes and cost
estimate.

The settings panel mirrors the server's rank rule rather than trusting it
alone: a control that could only ever be refused is not rendered. When the
server does refuse an op, the sentence appears beside the control that asked
for it, not in a banner at the top of a long panel describing something three
sections down.

## Testing

- **protocol** — schema round-trip and rejection tests, plus the minute
  bitmap's encode/decode and the pricing lookup.
- **collector** — adapters are TDD'd against synthetic fixture transcripts
  (same shapes as real files, fabricated content); cursor logic tested for
  partial-line appends, truncation, and rotation; routing, glob matching and
  catch-all detection tested directly.
- **server** — workspace lifecycle, roles and the permission table, join
  modes and knocks, pairing, and the ledger (seeding, re-basing, bucket
  migration, restart/re-send idempotency) as unit tests over the real SQLite
  layer.
- **e2e** — the whole product, headless: synthetic transcripts in a temp
  HOME, the real collector daemon watching them, the real server ingesting,
  and a protocol-level client observing what a browser would render. If it
  passes, only pixels are unverified.

## Not in v1 (deliberately)

Historical dashboards beyond the daily board, a UI over the
`workspace_events` audit log (rows are written and queryable; surfacing them
is a later chore), knock durability across a moderator being offline,
LLM-generated "what are they working on" prose summaries, a menubar tray app,
and non-macOS machine-idle detection. Each has a designed seam and none
blocks the core loop.
