import { AVATAR_IDS } from '@sloppers/protocol';
import { type FormEvent, useState } from 'react';
import { useStore } from '../store.js';
import { AvatarThumb } from './AvatarThumb.js';

/**
 * The front door. Joining is browser-only: a room, a name, a face. Sharing
 * agent activity comes later, from inside the office, and is optional.
 */
export function JoinScreen({
  initialRoom,
  connecting,
  onJoin,
}: {
  initialRoom: string;
  connecting: boolean;
  onJoin: (roomCode: string, displayName: string, avatar: string) => void;
}) {
  const joinError = useStore((s) => s.joinError);
  const [room, setRoom] = useState(initialRoom);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string>(
    AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)] ?? 'pixel',
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!room.trim() || !name.trim()) return;
    onJoin(room.trim().toLowerCase(), name.trim(), avatar);
  };

  return (
    <div className="join">
      <form className="join-card panel" onSubmit={submit}>
        <div>
          <h1 className="join-brand">
            sloppers<span className="tick">_</span>
          </h1>
          <p className="join-tagline">
            A pixel office where your team&rsquo;s coding agents show up for work.
          </p>
        </div>

        <label className="join-field">
          <span className="join-label">Room</span>
          <input
            className="input"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="the-lab"
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <label className="join-field">
          <span className="join-label">Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="what your teammates call you"
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: it's the only empty field on a single-purpose screen
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

        {joinError ? <p className="join-error">{joinError}</p> : null}

        <button className="btn" type="submit" disabled={connecting}>
          {connecting ? 'Stepping in…' : 'Step in'}
        </button>
      </form>
    </div>
  );
}
