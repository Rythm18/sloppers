# Workspaces: roles, access control, and the foundation for what's next

Status: design, awaiting review
Date: 2026-08-19

sloppers today is one flat kind of space: hold the invite link, you're in;
everyone inside is equal; nothing about the space can be changed after it's
created. That is the right shape for a weekend project among friends and the
wrong shape for everything we want next — moderated chat, voice, a public
leaderboard across workspaces, and offices that outlive the person who made
them.

This cycle builds the foundation the rest sits on: **workspaces that have an
owner, settings, and a controllable door.** It deliberately does not build
chat, voice, or the global leaderboard — but every decision here is made with
those in the room, and the seams they need are called out by name.

## What ships

1. **Workspaces replace rooms in the data model.** A workspace has a stable
   internal id, a rotatable invite code, a name, and a settings blob.
2. **Roles**: owner, moderator, member. First person through the door owns the
   place; owners promote moderators and can hand the keys over.
3. **Three join modes**: `link` (anyone with the link walks in — today's
   behavior), `knock` (link holders wait for an owner or moderator to admit
   them), `locked` (nobody new).
4. **Invite rotation**: mint a fresh invite code, instantly invalidating the
   old link. This is our revocation primitive.
5. **Kick, ban, unban**, with the honest limits of a no-accounts system spelled
   out below.
6. **Settings panel**: rename the office, transfer ownership, toggle the
   (not yet built) public leaderboard, manage members and bans.
7. **Real data deletion**: members can delete themselves; owners can delete a
   member. Closes the gap the deployability audit flagged.
8. **Architecture work that this makes unavoidable**: a real migration runner,
   a single permissions choke point, and per-connection message rate limiting.

## What does not ship, and why

