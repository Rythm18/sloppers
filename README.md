# sloppers

A pixel office where your team's coding agents show up for work.

Everyone walks around a shared office in the browser. Each avatar carries a
live status derived from the coding-agent sessions — Claude Code, Codex CLI —
running on that person's machine: what they're building, which model, whether
the agents are grinding or blocked waiting for a human, and how many tokens
they've burned today. Walk up to someone to see what their machine is up to.

![the sloppers office: avatars with live agent-status bubbles and a daily token leaderboard](docs/media/office.jpg)

## Why

Teams that run coding agents all day have a new kind of presence: half the
"work" happening at any moment is machines cooking while humans think, review,
or sleep. sloppers makes that visible and a little bit social — ambient
awareness of who's deep in something, whose agent needs input, and a friendly
daily scoreboard for the tokenmaxers.

- **Join is browser-only.** Name an office, name yourself, pick a face —
  you're in. The invite is just a link carrying an unguessable code (like
  `the-lab-k4xp2q`), so only people you send it to can find the place. No
  accounts, no passwords. Whoever opens an office holds its keys and decides
  how much the link is worth: walk straight in, wait to be let in, or nobody
  new at all.
- **Sharing is one paste, once.** The office mints you a command like
  `npx sloppers@latest share K4X-P2Q@your-office.dev`; run it on the machine
  where your agents live and your avatar is live from then on (auto-start
  included). One machine can serve several offices, a directory each. New
  laptop or cleared browser? `sloppers relink` prints a link that signs you
  back in as yourself.
- **Privacy is enforced at the source.** The collector reads local session
  files and sends only derived status — project, branch, model, state, token
  counts, a session title. Never prompts, code, or file contents, and never a
  directory path: the office sees a project name, not where it lives on disk.
  Every field can be hidden (`sloppers hide tokens`), sharing can be paused
  (`sloppers pause`), and the collector is ~3k lines of readable TypeScript
  you can audit.

## Presence at a glance

| state | meaning |
| --- | --- |
| 🟢 active | human at the desk, agents working |
| 🟠 grinding | agents working, human away — the machines are cooking |
| 🔴 needs attention | an agent is blocked waiting on its human |
| ⚪ afk / offline | quiet |

## The door, and who holds the keys

Every office starts wide open. The owner changes that in **Settings**:

| door | what the link does |
| --- | --- |
| anyone with the link | they walk straight in |
| ask to join | they wait outside until somebody lets them in |
| closed | nobody new gets in; everyone already inside keeps their spot |

On **ask to join**, whoever can answer the door sees people waiting in their
settings panel and either lets them in or turns them away. The person
knocking is told whether anybody who *could* answer is actually online, so
knocking at an empty office doesn't feel like being ignored. Nothing is
written down until they're let in — close the tab and the knock is gone.

Three roles:

- **owner** — one per office: whoever opened it, or whoever walks in first if
  the office is ever left without one. Renames the place, sets the door,
  rotates the invite, promotes and demotes, removes anyone, and hands the keys
  on. An owner has to hand them over before deleting themselves, or there's
  nobody left to open the door.
- **moderator** — answers knocks, kicks, bans and unbans. Not each other, and
  not the owner.
- **member** — walks around, shares their agents.

Kicking asks somebody to leave and they may come back. Banning stops them
coming back as themselves; someone determined can still return under a new
name, so pair it with rotating the invite — which mints a new code and
retires the old link for everyone, you included.

## Run your own office

One process, one SQLite file. With Docker:

```sh
git clone https://github.com/Rythm18/sloppers && cd sloppers
docker compose up --build
# open http://localhost:8787
```

Or from source (Node ≥ 20, pnpm):

```sh
pnpm install
pnpm build
node packages/server/dist/main.js            # http://localhost:8787
```

Demo mode adds a `demo` room full of simulated teammates — useful for trying
the thing without three friends online. From source, pass `--demo`; in
Docker, set the `SLOPPERS_DEMO=1` environment variable:

```sh
node packages/server/dist/main.js --demo
# open http://localhost:8787/?room=demo
```

Environment: `PORT` (default 8787), `DATA_DIR` (default `./data`), `WEB_DIST`
(defaults to the sibling web build), `TRUST_PROXY=1` when behind a reverse
proxy (enables client IPs from `X-Forwarded-For` for rate limiting).

