import {
  type AdminOp,
  type MemberRole,
  type RosterEntry,
  roomNameSchema,
  type WorkspaceSettings,
} from '@sloppers/protocol';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { sendAdmin } from '../net/socket.js';
import { useStore } from '../store.js';
import { useModalManners } from './modal.js';

const JOIN_MODES: { value: WorkspaceSettings['joinMode']; label: string; consequence: string }[] = [
  {
    value: 'link',
    label: 'Anyone with the link',
    consequence: 'Share the link and they walk straight in.',
  },
  {
    value: 'knock',
    label: 'Ask to join',
    consequence: 'Link holders wait until you or a moderator lets them in.',
  },
  {
    value: 'locked',
    label: 'Closed',
    consequence: 'Nobody new gets in. People already here keep their spot.',
  },
];

/**
 * Every zone this runtime knows, for the picker's list.
 *
 * `Intl.supportedValuesOf` is the canonical set — about four hundred entries —
 * and it is the right source for a *list*, where the tz database's aliases
 * would only be duplicates under different spellings. It is emphatically not
 * what *validates* a zone: which of an alias pair counts as canonical differs
 * between engines and moves between releases (this Node calls it
 * `Asia/Calcutta`; plenty of browsers report `Asia/Kolkata`), and `UTC` itself
 * is absent. So the list is a convenience, the server validates by
 * construction, and the office's own zone is folded in below — whichever
 * spelling it is stored under, the select shows where the office actually
 * stands rather than falling back to whatever sorts first.
 *
 * Computed once. Four hundred strings out of ICU on every render of a panel
 * that reopens on every visit is the kind of cost that does not show up until
 * somebody opens it on a phone.
 */
const KNOWN_ZONES: string[] = (() => {
  try {
    return [...(Intl.supportedValuesOf?.('timeZone') ?? [])];
  } catch {
    // An engine without it still gets a working picker, just a short one: the
    // office's own zone and UTC, which is the whole of what this owner needs
    // to see where they stand and get back to the default.
    return [];
  }
})();

/** `Asia/Kolkata` → `Asia`. Zones with no region (`UTC`) group together. */
function regionOf(zone: string): string {
  const slash = zone.indexOf('/');
  return slash === -1 ? 'Other' : zone.slice(0, slash);
}

/**
 * `Asia/Kolkata` → `Kolkata`, `America/Argentina/Buenos_Aires` →
 * `Buenos Aires, Argentina`. The `<option>`'s *value* stays the IANA name —
 * this is only what a person reads and types against.
 */
function cityLabel(zone: string): string {
  const parts = zone.split('/');
  if (parts.length === 1) return zone;
  const city = (parts.at(-1) ?? zone).replaceAll('_', ' ');
  // A middle segment (America/Argentina/…, America/Indiana/…) is a state or
  // country worth keeping — two zones can share a city name.
  return parts.length > 2 ? `${city}, ${parts[1]?.replaceAll('_', ' ')}` : city;
}

/**
 * The offset this zone is on *right now*, as `UTC+05:30`.
 *
 * Right now and not in general, deliberately: half the world's zones change
 * offset twice a year, and the number an owner needs in order to recognise
 * their own zone is the one their clock is keeping today. `longOffset` renders
 * UTC itself as a bare `GMT`, which would read as a missing value rather than
 * as zero.
 */
function utcOffsetLabel(zone: string, at: number): string {
  try {
    const rendered = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (!rendered) return '';
    return rendered === 'GMT' ? 'UTC+00:00' : rendered.replace('GMT', 'UTC');
  } catch {
    return '';
  }
}

/**
 * Which clock the office's day is cut on.
 *
 * A native `<select>`: four hundred entries, grouped by region, with the
 * browser's own type-to-search doing the finding. A combobox library would
 * search a little better and cost a dependency, a bundle and a set of keyboard
 * behaviours to get right — for a control most offices touch once.
 *
 * Changing it rewrites nothing. The day keys in the ledger are the days people
 * did the work; this only moves the window the office reads them through, so
 * the board re-reads and that is the whole of it. The note says the one
 * consequence that is not obvious from the control: where midnight falls.
 */
