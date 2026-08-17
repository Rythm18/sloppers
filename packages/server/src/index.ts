import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { type Db, openDb } from './db.js';
import { startDemo } from './demo.js';
import { createApp } from './http.js';
import { RoomManager } from './rooms.js';
import { attachWebSockets } from './ws.js';

const SWEEP_MS = 15_000;

export interface SloppersServer {
  server: Server;
  rooms: RoomManager;
  db: Db;
  port: number;
  close(): Promise<void>;
}

export interface SloppersServerOptions {
  port?: number;
  hostname?: string;
  /** SQLite path; ':memory:' for tests. */
  dbPath: string;
  /** Directory of the built web app; omitted = API/WS only. */
  webDist?: string;
  demo?: boolean;
}

export function createSloppersServer(opts: SloppersServerOptions): Promise<SloppersServer> {
  const db = openDb(opts.dbPath);
  const rooms = new RoomManager(db);
  const appOptions: Parameters<typeof createApp>[0] = { db, rooms };
  if (opts.webDist !== undefined) appOptions.webDist = opts.webDist;
  const app = createApp(appOptions);

  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: opts.port ?? 8787, hostname: opts.hostname ?? '0.0.0.0' },
      (info) => {
        const sweep = setInterval(() => rooms.sweep(), SWEEP_MS);
        rooms.cleanupStaleMembers();
        const cleanup = setInterval(() => rooms.cleanupStaleMembers(), 24 * 60 * 60 * 1000);
        const stopDemo = opts.demo ? startDemo(rooms) : null;
        resolve({
          server: server as Server,
          rooms,
          db,
          port: info.port,
          async close() {
            clearInterval(sweep);
            clearInterval(cleanup);
            stopDemo?.();
            await sockets.close();
            rooms.close();
            await new Promise<void>((done) => (server as Server).close(() => done()));
            db.close();
          },
        });
      },
    );
    const sockets = attachWebSockets(server as Server, { db, rooms });
  });
}

export { openDb } from './db.js';
export { TokenLedger } from './ledger.js';
export { derivePresence } from './presence.js';
export { Room } from './room.js';
export { RoomManager } from './rooms.js';
