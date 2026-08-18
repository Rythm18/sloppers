import { useCallback, useEffect, useState } from 'react';
import { mintPairingCode } from '../net/socket.js';
import { useStore } from '../store.js';

/**
 * Turns "share my agents" into one paste: mints a short-lived pairing code
 * and shows the exact command, host included. The collector never needs
 * flags or config by hand.
 */
export function ShareModal() {
  const open = useStore((s) => s.shareOpen);
  const roomCode = useStore((s) => s.roomCode);
  const setShareOpen = useStore((s) => s.setShareOpen);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [remaining, setRemaining] = useState<number>(0);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

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
    if (open) void mint();
  }, [open, mint]);

  useEffect(() => {
    if (!open || !code) return;
    const tick = () => setRemaining(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [open, code, expiresAt]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShareOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setShareOpen]);

  if (!open) return null;

  // Plain-HTTP deployments (LAN, tunnels) need the scheme spelled out —
  // the collector assumes https for any non-localhost bare host.
  const bareHost = ['localhost', '127.0.0.1'].includes(location.hostname);
  const shareTarget =
    location.protocol === 'http:' && !bareHost ? `http://${location.host}` : location.host;
  const command = code ? `npx sloppers@latest share ${code}@${shareTarget}` : null;

  const copy = async () => {
    if (!command) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };

  return (
    <div className="modal-scrim">
      <div className="share-modal panel" role="dialog" aria-label="share your agents">
        <div className="share-modal-head">
          <span className="panel-title">Share your agents</span>
          <button
            type="button"
            className="close"
            onClick={() => setShareOpen(false)}
            aria-label="close"
          >
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

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" className="btn" onClick={copy} disabled={!command}>
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
      </div>
    </div>
  );
}
