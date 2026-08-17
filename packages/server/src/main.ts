#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { createSloppersServer } from './index.js';

/**
 * CLI entry: `sloppers-server` (or `node dist/main.js`).
 *
 *   PORT       listen port                 (default 8787)
 *   DATA_DIR   where sloppers.db lives     (default ./data)
 *   WEB_DIST   built web app to serve      (default: sibling packages/web/dist)
 *   --demo     add a room full of simulated teammates at /demo
 */
const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? 'data';
const demo = process.argv.includes('--demo') || process.env.SLOPPERS_DEMO === '1';

const webDist =
  process.env.WEB_DIST ?? join(fileURLToPath(import.meta.url), '..', '..', '..', 'web', 'dist');

const options: Parameters<typeof createSloppersServer>[0] = {
  port,
  dbPath: join(dataDir, 'sloppers.db'),
  demo,
};
if (existsSync(webDist)) options.webDist = webDist;

const started = await createSloppersServer(options);
console.log(`${pc.bold('sloppers')} office open on ${pc.cyan(`http://localhost:${started.port}`)}`);
if (!('webDist' in options)) {
  console.log(pc.yellow('web app not found — API/WS only (set WEB_DIST or build packages/web)'));
}
if (demo) {
  console.log(`demo room: ${pc.cyan(`http://localhost:${started.port}/?room=demo`)}`);
}

const shutdown = () => {
  void started.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
