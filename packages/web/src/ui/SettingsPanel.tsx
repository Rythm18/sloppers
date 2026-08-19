import {
  type AdminOp,
  type MemberRole,
  type RosterEntry,
  roomNameSchema,
  type WorkspaceSettings,
} from '@sloppers/protocol';
import { useEffect, useRef, useState } from 'react';
import { sendAdmin } from '../net/socket.js';
import { useStore } from '../store.js';

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

/** The two ops that take somebody out of the office; both ask first. */
type Removal = Extract<AdminOp, { kind: 'kick' | 'ban' }>;

const RANK: Record<MemberRole, number> = { owner: 2, moderator: 1, member: 0 };

/**
 * Mirrors the server's `canActOn`: a moderator may not remove a peer, and
 * nobody reaches the owner. Without it the panel offers buttons the server
 * refuses with "they outrank you" — a refusal this screen has nowhere to put,
 * so the click would look like nothing at all.
 */
function outranks(viewer: MemberRole | null, target: MemberRole): boolean {
  return viewer !== null && RANK[viewer] > RANK[target];
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href]';

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
  // Who is in the room, as one comparable string: presence and token counts
  // churn constantly, and only arrivals and departures are worth a refetch.
  const whoIsHere = useStore((s) => Object.keys(s.members).sort().join(' '));
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const [name, setName] = useState(roomName);
  const [confirmDelete, setConfirmDelete] = useState('');
  const dialogRef = useRef<HTMLElement>(null);

  const isOwner = role === 'owner';
  const canModerate = role === 'owner' || role === 'moderator';

  // A rename — from this tab, another device, anywhere — is the new truth.
  // The draft follows it, or "Rename" would sit enabled against a name the
  // office stopped having.
  useEffect(() => {
    setName(roomName);
  }, [roomName]);

  // The server pushes the roster when it moderates somebody, not when the
  // door opens — so a panel opened in a quiet office would show an empty
  // room, and somebody who walked in a moment ago would not be there to
  // remove. Ask on the way in, and again whenever the room's population
  // changes underneath.
  useEffect(() => {
    if (canModerate && whoIsHere) sendAdmin({ kind: 'roster' });
  }, [canModerate, whoIsHere]);

  // Modal manners: focus starts inside, Tab stays inside, Escape leaves, and
  // whatever had focus before gets it back.
  useEffect(() => {
    const dialog = dialogRef.current;
    const restoreTo = document.activeElement;
    dialog?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const stops = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = stops[0];
      const last = stops.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (restoreTo instanceof HTMLElement) restoreTo.focus();
    };
  }, [setSettingsOpen]);

  const inviteUrl = `${location.origin}/?room=${encodeURIComponent(roomCode)}`;
  const update = (patch: Partial<WorkspaceSettings>) =>
    sendAdmin({ kind: 'settings', settings: { ...settings, ...patch } });

  return (
    <div className="modal-scrim">
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
                    onClick={() => sendAdmin({ kind: 'knock-admit', knockId: knock.id })}
                  >
                    Let in
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    aria-label={`Turn away: ${knock.displayName}`}
                    onClick={() => sendAdmin({ kind: 'knock-deny', knockId: knock.id })}
                  >
                    Turn away
                  </button>
                </span>
              </div>
            ))}
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
                onClick={() => sendAdmin({ kind: 'rename', name: name.trim() })}
              >
                Rename
              </button>
            </div>
            <p className="settings-note">
              Invite link: <code>{inviteUrl}</code>
            </p>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => sendAdmin({ kind: 'rotate-invite' })}
            >
              Rotate invite link
            </button>
            <p className="settings-note">
              Rotating makes a brand new link. Every link you have already shared stops working,
              including the one in your own address bar.
            </p>
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
                  onChange={() => update({ joinMode: mode.value })}
                />
                <span>
                  <strong>{mode.label}</strong>
                  <br />
                  <span className="settings-note">{mode.consequence}</span>
                </span>
              </label>
            ))}
          </section>
        ) : null}

        {isOwner ? (
          <section className="settings-section">
            <h3 className="settings-title">Leaderboard</h3>
            <label className="settings-choice">
              <input
                type="checkbox"
                checked={settings.publicLeaderboard}
                onChange={(e) => update({ publicLeaderboard: e.target.checked })}
              />
              <span>
                Let this office appear on the public board once it exists.
                <br />
                <span className="settings-note">
                  Off by default. Only totals would be shared, never session details.
                </span>
              </span>
            </label>
          </section>
        ) : null}

        {canModerate ? (
          <section className="settings-section">
            <h3 className="settings-title">People</h3>
            {roster.map((member) => (
              <PersonRow key={member.id} member={member} role={role} />
            ))}
            <p className="settings-note">
              Banning stops that person coming back as themselves. Someone determined can still
              return under a new name, so pair it with rotating the link or asking people to knock.
            </p>
          </section>
        ) : null}

        <section className="settings-section">
          <h3 className="settings-title">This device</h3>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => sendAdmin({ kind: 'link-device' })}
          >
            Sign in on another device
          </button>
          <p className="settings-note">Makes a one-time link, good for ten minutes.</p>
        </section>

        <section className="settings-section">
          <h3 className="settings-title">Leave for good</h3>
          {isOwner ? (
            <p className="settings-note">
              You are holding the keys. Hand the office to somebody else before you delete yourself,
              or there is nobody left to open the door.
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
                  onClick={() => you && sendAdmin({ kind: 'delete', memberId: you })}
                >
                  Delete me
                </button>
              </div>
            </>
          )}
        </section>
      </section>
    </div>
  );
}

