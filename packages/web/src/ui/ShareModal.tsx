import { useCallback, useEffect, useRef, useState } from 'react';
import { mintPairingCode } from '../net/socket.js';
import { useStore } from '../store.js';
import { useModalManners } from './modal.js';

/**
 * Turns "share my agents" into one paste: mints a short-lived pairing code
 * and shows the exact command, host included. The collector never needs
 * flags or config by hand.
 */
export function ShareModal() {
  const open = useStore((s) => s.shareOpen);
  // Mounted only while it is open, the way the other two dialogs are: the
  // manners below hand the dialog focus, hold Tab inside it, and make the
  // office behind it unreachable, none of which may happen while it is shut.
  if (!open) return null;
  return <ShareModalBody />;
}

function ShareModalBody() {
  const roomCode = useStore((s) => s.roomCode);
  const setShareOpen = useStore((s) => s.setShareOpen);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [remaining, setRemaining] = useState<number>(0);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const close = useCallback(() => setShareOpen(false), [setShareOpen]);

  // The first dialog a new arrival ever meets, and for a while it was the one
  // hand-rolling its own Escape key with no focus trap and a live office
  // behind it. Escape, the trap, the restore, and `inert` all come from here.
  useModalManners(scrimRef, dialogRef, close);

  const mint = useCallback(async () => {
    setFailed(false);
    setCode(null);
    const minted = await mintPairingCode(roomCode);
    if (!minted) {
      setFailed(true);
      return;
    }
    setCode(minted.pairingCode);
    setExpiresAt(minted.expiresAt);
    setCopied(false);
  }, [roomCode]);

  useEffect(() => {
    void mint();
  }, [mint]);

  useEffect(() => {
    if (!code) return;
    const tick = () => setRemaining(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [code, expiresAt]);

  // Plain-HTTP deployments (LAN, tunnels) need the scheme spelled out —
  // the collector assumes https for any non-localhost bare host.
  const bareHost = ['localhost', '127.0.0.1'].includes(location.hostname);
  const shareTarget =
    location.protocol === 'http:' && !bareHost ? `http://${location.host}` : location.host;
  const command = code ? `npx sloppers@latest share ${code}@${shareTarget}` : null;

  // A refused clipboard (permissions policy, insecure origin, a tab that lost
  // focus mid-click) must not become an unhandled rejection behind a button
  // that looks like it worked. The command is on screen regardless.
  const copy = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
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
        className="share-modal panel"
        role="dialog"
        aria-modal="true"
        aria-label="share your agents"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="share-modal-head">
          <span className="panel-title">Share your agents</span>
          <button type="button" className="close" onClick={close} aria-label="close">
            ×
          </button>
        </div>
        <div className="share-steps">
          <span>Run this once on the machine where your agents live:</span>
        </div>

        {failed ? (
          <div className="share-steps">
            <p className="join-error">Could not mint a code — the server may be unreachable.</p>
            <button type="button" className="btn btn-quiet" onClick={() => void mint()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="share-cmd">
            <span className="prompt">$</span>
            <span>{command ?? 'minting a code…'}</span>
          </div>
        )}

        {copyFailed ? (
          <p className="join-error">
            This browser would not let the page reach your clipboard. Select the command above and
            copy it by hand.
          </p>
        ) : null}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" className="btn" onClick={() => void copy()} disabled={!command}>
            {copied ? 'Copied' : 'Copy command'}
          </button>
          {code && remaining === 0 ? (
            <button type="button" className="btn btn-quiet" onClick={() => void mint()}>
              New code
            </button>
          ) : null}
          {code ? (
            <span className="share-expiry">
              {remaining > 0 ? `code expires in ${remaining}s` : 'code expired'}
            </span>
          ) : null}
        </div>

        <p className="share-privacy">
          The collector reads your local Claude Code and Codex session files and sends only derived
          status: session titles (short summaries generated from your prompts), project and branch
          names, model, working/waiting state, and token counts. Never prompts, code, or file
          contents. Every field can be hidden — <code>sloppers hide title</code>,{' '}
          <code>sloppers hide tokens</code> — and <code>sloppers pause</code> stops sharing
          entirely.
        </p>
        <p className="share-privacy">
          Running from a checkout instead of npm? Use{' '}
          <code>
            node packages/collector/dist/cli.js share {code ?? '<code>'}@{shareTarget}
          </code>
          .
        </p>
      </section>
    </div>
  );
}