- **Accounts (OAuth, passwords, sessions).** Capability identity — a member
  secret in the browser plus `sloppers relink` from a paired machine — already
  carries roles fine, and it keeps the "name, face, you're in" magic that makes
  this fun. The seam for real accounts is named in [Identity](#identity).
- **Postgres, Redis, an SFU, or a service split.** One Node process with SQLite
  is not the bottleneck at the scale this project is at or near. Speculative
  re-platforming would cost weeks and buy latency we cannot currently measure.
  The concrete triggers that would change that are listed in
  [Scale](#scale-what-we-are-deliberately-not-doing-yet).
- **Chat, voice, global leaderboard.** Each is its own cycle. This spec exists
  partly to make them cheap.

---

## Identity

Unchanged and deliberate: a member is `(workspace, display name, avatar)` plus
a random secret held in the browser's localStorage. The paired collector's
device key can mint a one-shot relink URL that restores that identity on a new
browser.

Roles attach to the member row. Nothing about permissions requires knowing who
someone is in the world — only that the socket presenting this secret is that
member. The WebSocket connection *is* the session; there is no second auth
surface to secure.

**The seam for real accounts**, when it arrives: an `accounts` table plus
`members.account_id`, letting one human own members across workspaces and
recover without a paired machine. Nothing in this design blocks that, and
nothing in this design needs it.

## Data model

The load-bearing change is separating a workspace's **identity** from its
**invite code**. Today the invite code is the primary key, which is precisely
why the door cannot be re-keyed: rotating the code would orphan every member
row that points at it. Splitting them makes rotation, ban-survives-rotation,
and stable workspace identity for the future leaderboard all fall out for free.

```sql
CREATE TABLE workspaces (
  id           TEXT PRIMARY KEY,           -- w_<random>, stable forever
  name         TEXT NOT NULL,              -- "the lab", display only
  invite_code  TEXT NOT NULL UNIQUE,       -- the-lab-k4xp2q, rotatable
  settings     TEXT NOT NULL,              -- JSON, zod-validated (see below)
  created_at   INTEGER NOT NULL
);

CREATE TABLE members (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  secret        TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar        TEXT NOT NULL,
  role          TEXT NOT NULL,             -- owner | moderator | member
  status        TEXT NOT NULL,             -- active | kicked | banned
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
-- Partial: only active members reserve a name, so a kicked person can come
-- back as themselves rather than as "ridham2".
CREATE UNIQUE INDEX members_workspace_name
  ON members(workspace_id, lower(display_name)) WHERE status = 'active';

CREATE TABLE workspace_events (        -- moderation log; who did what to whom
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  at           INTEGER NOT NULL,
  actor_id     TEXT,                   -- null for system actions
  action       TEXT NOT NULL,          -- member.kick, invite.rotate, ...
  target_id    TEXT,
  detail       TEXT                    -- short human string, no PII beyond names
);
```

`devices`, `pairings`, `relink_tokens`, `session_watermarks`, and `daily_stats`
keep their shape; their `member_id` foreign keys still resolve because kicking
and banning **do not delete member rows** (see below).

Two decisions worth defending:

**Status column, not a separate bans table.** An earlier sketch had
`bans(workspace_id, member_id, ...)`. But banning by deleting the member would
destroy that member's token history — which the leaderboard will care about —
and would leave a bans table pointing at rows that no longer exist. Keeping the
row and moving it to `status = 'banned'` preserves stats, keeps every foreign
key valid, needs no join to check, and makes the ban list a `WHERE` clause.

**Settings as one JSON column, not columns per toggle.** This project is
explicitly heading toward "a lot of things configurable". A validated JSON blob
means a new toggle is one line in a zod schema and zero migrations; the cost is
that settings are not queryable in SQL, which we never need — settings are read
one workspace at a time, already in memory.

```ts
// packages/protocol/src/workspace.ts — shared by server and the settings UI
export const workspaceSettingsSchema = z.object({
  joinMode: z.enum(['link', 'knock', 'locked']).default('link'),
  /** Consent for the future cross-workspace leaderboard. Off until asked. */
  publicLeaderboard: z.boolean().default(false),
});
```

Reading settings always parses through this schema with defaults applied, so
old rows written before a toggle existed are valid by construction.

### Migration

The current `openDb` does ad-hoc "does this column exist" checks. That was fine
for two columns and is the wrong tool for reshaping tables on a database that
now holds real offices on `sloppers.fly.dev`.

Replace it with a numbered migration runner keyed on SQLite's `user_version`
pragma: an ordered array of `{ version, up(db) }`, each applied in a
transaction, stopping at the first failure with the version that failed. No new
dependency; roughly forty lines.

Migration `002` (the reshape) must preserve every existing office:

1. Create `workspaces`, `members_new`, and `workspace_events`. (SQLite cannot
   add foreign keys in place, so the members reshape is the standard
   create-copy-drop-rename dance, inside one transaction.)
2. For each old `rooms` row: mint a workspace id, copy `name`, set
   `invite_code` to the old `code`, write default settings.
3. Copy members into `members_new`, mapping `room_code` to `workspace_id`.
4. **The oldest member of each workspace by `created_at` becomes owner**;
   everyone else becomes `member`, all with status `active`.
5. Drop `rooms` and `members`, rename `members_new` to `members`, create
   indexes.

Ownership-by-seniority is a guess, and for the demo floor it hands ownership to
a bot. That is acceptable: the demo room is server-managed and its owner never
logs in. It is called out here so it is a decision rather than a surprise.

## Permissions

One module, `packages/server/src/domain/permissions.ts`, is the only place a
role is ever compared. Everything — this cycle's admin ops, and later chat
deletion and voice muting — asks it.

```ts
export type Role = 'owner' | 'moderator' | 'member';
export type Action =
  | 'workspace.rename' | 'workspace.settings' | 'workspace.rotate-invite'
  | 'workspace.transfer' | 'member.kick' | 'member.ban' | 'member.unban'
  | 'member.promote' | 'member.demote' | 'member.delete' | 'knock.decide';

export function can(role: Role, action: Action): boolean;
```

| | owner | moderator | member |
|---|---|---|---|
| rename, settings, rotate invite, transfer, promote/demote, delete member | ✅ | — | — |
| kick, ban, unban, admit/deny knocks | ✅ | ✅ | — |
| leave, delete self | ✅¹ | ✅ | ✅ |

¹ An owner must transfer ownership before leaving or deleting themselves, so a
workspace is never ownerless.

Role comparison alone is not enough, so `can()` is paired with invariants
enforced at the call site and tested as a matrix:

- Nobody may act on a member whose role outranks or equals their own, except an
  owner acting on anyone. (Moderators cannot kick each other.)
- The owner cannot be kicked, banned, demoted, or deleted by anyone.
- Ownership transfer targets an active member of the same workspace; the old
  owner becomes a moderator, not a plain member — losing the keys shouldn't
  also lose the mop.
- Every mutation writes a `workspace_events` row. Moderation without a record is
  how friend groups end up arguing about who did what.

## The door: join modes and knocking

Joining is already three-shaped (resume, invited, create). Join modes add a
fourth state — **knocking** — which is a live connection that is not yet a
member.

- **`link`** — unchanged. Hold the invite code, pick a name, you're in.
- **`knock`** — the invite link gets you to the door. The server creates an
  in-memory knock (id, socket, requested name and avatar, timestamp) and replies
  `{ type: 'knocking' }`. Owners and moderators currently connected receive the
  knock and see a queue; admitting creates the member and hands back the world,
  denying closes the socket with a clear message.
- **`locked`** — the server replies with a `workspace-locked` error. Existing
  members still resume normally; only new memberships are refused.

Knocks live in memory, tied to the waiting socket's lifetime: close the tab and
the knock is gone. This needs no table, no expiry sweep, and no cleanup path,
and the connection budget already caps how many can exist. The honest cost is
that a knock arriving while every moderator is offline is simply missed — the
waiting person sees "nobody's around to let you in yet" and can retry. Making
that durable means a table and a notification story; it is not worth it before
anyone has complained.

Name collision is checked at **admit** time, not knock time, because the name
may be taken while someone waits. The mod sees the failure and the knocker is
asked to pick another name.

Removed identities are refused at the door regardless of join mode. A kicked
member's saved identity is dead, but nothing stops them walking back in as a
fresh member — same name included, thanks to the partial index — if the join
mode allows it. A banned identity is refused permanently.

The same check guards the collector: a `hello` whose device key belongs to a
non-active member is answered with `unknown-device`, so a kicked person's
daemon stops feeding sessions into the office instead of quietly streaming to
a workspace that removed them.

**Where the honesty lives**: with no accounts, a determined banned person can
clear their browser and walk back in through an open link with a new name. The
real enforcement is the combination — ban the identity, rotate the invite,
switch to knock mode — and the settings UI should say exactly that instead of
implying we have something stronger. Anything more (IP bans, fingerprinting) is
both easy to evade and hostile to the privacy promise this project makes.

## Protocol

Admin actions travel over the member's existing authenticated socket. No new
endpoints, no re-authentication per call, one place to check permissions.

```ts
// web → server
{ type: 'admin', op: AdminOp }        // discriminated union, one envelope

type AdminOp =
  | { kind: 'kick';        memberId: string }
  | { kind: 'ban';         memberId: string; reason?: string }
  | { kind: 'unban';       memberId: string }
  | { kind: 'promote';     memberId: string }
  | { kind: 'demote';      memberId: string }
  | { kind: 'transfer';    memberId: string }
  | { kind: 'delete';      memberId: string }   // erase; self-delete allowed
  | { kind: 'rename';      name: string }
  | { kind: 'settings';    settings: WorkspaceSettings }
  | { kind: 'rotate-invite' }
  | { kind: 'knock-admit'; knockId: string }
  | { kind: 'knock-deny';  knockId: string };

// server → web
{ type: 'knocking' }                                   // you are at the door
{ type: 'knocks',    knocks: KnockView[] }             // mods: the queue
{ type: 'workspace', name, inviteCode, settings }      // live config changes
{ type: 'roster',    members: RosterEntry[] }          // mods: incl. removed
{ type: 'removed',   reason: 'kicked' | 'banned' | 'deleted' }
{ type: 'error',     code: 'forbidden' | 'workspace-locked' | ... }
```

`MemberView` — the thing every client already receives for everyone in the
world — gains **only `role`**, which is what the UI needs to badge owners and
reveal admin controls to the people who have them. It keeps listing active
members only.

Who was kicked or banned is moderator business, not room gossip, so it travels
separately: `roster` is sent to owners and moderators when they open the
settings panel and whenever membership changes.

The invite code, by contrast, goes to **everyone** on the `workspace` message.
It is already in every member's address bar, so hiding it in the protocol would
be theater — and inviting a friend is exactly the social act this project is
for. What owners control is not who can *share* the link but what the link
*does*: knock mode turns every shared link into a request rather than an entry,
and rotation kills the ones already out there.

The wire keeps saying `roomCode` and `roomName`. Those field names are a
**published contract**: `sloppers@0.1.1` is on npm and reads them, and renaming
would break every installed collector for a cosmetic gain. So the vocabulary is
fixed deliberately: **workspace** in the database and server domain (matching
where the product is going), **office** in everything a user reads, and `room*`
frozen on the wire with a comment in `protocol` saying why.

## Server structure

`ws.ts` at 357 lines and `room.ts` at 282 are already the two files that make
changes here awkward, and admin ops plus knocks would push both past the point
where they can be held in one head. The split, sized to what this cycle
actually needs:

```
packages/server/src/
  db/
    index.ts          openDb + run migrations
    migrations.ts     numbered migrations, user_version runner
  domain/
    permissions.ts    can() + role invariants          ← chat/voice reuse this
  workspace/
    manager.ts        (was rooms.ts) create/lookup, member CRUD, cleanup
    live.ts           (was room.ts) positions, presence, broadcast
    admin.ts          AdminOp handlers, one per kind
    knocks.ts         pending-join registry
  ws.ts               transport: upgrade, heartbeat, routing, rate limits
  http.ts  ledger.ts  presence.ts  ids.ts  demo.ts  main.ts  index.ts
```

Nothing moves that doesn't need to. `ledger.ts` and `presence.ts` are already
the right size and shape.

## Rate limiting

The deployability audit noted that `move` and `activity` messages have no
per-connection limit; admin ops make that worth closing now. A token bucket per
connection, with concrete budgets so this is testable rather than vibes:

| Message | Sustained | Burst |
|---|---|---|
| `move` | 20/s (client sends 10/s) | 40 |
| `activity` | 1/s | 10 |
| `admin` | 10/min | 15 |

Over budget drops the message and replies with an error; sustained abuse — a
second full bucket drained inside ten seconds — closes the socket. The existing
per-IP join limiter and connection budget stay as they are.

## Testing

- **Permissions matrix** — every (role × action) pair plus the invariants:
  moderator cannot kick moderator, owner cannot be removed, transfer demotes
  the old owner to moderator, last owner cannot leave.
- **Migration** — build a database in the *old* shape with two rooms and
  several members, run the runner, assert every member survived with the right
  workspace, the oldest is owner, invite codes carried over, and re-running is a
  no-op.
- **Knock flow (integration)** — knock, mod sees it, admit produces a world;
  deny closes; name collision at admit is reported cleanly; knocker disconnect
  removes the knock.
- **Kick/ban/rotate (integration)** — kicked socket receives `removed` and
  disconnects; banned identity is refused on resume; a rotated invite code stops
  working while existing members keep resuming.
- **Deletion** — self-delete erases member, stats, watermarks, devices, and
  pairings, and the paired collector is told cleanly (see below).
- Existing suites must stay green; the e2e smoke test exercises the same join
  path and should need no changes beyond the schema.

## Two small fixes this cycle carries

**Collector restart loop.** When the server no longer recognizes a device key,
the collector exits non-zero, which is correct for the "server restarted" case
but makes launchd/systemd restart it every ten seconds forever once a member is
genuinely deleted. Fix: on `unknown-device`, mark the local config unpaired
before exiting, so the restarted daemon prints "not paired — run `sloppers
share` again" and exits cleanly. Member deletion makes this reachable, so it
belongs here.

**Demo room ownership.** The demo floor is server-managed, so migration hands
the title to whichever bot is oldest. That satisfies the never-ownerless
invariant with a member who never connects and therefore never acts — humans
who wander in are plain members and cannot moderate the bots, which is exactly
right. Its settings are forced on every boot (join mode `link`, public
leaderboard off) rather than trusting whatever sits in the row.

## Scale: what we are deliberately not doing yet

The ask included "auth, data, latency and stuff" — here is the honest read.

One Node process with SQLite currently serves: an in-memory world per
workspace, position fan-out at up to 15 Hz, snapshot ingest per collector, and
a leaderboard query per change. The measured cost of an idle office is
approximately zero, and the machine sleeps when empty. The realistic ceiling is
**broadcast fan-out** — every position message to every other member — which is
O(members²) per workspace and starts to matter around 40-60 simultaneously
moving people in one room. Nobody is near that.

Concrete triggers, so this is a decision and not an omission:

| Trigger | Response |
|---|---|
| >40 simultaneously moving members in one workspace | Interest management: only relay positions to members within camera range |
| Multiple server instances needed (HA, regions) | Redis pub/sub for fan-out; SQLite → Postgres for shared state |
| SQLite write contention (never seen; WAL handles our volume) | Batch ledger writes, or Postgres |
| Voice beyond ~8 concurrent speakers per cluster | An SFU (self-hosted LiveKit); mesh P2P until then |
| Data loss risk on the Fly volume | Litestream continuous backup to object storage |

The one piece of infrastructure worth adding **before** it hurts is Litestream,
because the cost of discovering you needed backups is unbounded. It is not in
this cycle's scope but should be the next operational chore.

## What this unlocks

- **Text chat** gets moderation (kick, ban, mute-shaped permissions already
  modeled), a workspace to scope channels to, and roles to gate deletion.
- **Voice** gets the same, plus a settings home for push-to-talk and
  proximity-radius toggles.
- **Global leaderboard** gets stable workspace identity that survives invite
  rotation, and a consent flag that was never opt-out-by-default.
- **Everything after** gets migrations, so schema changes stop being scary.