/**
 * One person on the roster. Kicking and banning arm first and fire second:
 * the row itself asks, because a misplaced click here costs somebody their
 * seat — and an unbanned person comes back a stranger, stats and all gone.
 *
 * Every action carries `label: name` as its accessible name. A list of
 * identical "Remove" buttons is unusable read aloud, and the visible label
 * still leads, so speaking the button by name works too.
 */
function PersonRow({ member, role }: { member: RosterEntry; role: MemberRole | null }) {
  const [pending, setPending] = useState<Removal | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // The button that armed this just vanished; focus follows the question
  // rather than falling back to the top of the page.
  useEffect(() => {
    if (pending) confirmRef.current?.focus();
  }, [pending]);

  const isOwner = role === 'owner';
  const canRemove = member.status === 'active' && outranks(role, member.role);

  if (pending) {
    return (
      <div className="settings-row settings-row-asking">
        <span className="settings-note">
          {pending.kind === 'kick'
            ? `Remove ${member.displayName}? The link still works, so they can walk back in.`
            : `Ban ${member.displayName}? Unbanning later brings them back a stranger, with none of their stats.`}
        </span>
        <span className="settings-actions">
          <button
            type="button"
            className="btn btn-danger"
            ref={confirmRef}
            aria-label={`${pending.kind === 'kick' ? 'Yes, remove' : 'Yes, ban'}: ${member.displayName}`}
            onClick={() => {
              sendAdmin(pending);
              setPending(null);
            }}
          >
            {pending.kind === 'kick' ? 'Yes, remove' : 'Yes, ban'}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            aria-label={`Never mind: ${member.displayName}`}
            onClick={() => setPending(null)}
          >
            Never mind
          </button>
        </span>
      </div>
    );
  }

  return (
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
            onClick={() => sendAdmin({ kind: 'promote', memberId: member.id })}
          >
            Make moderator
          </button>
        ) : null}
        {isOwner && member.role === 'moderator' ? (
          <button
            type="button"
            className="btn btn-quiet"
            aria-label={`Step down: ${member.displayName}`}
            onClick={() => sendAdmin({ kind: 'demote', memberId: member.id })}
          >
            Step down
          </button>
        ) : null}
        {canRemove ? (
          <>
            <button
              type="button"
              className="btn btn-quiet"
              aria-label={`Remove: ${member.displayName}`}
              onClick={() => setPending({ kind: 'kick', memberId: member.id })}
            >
              Remove
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              aria-label={`Ban: ${member.displayName}`}
              onClick={() => setPending({ kind: 'ban', memberId: member.id })}
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
            onClick={() => sendAdmin({ kind: 'unban', memberId: member.id })}
          >
            Unban
          </button>
        ) : null}
      </span>
    </div>
  );
}
