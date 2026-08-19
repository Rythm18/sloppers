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

/** Whole seconds until the deadline. Goes negative once it is past, which is
 *  what tells the ticker to stop rather than something anybody is shown. */
function secondsLeft(expiresAt: number): number {
  return Math.round((expiresAt - Date.now()) / 1000);
}

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
  const [remaining, setRemaining] = useState(() => secondsLeft(expiresAt));
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const close = useCallback(() => setDeviceLink(null), [setDeviceLink]);

  useModalManners(scrimRef, dialogRef, close);

  // Stops the moment there is nothing left to tick towards. `<= 0` rather
  // than `=== 0` because a backgrounded tab has its intervals throttled to
  // about once a minute, so the exact second the deadline passes is a tick
  // that may never happen — and a link that was already dead when the modal
  // opened never had one at all.
  useEffect(() => {
    const tick = () => {
      const left = secondsLeft(expiresAt);
      setRemaining(left);
      if (left <= 0) clearInterval(timer);
    };
    const timer = setInterval(tick, 1000);
    tick();
    return () => clearInterval(timer);
  }, [expiresAt]);

  // "Copied" is a receipt, not a new name for the button — it goes back to
  // offering the thing it offers.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const expired = remaining <= 0;
  // The server mints this relative on purpose — it has no dependable notion
  // of its own public URL. The page asking does, and a link nobody can paste
  // into another device is not a link.
  const absolute = new URL(url, location.origin).toString();
  const code = expired ? null : qrPath(absolute);

  // A clipboard write can be refused outright — permissions policy, an
  // insecure origin, a tab that lost focus mid-click. Swallowing that leaves
  // a button that looks like it worked; throwing it leaves an unhandled
  // rejection nobody sees. The link is on screen either way, so say so.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
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

            {copyFailed ? (
              <p className="join-error">
                This browser would not let the page reach your clipboard. Select the link above and
                copy it by hand.
              </p>
            ) : null}

            <div className="link-actions">
              <button type="button" className="btn" onClick={() => void copy()}>
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