**Behind a reverse proxy** (nginx/Caddy/Traefik): terminate TLS there, and
make sure it forwards the `Host` header and WebSocket upgrades
(`Upgrade`/`Connection`) plus `X-Forwarded-Proto` — pairing commands and
invite links derive their host and scheme from those. Set `TRUST_PROXY=1`.

**Operations**: all durable state is one file, `$DATA_DIR/sloppers.db` —
back that up and you've backed up everything. Logs go to stdout.

## Share your agents

From inside the office, click **Share agents** and paste the command it gives
you into a terminal on your dev machine. That's it — the collector watches
`~/.claude/projects` and `~/.codex/sessions` via filesystem events, installs
itself as a launchd/systemd user service, and reconnects on its own.

Useful commands afterwards:

```sh
sloppers status        # every workspace, what it claims, what's routed there
sloppers pause [ws]    # stop broadcasting (stays paired)
sloppers hide tokens   # per-field visibility: title|project|branch|model|tokens
sloppers relink [ws]   # sign a fresh browser back in as you
sloppers uninstall     # remove auto-start
```

`[ws]` names one office by its room code; leave it off and the command
applies to all of them.

### One machine, several offices

Pair as many times as you like. Each pairing claims some directories, and a
session goes to the first workspace whose pattern claims the directory it's
running in:

```sh
sloppers share K4X-P2Q@work.example.com --match '~/work/**'
sloppers share H7M-Q1B@sideproject.dev  --match '~/hacks/**'
```

The first pairing on a machine claims everything — which is exactly what a
single office has always done — and a pairing that claims everything is
always the fallback: it sorts behind every specific pattern, so the catch-all
you already had can't starve a workspace you add later. If some *other*
pattern really would swallow the new one, `sloppers share` says so at the
moment it becomes true rather than leaving you to wonder why the new office
stays silent.

A session in a directory nobody claimed goes nowhere. That is the right
answer — you never paired it — but it is a silent one, so `sloppers status`
lists those sessions too, alongside what each workspace claims and the config
file to edit if you got a pattern wrong.

### A new browser

`sloppers relink` prints a one-time link, good for ten minutes, that signs a
fresh browser back in as you — cleared storage, a second laptop, a phone. If
you're already signed in somewhere, **Settings → This device → Sign in on
another device** does the same from inside the office.

## What the numbers mean

Usage is counted where the work happened, not where it was noticed.

- **Bucketed by day and model.** Every count carries the local day and the
  model it was billed under, so a session running past midnight splits across
  both days instead of landing wholly on the one it ended on, and a session
  that switched models is split between them.
- **Subagents count.** A subagent writes its own transcript, and those
  transcripts carry roughly half the tokens a machine actually burns. They
  used to be discarded. Their spend now counts toward the session that
  spawned them, which still appears as one session, not two.
- **Active minutes are measured, not estimated.** Each day is a map of which
  of its 1440 minutes saw agent activity, built from the timestamps in the
  transcripts themselves. Two agents working the same minute count once.
- **Cost is a list-price estimate, and says so.** Tokens multiplied by the
  vendors' own published prices — it knows nothing about subscriptions, plan
  credits or negotiated rates, so it is not a bill. If a day used a model
  with no published price, no figure is shown at all: a partial sum would
  read as a complete, smaller one.

Because the counts are cumulative per bucket rather than per session,
re-sending a snapshot, restarting the collector, or restarting the server
adds nothing.

## How it works

```
dev machine                        server                       browsers
~/.claude, ~/.codex ──fs events──▸ collector ──ws──▸ rooms ──ws──▸ office
(read locally, filtered locally)             presence · token ledger · leaderboard
```

Three parts, one wire contract ([`packages/protocol`](packages/protocol)):
the collector daemon, a single-process server (Hono + ws + SQLite), and the
office web app (Phaser 3 + React). Full design notes in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

All the pixel art is original and generated at build time by
[a script](packages/web/scripts/gen-assets.mjs) — no asset packs, no license
strings attached.

## Add your harness

Claude Code and Codex CLI are built in. An adapter is one small file that
teaches the collector to read another harness's on-disk session format —
Gemini CLI, opencode, aider, whatever you run. See
[CONTRIBUTING.md](CONTRIBUTING.md#writing-a-harness-adapter).

## Development

```sh
pnpm install
pnpm build          # protocol → collector/server → web
pnpm test           # unit + integration + headless e2e
pnpm lint           # biome
pnpm demo           # build and serve a demo office
```

## License

[MIT](LICENSE)
