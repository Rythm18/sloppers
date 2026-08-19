import { useCallback, useEffect, useRef, useState } from 'react';
import { sendAdmin } from '../net/socket.js';
import { useStore } from '../store.js';
import { useModalManners } from './modal.js';
import { qrPath } from './qr.js';

/**
 * A one-shot link that signs another browser in as you: a phone, a second
 * laptop, a machine where localStorage was cleared.
 *
 * It is a credential with ten minutes to live, so the modal is built around
 * saying so. When the clock runs out the link and its code come off the
 * screen together — a QR left sitting there is an invitation to scan
 * something that has already stopped working.
 */

/** Below this, the countdown reads as a warning rather than a fact. */
const NEARLY_GONE_SECONDS = 60;

function countdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function DeviceLinkModal() {
  const link = useStore((s) => s.deviceLink);
  // Mounted only while there is a link, so every visit starts from a fresh
  // countdown and an un-copied button rather than the last one's leftovers.
  if (!link) return null;
  // Keyed by the deadline so replacing an expired link starts the body over
  // — a fresh countdown, an un-copied button — instead of re-rendering the
  // dead one's state around new props.
  return <DeviceLinkBody key={link.expiresAt} url={link.url} expiresAt={link.expiresAt} />;
}

function DeviceLinkBody({ url, expiresAt }: { url: string; expiresAt: number }) {
  const setDeviceLink = useStore((s) => s.setDeviceLink);
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
  );
  const [copied, setCopied] = useState(false);
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const close = useCallback(() => setDeviceLink(null), [setDeviceLink]);

  useModalManners(scrimRef, dialogRef, close);

  // Counts down to zero and stops there — both because a negative number is
  // nonsense and because there is nothing left to tick towards.
  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) clearInterval(timer);
    };
    const timer = setInterval(tick, 1000);
    tick();
    return () => clearInterval(timer);
  }, [expiresAt]);

  const expired = remaining <= 0;
  // The server mints this relative on purpose — it has no dependable notion
  // of its own public URL. The page asking does, and a link nobody can paste
  // into another device is not a link.
  const absolute = new URL(url, location.origin).toString();
  const code = expired ? null : qrPath(absolute);

  const copy = async () => {
    await navigator.clipboard.writeText(absolute);
    setCopied(true);
  };

  return (
    <div className="modal-scrim" ref={scrimRef}>
      {/* tabIndex -1: not a tab stop, but the dialog can be handed focus when it opens. */}
      <section
        className="link-modal panel"
        role="dialog"
        aria-modal="true"
        aria-label="sign in on another device"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="settings-head">
          <span className="panel-title">Sign in on another device</span>
          <button type="button" className="close" aria-label="close" onClick={close}>
            ×
          </button>
        </header>

        {expired ? (
          <div className="link-body">
            <p className="join-error">
              That link has expired. Nothing was left open — it signs nobody in now.
            </p>
            <p className="settings-note">
              Ten minutes is all one gets, on purpose: it is a key to your seat in this office.
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => sendAdmin({ kind: 'link-device' })}
            >
              Make a new link
            </button>
          </div>
        ) : (
          <div className="link-body">
            <p className="settings-note">
              Open this on the other device, or point its camera at the code. It works once, and
              only for the next ten minutes.
            </p>

            {code ? (
              <svg
                className="qr"
                viewBox={`0 0 ${code.size} ${code.size}`}
                role="img"
                aria-label="QR code for the sign-in link"
              >
                <title>QR code for the sign-in link</title>
                <path d={code.path} />
              </svg>
            ) : null}

            <code className="link-url">{absolute}</code>

            <div className="link-actions">
              <button type="button" className="btn" onClick={copy}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <span
                className={`share-expiry${remaining <= NEARLY_GONE_SECONDS ? ' nearly-gone' : ''}`}
              >
                expires in {countdown(remaining)}
              </span>
            </div>
          </div>
        )}

        <p className="share-privacy">
          Anyone holding this link becomes you here until it is used or runs out. Send it to your
          own device and nowhere else.
        </p>
      </section>
    </div>
  );
}
