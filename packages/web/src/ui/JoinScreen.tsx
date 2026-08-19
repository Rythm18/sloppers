import { AVATAR_IDS } from '@sloppers/protocol';
import { type FormEvent, useEffect, useState } from 'react';
import { fetchRoomPreview } from '../net/socket.js';
import { useStore } from '../store.js';
import { AvatarThumb } from './AvatarThumb.js';
import { KnockingScreen } from './KnockingScreen.js';

/**
 * The front door, in four shapes:
 * - bare visit: name an office, name yourself, create — the invite link is
 *   minted server-side and shown once you're in
 * - invite link: greeted with the office name and who's inside; just pick
 *   a name and step in
 * - returning: a brief "stepping back in…" beat, no form at all
 * - knocking: the form is answered, and now it is a person we're waiting on
 *
 * Joining is browser-only by design. Sharing agents comes later, from
 * inside, and is optional.
 */

type Preview =
  | { state: 'loading' }
  | { state: 'found'; name: string; memberCount: number }
  | { state: 'dead' };

/** Accepts a pasted invite in any form: full URL or bare code. */
function parseInvite(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const code = url.searchParams.get('room');
    if (code) return code;
  } catch {
    // Not a URL; maybe a bare code.
  }
  return /^[a-z0-9][a-z0-9-]{2,47}$/i.test(text) ? text : null;
}

export function JoinScreen({
  invitedRoom,
  resuming,
  connecting,
  onCreate,
  onJoin,
  onFollowInvite,
}: {
  invitedRoom: string | null;
  resuming: boolean;
  connecting: boolean;
  onCreate: (roomName: string, displayName: string, avatar: string) => void;
  onJoin: (roomCode: string, displayName: string, avatar: string) => void;
  onFollowInvite: (roomCode: string) => void;
}) {
  const joinError = useStore((s) => s.joinError);
  const knocking = useStore((s) => s.knocking);
  const [roomName, setRoomName] = useState('');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string>(
    () => AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)] ?? 'pixel',
  );
  const [invitePaste, setInvitePaste] = useState('');
  const [pasteError, setPasteError] = useState(false);
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });

  const invited = invitedRoom !== null;

  useEffect(() => {
    if (!invitedRoom) return;
    setPreview({ state: 'loading' });
    void fetchRoomPreview(invitedRoom).then((found) => {
      setPreview(found ? { state: 'found', ...found } : { state: 'dead' });
    });
  }, [invitedRoom]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || connecting) return;
    if (invited && invitedRoom) onJoin(invitedRoom, name.trim(), avatar);
    else if (roomName.trim()) onCreate(roomName.trim(), name.trim(), avatar);
  };

  const followPaste = () => {
    const code = parseInvite(invitePaste);
    if (!code) {
      setPasteError(true);
      return;
    }
    setPasteError(false);
    onFollowInvite(code);
  };

  // The name was offered and the office took it as far as the door. The
  // preview is where the office's name comes from — it is the only thing
  // this browser has been told about a place it is not in yet.
  if (knocking) {
    return <KnockingScreen officeName={preview.state === 'found' ? preview.name : null} />;
  }

  if (resuming) {
    return (
      <div className="join">
        <div className="join-card panel join-resuming">
          <h1 className="join-brand">
            sloppers<span className="tick">_</span>
          </h1>
          <p className="join-tagline">Stepping back into your office…</p>
          {joinError ? <p className="join-error">{joinError}</p> : null}
        </div>
      </div>
    );
  }

  const deadInvite = invited && preview.state === 'dead';

  return (
    <div className="join">
      <form className="join-card panel" onSubmit={submit}>
        <div>
          <h1 className="join-brand">
            sloppers<span className="tick">_</span>
          </h1>
          {invited && preview.state === 'found' ? (
            <p className="join-tagline">
              You&rsquo;re invited to <strong className="join-office">{preview.name}</strong>
              {preview.memberCount > 0
                ? ` — ${preview.memberCount} teammate${preview.memberCount === 1 ? '' : 's'} inside.`
                : '.'}
            </p>
          ) : deadInvite ? (
            <p className="join-tagline">
              This invite doesn&rsquo;t point to an office anymore. Ask for a fresh link, or start
              your own below.
            </p>
          ) : (
            <p className="join-tagline">
              A pixel office where your team&rsquo;s coding agents show up for work.
            </p>
          )}
        </div>

        {!invited || deadInvite ? (
          <label className="join-field">
            <span className="join-label">Office name</span>
            <input
              className="input"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="the lab"
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        ) : null}

        <label className="join-field">
          <span className="join-label">Your name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="what your teammates call you"
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: the only empty field on a single-purpose screen
            autoFocus
          />
        </label>

        <div className="join-field">
          <span className="join-label">Avatar</span>
          <fieldset className="avatar-grid" aria-label="avatar">
            {AVATAR_IDS.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={avatar === id}
                aria-label={id}
                title={id}
                className={`avatar-choice${avatar === id ? ' selected' : ''}`}
                onClick={() => setAvatar(id)}
              >
                <AvatarThumb avatar={id} />
              </button>
            ))}
          </fieldset>
        </div>

        {joinError ? (
          <p className="join-error">
            {joinError}
            {joinError.includes('already called') ? (
              <span className="join-hint">
                {' '}
                Was that you? On the machine where your agents share from, run{' '}
                <code>sloppers relink</code> to sign back in.
              </span>
            ) : null}
          </p>
        ) : null}

        <button className="btn" type="submit" disabled={connecting}>
          {connecting ? 'Stepping in…' : invited && !deadInvite ? 'Step in' : 'Create office'}
        </button>

        {!invited || deadInvite ? (
          <div className="join-invite-paste">
            <span className="join-label">Have an invite?</span>
            <div className="join-invite-row">
              <input
                className="input"
                value={invitePaste}
                onChange={(e) => {
                  setInvitePaste(e.target.value);
                  setPasteError(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    followPaste();
                  }
                }}
                placeholder="paste the link or code"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="btn btn-quiet" onClick={followPaste}>
                Go
              </button>
            </div>
            {pasteError ? (
              <p className="join-error">That doesn&rsquo;t look like an invite link or code.</p>
            ) : null}
          </div>
        ) : null}
      </form>
    </div>
  );
}
