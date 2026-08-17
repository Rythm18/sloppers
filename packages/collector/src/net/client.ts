import {
  type CollectorSnapshot,
  collectorHelloSchema,
  serverToCollectorSchema,
} from '@sloppers/protocol';
import WebSocket from 'ws';

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

export interface CollectorClientOptions {
  wsUrl: string;
  deviceKey: string;
  collectorVersion: string;
  log: (message: string) => void;
  /** Called when the server rejects our device key (re-pairing needed). */
  onUnknownDevice?: () => void;
}

/**
 * Maintains the WebSocket to the server: hello on connect, reconnect with
 * jittered exponential backoff, and at-most-latest snapshot delivery (a
 * snapshot generated while offline is sent on reconnect; stale intermediate
 * ones are dropped — only current state matters).
 */
export class CollectorClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private ready = false;
  private pending: CollectorSnapshot | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private opts: CollectorClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  sendSnapshot(snapshot: CollectorSnapshot): void {
    this.pending = snapshot;
    this.flush();
  }

  private flush(): void {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.pending) return;
    this.ws.send(JSON.stringify(this.pending));
    this.pending = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.opts.wsUrl.replace(/\/+$/, '')}/ws/collector`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.ready = false;

    ws.on('open', () => {
      this.attempts = 0;
      ws.send(
        JSON.stringify(
          collectorHelloSchema.parse({
            type: 'hello',
            deviceKey: this.opts.deviceKey,
            collectorVersion: this.opts.collectorVersion,
          }),
        ),
      );
    });

    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      const result = serverToCollectorSchema.safeParse(parsed);
      if (!result.success) return;
      const msg = result.data;
      if (msg.type === 'hello-ok') {
        this.ready = true;
        this.opts.log(
          `connected: sharing as ${msg.displayName} in room ${msg.roomCode}`,
        );
        this.flush();
      } else if (msg.type === 'error' && msg.code === 'unknown-device') {
        this.opts.log('server does not recognize this device — run `sloppers share` again');
        this.stop();
        this.opts.onUnknownDevice?.();
      } else if (msg.type === 'error') {
        this.opts.log(`server rejected a message (${msg.code}): ${msg.message}`);
      }
    });

    const scheduleReconnect = () => {
      if (this.stopped || this.reconnectTimer) return;
      const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempts);
      const delay = backoff / 2 + Math.random() * (backoff / 2);
      this.attempts += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };

    ws.on('close', () => {
      this.ready = false;
      scheduleReconnect();
    });
    ws.on('error', () => {
      // 'close' follows and handles the retry.
    });
  }
}