function TimezoneField({ zone, onPick }: { zone: string; onPick: (zone: string) => void }) {
  // The office's own zone always appears, even if this browser's ICU does not
  // list it — otherwise the select would silently render as blank, or worse,
  // as somebody else's zone.
  const zones = [...new Set([...KNOWN_ZONES, 'UTC', zone])].sort();
  const regions = [...new Set(zones.map(regionOf))].sort((a, b) =>
    a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b),
  );
  const offset = utcOffsetLabel(zone, Date.now());

  return (
    <>
      <select
        className="input settings-select"
        aria-label="office timezone"
        value={zone}
        onChange={(e) => onPick(e.target.value)}
      >
        {regions.map((region) => (
          <optgroup key={region} label={region}>
            {zones
              .filter((candidate) => regionOf(candidate) === region)
              .map((candidate) => (
                <option key={candidate} value={candidate}>
                  {/* City first: a native select's type-ahead matches from
                      the start of the text, and nobody types "Asia/" to find
                      Kolkata. iOS's wheel has no type-ahead at all, where the
                      city-first reading is simply the easier scan. */}
                  {cityLabel(candidate)}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <p className="settings-note">
        The board&rsquo;s day starts at midnight in this zone. Right now that is {zone}
        {offset ? `, ${offset}` : ''}.
      </p>
    </>
  );
}

/** The two ops that take somebody out of the office; both ask first. */
type Removal = Extract<AdminOp, { kind: 'kick' | 'ban' }>;

/**
 * The ops a person's own row asks about before sending. Two take them out of
 * the office; the third gives them the whole thing.
 */
type PersonAsk = Removal | Extract<AdminOp, { kind: 'transfer' }>;

/**
 * The ops this panel asks about before it sends them: the three above, plus
 * the one that takes the door key off everybody at once, including the person
 * clicking.
 */
type Confirmable = PersonAsk | Extract<AdminOp, { kind: 'rotate-invite' }>;

/**
 * Which control is waiting on an answer. The office refuses an op with a
 * sentence and no indication of what it refused, so this is what puts the
 * answer back beside the button that asked instead of in a banner at the top
 * of a long panel, describing something three sections down.
 */
type Spot =
  | 'knocks'
  | 'office'
  | 'clock'
  | 'door'
  | 'board'
  | 'device'
  | 'leave'
  | `person:${string}`;

const RANK: Record<MemberRole, number> = { owner: 2, moderator: 1, member: 0 };

/**
 * Mirrors the server's `canActOn`: a moderator may not remove a peer, and
 * nobody reaches the owner. The panel shows a refusal now, but "they outrank
 * you" is still a worse answer than never offering the button — a control
 * that can only disappoint should not be there to click.
 */
function outranks(viewer: MemberRole | null, target: MemberRole): boolean {
  return viewer !== null && RANK[viewer] > RANK[target];
}

/** Whether this viewer could remove this person right now. */
function removable(viewer: MemberRole | null, target: RosterEntry | undefined): boolean {
  return target !== undefined && target.status === 'active' && outranks(viewer, target.role);
}

/**
 * Whether the keys could go to this person. Mirrors the server's `transfer`,
 * which resolves an *active* member and refuses the owner their own keys —
 * and unlike a removal, rank is no bar: a moderator is the likeliest heir
 * there is, which is the whole reason the owner made one.
 */
function inheritable(target: RosterEntry | undefined): boolean {
  return target !== undefined && target.status === 'active' && target.role !== 'owner';
}

/**
 * The door, the people, and the way out. Everything here is one `AdminOp` on
 * the wire; the server decides all of it again, so the role gating below is
 * about not offering somebody a button that can only disappoint them.
 */
export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  // The body is mounted only while the panel is open, so each visit starts
  // from the office's real name with no half-armed "are you sure" left over.
  if (!open || !settings) return null;
  return <SettingsBody settings={settings} />;
}

function SettingsBody({ settings }: { settings: WorkspaceSettings }) {
  const role = useStore((s) => s.myRole);
  const roster = useStore((s) => s.roster);
  const knocks = useStore((s) => s.knocks);
  const roomName = useStore((s) => s.roomName);
  const roomCode = useStore((s) => s.roomCode);
  const you = useStore((s) => s.you);
  const yourName = useStore((s) => (s.you ? (s.members[s.you]?.displayName ?? '') : ''));
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const adminError = useStore((s) => s.adminError);
  const setAdminError = useStore((s) => s.setAdminError);
  const [name, setName] = useState(roomName);
  const [confirmDelete, setConfirmDelete] = useState('');
  // One armed question for the whole panel: two irreversible questions open at
  // once is two chances to answer the wrong one.
  const [pending, setPending] = useState<Confirmable | null>(null);
  /** Where the op we are waiting on an answer for was sent from. */
  const [asked, setAsked] = useState<Spot | null>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closePanel = useCallback(() => setSettingsOpen(false), [setSettingsOpen]);

  /**
   * Send an op and remember which control sent it. Clearing first matters:
   * a refusal still on screen from the last click must not be read as the
   * answer to this one, and an op that lands quietly leaves nothing behind.
   */
  const act = (spot: Spot, op: AdminOp) => {
    setAdminError(null);
    setAsked(spot);
    sendAdmin(op);
  };

  /** The refusal, if there is one and we know what it is about. */
  const refusal = asked && adminError ? { spot: asked, message: adminError } : null;
  const refusalAt = (spot: Spot) =>
    refusal?.spot === spot ? (
      // `alert` because it answers something the person did a moment ago, and
      // it appears without the focus ever moving to it.
      <p className="join-error" role="alert">
        {refusal.message}
      </p>
    ) : null;

  // A refusal is about a visit to this panel. Leaving one in the store would
  // greet the next visit with an answer to a click from the last one.
  useEffect(() => () => setAdminError(null), [setAdminError]);

  const isOwner = role === 'owner';
  const canModerate = role === 'owner' || role === 'moderator';

  // The person you armed may have been removed by another admin while the
  // question sat open, or the keys may have changed hands under a half-armed
  // rotation. Take the question away rather than leave it asking about
  // something that already happened.
  const stillAskable = (op: Confirmable): boolean => {
    if (op.kind === 'rotate-invite') return isOwner;
    const target = roster.find((entry) => entry.id === op.memberId);
    if (op.kind === 'transfer') return isOwner && inheritable(target);
    return removable(role, target);
  };
  const armed = pending && stillAskable(pending) ? pending : null;
  const armedPerson = armed && armed.kind !== 'rotate-invite' ? armed : null;
  const armedRotate = armed?.kind === 'rotate-invite';
  useEffect(() => {
    if (!armed) setPending(null);
  }, [armed]);

  // A rename — from this tab, another device, anywhere — is the new truth.
  // The draft follows it, or "Rename" would sit enabled against a name the
  // office stopped having.
  useEffect(() => {
    setName(roomName);
  }, [roomName]);

  // Roster pushes go out when the office changes, and a browser's own arrival
  // lands before its socket is listening — so somebody who joined a settled
  // office has never been told who is in it. Ask once, on the way in. Changes
  // after that arrive on their own.
  useEffect(() => {
    if (canModerate) sendAdmin({ kind: 'roster' });
  }, [canModerate]);

  useModalManners(scrimRef, dialogRef, closePanel);

  const inviteUrl = `${location.origin}/?room=${encodeURIComponent(roomCode)}`;
  // Both the door and the board are one `settings` op, so the spot is what
  // tells a refusal which of the two to appear under.
  const update = (spot: Spot, patch: Partial<WorkspaceSettings>) =>
    act(spot, { kind: 'settings', settings: { ...settings, ...patch } });

  return (
    <div className="modal-scrim" ref={scrimRef}>
      {/* tabIndex -1: not a tab stop, but the dialog can be handed focus when it opens. */}
      <section
        className="settings-panel panel"
        role="dialog"
        aria-modal="true"
        aria-label="office settings"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="settings-head">
          <span className="panel-title">Office settings</span>
          <button
            type="button"
            className="close"
            aria-label="close"
            onClick={() => setSettingsOpen(false)}
          >
            ×
          </button>
        </header>

        {knocks.length > 0 && canModerate ? (
          <section className="settings-section">
            <h3 className="settings-title">Waiting to come in</h3>
            {knocks.map((knock) => (
              <div key={knock.id} className="settings-row">
                <span>{knock.displayName}</span>
                <span className="settings-actions">
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Let in: ${knock.displayName}`}
                    onClick={() => act('knocks', { kind: 'knock-admit', knockId: knock.id })}
                  >
                    Let in
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    aria-label={`Turn away: ${knock.displayName}`}
                    onClick={() => act('knocks', { kind: 'knock-deny', knockId: knock.id })}
                  >
                    Turn away
                  </button>
                </span>
              </div>
            ))}
            {refusalAt('knocks')}
          </section>
        ) : null}

        {isOwner ? (
          <section className="settings-section">
            <h3 className="settings-title">Office</h3>
            <div className="join-invite-row">
              <input
                className="input"
                aria-label="office name"
                value={name}
                // Whatever the server takes, no more — a longer name would be
                // typed in full and refused on arrival.
                maxLength={roomNameSchema.maxLength ?? undefined}
                onChange={(e) => setName(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-quiet"
                disabled={!name.trim() || name.trim() === roomName}
                onClick={() => act('office', { kind: 'rename', name: name.trim() })}
              >
                Rename
              </button>
            </div>
            <TimezoneField
              zone={settings.timezone}
              onPick={(timezone) => update('clock', { timezone })}
            />
            {refusalAt('clock')}
            <p className="settings-note">
              Invite link: <code>{inviteUrl}</code>
            </p>
            {armedRotate ? (
              <RotateQuestion
                onConfirm={() => {
                  act('office', { kind: 'rotate-invite' });
                  setPending(null);
                }}
                onNeverMind={() => setPending(null)}
              />
            ) : (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setPending({ kind: 'rotate-invite' })}
              >
                Rotate invite link
              </button>
            )}
            <p className="settings-note">
              Rotating makes a brand new link. Every link you have already shared stops working,
              including the one in your own address bar. Nobody loses their seat — everyone here
              moves across with the office, and so does anyone offline whose browser still has the
              old link. Send the new one to the rest, or they come back strangers.
            </p>
            {refusalAt('office')}
          </section>
        ) : null}

        {isOwner ? (
          <section className="settings-section">
            <h3 className="settings-title">The door</h3>
            {JOIN_MODES.map((mode) => (
              <label key={mode.value} className="settings-choice">
                <input
                  type="radio"
                  name="joinMode"
                  checked={settings.joinMode === mode.value}
                  onChange={() => update('door', { joinMode: mode.value })}
                />
                <span>
                  <strong>{mode.label}</strong>
                  <br />
                  <span className="settings-note">{mode.consequence}</span>
                </span>
              </label>
            ))}
            {refusalAt('door')}
          </section>
        ) : null}

        {isOwner ? (
          <section className="settings-section">
            <h3 className="settings-title">Leaderboard</h3>
            <label className="settings-choice">
              <input
                type="checkbox"
                checked={settings.publicLeaderboard}
                onChange={(e) => update('board', { publicLeaderboard: e.target.checked })}
              />
              <span>
                Let this office appear on the public board once it exists.
                <br />
                <span className="settings-note">
                  Off by default. Only totals would be shared, never session details.
                </span>
              </span>
            </label>
            {refusalAt('board')}
          </section>
        ) : null}

        {canModerate ? (
          <section className="settings-section">
            <h3 className="settings-title">People</h3>
            {roster.map((member) => (
              <PersonRow
                key={member.id}
                member={member}
                role={role}
                armed={armedPerson?.memberId === member.id ? armedPerson : null}
                refusal={refusalAt(`person:${member.id}`)}
                onArm={setPending}
                onDisarm={() => setPending(null)}
                onAct={(op) => act(`person:${member.id}`, op)}
              />
            ))}
            {/* Rotating the link and changing the door are the owner's alone,
                so only the owner is told to reach for them. A moderator being
                sent after two controls that are not in their panel is the one
                sentence in here that read like a different product. */}
            <p className="settings-note">
              Banning stops that person coming back as themselves. Someone determined can still
              return under a new name
              {isOwner
                ? ', so pair it with rotating the link or asking people to knock.'
                : ' — the owner can rotate the link or switch the door to knocking if that starts happening.'}
            </p>
          </section>
        ) : null}

        <section className="settings-section">
          <h3 className="settings-title">This device</h3>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => act('device', { kind: 'link-device' })}
          >
            Sign in on another device
          </button>
          <p className="settings-note">Makes a one-time link, good for ten minutes.</p>
          {refusalAt('device')}
        </section>

        <section className="settings-section">
          <h3 className="settings-title">Leave for good</h3>
          {isOwner ? (
            <p className="settings-note">
              You are holding the keys. Hand the office over first — there is a button on everyone's
              row up in People — or there is nobody left to open the door.
            </p>
          ) : (
            <>
              <p className="settings-note">
                Deletes you and everything recorded about your agents here. Type your name to
                confirm.
              </p>
              <div className="join-invite-row">
                <input
                  className="input"
                  aria-label="your name"
                  value={confirmDelete}
                  placeholder="your name"
                  onChange={(e) => setConfirmDelete(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={!you || !yourName || confirmDelete.trim() !== yourName}
                  onClick={() => you && act('leave', { kind: 'delete', memberId: you })}
                >
                  Delete me
                </button>
              </div>
              {refusalAt('leave')}
            </>
          )}
        </section>
      </section>
    </div>
  );
}

/**
 * Rotating the invite arms first and fires second, for the same reason a
 * removal does: it is one click, it cannot be undone, and what it costs is
 * not obvious from the button. Every link already handed out stops working
 * — the one in the owner's own address bar included, so the tab asking the
 * question is one of the things the answer breaks.
 *
 * What it does *not* cost is anybody's seat: connected browsers re-file their
 * credentials under the new code as the change arrives, and an offline one
 * does it on the way back in through the old link. The people at risk are the
 * ones who are away and will next reach for a link somebody sent them, which
 * is why the question ends by pointing at them rather than at the link.
 */
function RotateQuestion({
  onConfirm,
  onNeverMind,
}: {
  onConfirm: () => void;
  onNeverMind: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // The button that armed this just vanished; focus follows the question.
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div className="settings-row settings-row-asking">
      <span className="settings-note">
        Rotate the invite link? Every link you have already shared stops working — including the one
        in this tab's address bar. Nobody in the office loses their seat, but anyone who is away
        right now needs the new link from you before they can get back to theirs.
      </span>
      <span className="settings-actions">
        <button type="button" className="btn btn-danger" ref={confirmRef} onClick={onConfirm}>
          Yes, rotate
        </button>
        <button type="button" className="btn btn-quiet" onClick={onNeverMind}>
          Never mind
        </button>
      </span>
    </div>
  );
}

/**
 * One person on the roster. Kicking, banning and handing the office over arm
 * first and fire second: the row itself asks, because a misplaced click here
 * costs somebody their seat — or costs the owner the office, which only the
 * person they just gave it to can give back. An unbanned person comes back a
 * stranger, stats and all gone. Which row is armed belongs to the panel, not
 * to the row, so arming one question puts any other away.
 *
 * Every action carries `label: name` as its accessible name. A list of
 * identical "Remove" buttons is unusable read aloud, and the visible label
 * still leads, so speaking the button by name works too.
 */
/**
 * What an armed question says, and what its answer is called. Three ops with
 * three different costs; one shared "Are you sure?" would be the panel
 * declining to say which of them is about to happen — and the one that hands
 * over the office is not a bigger removal, it is a different thing entirely.
 */
function askAbout(op: PersonAsk, name: string): { question: string; confirm: string } {
  switch (op.kind) {
    case 'kick':
      return {
        question: `Remove ${name}? The link still works, so they can walk back in.`,
        confirm: 'Yes, remove',
      };
    case 'ban':
      return {
        question: `Ban ${name}? Unbanning later brings them back a stranger, with none of their stats.`,
        confirm: 'Yes, ban',
      };
    case 'transfer':
      return {
        question: `Hand the whole office to ${name}? They get the invite link, the door, everybody's roles and the last word on all of it. You stay on as a moderator, and only they can hand it back.`,
        confirm: 'Yes, hand it over',
      };
  }
}

function PersonRow({
  member,
  role,
  armed,
  refusal,
  onArm,
  onDisarm,
  onAct,
}: {
  member: RosterEntry;
  role: MemberRole | null;
  /** The question this row is asking, or null when it is just a row. */
  armed: PersonAsk | null;
  /** The office's answer to this row's last op, if it refused one. */
  refusal: ReactNode;
  onArm: (op: PersonAsk) => void;
  onDisarm: () => void;
  onAct: (op: AdminOp) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // The button that armed this just vanished; focus follows the question
  // rather than falling back to the top of the page.
  useEffect(() => {
    if (armed) confirmRef.current?.focus();
  }, [armed]);

  const isOwner = role === 'owner';
  const canRemove = removable(role, member);

  if (armed) {
    const asking = askAbout(armed, member.displayName);
    return (
      <>
        <div className="settings-row settings-row-asking">
          <span className="settings-note">{asking.question}</span>
          <span className="settings-actions">
            <button
              type="button"
              className="btn btn-danger"
              ref={confirmRef}
              aria-label={`${asking.confirm}: ${member.displayName}`}
              onClick={() => {
                onAct(armed);
                onDisarm();
              }}
            >
              {asking.confirm}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              aria-label={`Never mind: ${member.displayName}`}
              onClick={onDisarm}
            >
              Never mind
            </button>
          </span>
        </div>
        {refusal}
      </>
    );
  }

  return (
    <>
      <div className="settings-row">
        <span>
          {member.displayName}
          {member.role !== 'member' ? <em className="settings-badge">{member.role}</em> : null}
          {member.status !== 'active' ? (
            <em className="settings-badge muted">{member.status}</em>
          ) : null}
        </span>
        <span className="settings-actions">
          {isOwner && member.status === 'active' && member.role === 'member' ? (
            <button
              type="button"
              className="btn btn-quiet"
              aria-label={`Make moderator: ${member.displayName}`}
              onClick={() => onAct({ kind: 'promote', memberId: member.id })}
            >
              Make moderator
            </button>
          ) : null}
          {isOwner && member.role === 'moderator' ? (
            <button
              type="button"
              className="btn btn-quiet"
              aria-label={`Step down: ${member.displayName}`}
              onClick={() => onAct({ kind: 'demote', memberId: member.id })}
            >
              Step down
            </button>
          ) : null}
          {/* The one control in this panel that ends the owner's own authority
              over the office — the server has always taken the op, and the
              panel spent a release telling people to use a button that was
              never built. Offered on moderators as readily as on members: the
              owner picked them, which is the closest thing to a nomination
              the office keeps. */}
          {isOwner && inheritable(member) ? (
            <button
              type="button"
              className="btn btn-quiet"
              aria-label={`Hand over office: ${member.displayName}`}
              onClick={() => onArm({ kind: 'transfer', memberId: member.id })}
            >
              Hand over office
            </button>
          ) : null}
          {canRemove ? (
            <>
              <button
                type="button"
                className="btn btn-quiet"
                aria-label={`Remove: ${member.displayName}`}
                onClick={() => onArm({ kind: 'kick', memberId: member.id })}
              >
                Remove
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                aria-label={`Ban: ${member.displayName}`}
                onClick={() => onArm({ kind: 'ban', memberId: member.id })}
              >
                Ban
              </button>
            </>
          ) : null}
          {member.status === 'banned' && outranks(role, member.role) ? (
            <button
              type="button"
              className="btn btn-quiet"
              aria-label={`Unban: ${member.displayName}`}
              onClick={() => onAct({ kind: 'unban', memberId: member.id })}
            >
              Unban
            </button>
          ) : null}
        </span>
      </div>
      {refusal}
    </>
  );
}
