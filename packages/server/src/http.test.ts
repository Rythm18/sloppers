import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absoluteSocialUrls } from './http.js';
import { createSloppersServer, type SloppersServer } from './index.js';

/**
 * How a sloppers link looks when somebody drops it into Slack.
 *
 * The card's URL has to be absolute for an unfurler to fetch it, and the file
 * on disk cannot know what host it will be served from — a self-hosted office
 * would otherwise advertise a picture of ours. So the document keeps a path
 * and the server fills in the origin of whoever asked.
 */

describe('absoluteSocialUrls', () => {
  it('gives the unfurl card the origin of the office that served it', () => {
    const html = '<meta property="og:image" content="/assets/og-office.png" />';
    expect(absoluteSocialUrls(html, 'https://sloppers.fly.dev')).toBe(
      '<meta property="og:image" content="https://sloppers.fly.dev/assets/og-office.png" />',
    );
  });

  it('does the same for the twitter tag, which is a separate one', () => {
    const html = '<meta name="twitter:image" content="/assets/og-office.png" />';
    expect(absoluteSocialUrls(html, 'http://box.local:8787')).toContain(
      'content="http://box.local:8787/assets/og-office.png"',
    );
  });

  it('leaves an already-absolute URL alone', () => {
    const html = '<meta property="og:image" content="https://cdn.example/card.png" />';
    expect(absoluteSocialUrls(html, 'https://sloppers.fly.dev')).toBe(html);
  });

  it('touches nothing else in the document', () => {
    // Narrow on purpose: this is one rewrite, not a template engine. A
    // stylesheet, a script and the app's own root-relative favicon are all
    // resolved by the browser against the page it already has.
    const html = [
      '<link rel="icon" href="/assets/favicon.png" />',
      '<meta property="og:description" content="/not/a/url" />',
      '<script type="module" src="/assets/index.js"></script>',
    ].join('\n');
    expect(absoluteSocialUrls(html, 'https://sloppers.fly.dev')).toBe(html);
  });
});

describe('serving the built app', () => {
  let server: SloppersServer;
  let dist: string;

  beforeEach(async () => {
    dist = mkdtempSync(join(tmpdir(), 'sloppers-dist-'));
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(
      join(dist, 'index.html'),
      [
        '<!doctype html><html><head>',
        '<meta property="og:image" content="/assets/og-office.png" />',
        '<meta name="twitter:card" content="summary_large_image" />',
        '</head><body></body></html>',
      ].join('\n'),
    );
    writeFileSync(join(dist, 'assets', 'og-office.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    server = await createSloppersServer({
      port: 0,
      hostname: '127.0.0.1',
      dbPath: ':memory:',
      webDist: dist,
    });
  });

  afterEach(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('hands an unfurler an absolute image URL for the host it asked on', async () => {
    // Fly terminates TLS at its proxy, so the socket only ever sees plain
    // http — the forwarded headers are the only place the real scheme and
    // host survive, and an unfurl advertising http:// would be redirected.
    // Trusting them is opt-in, the same TRUST_PROXY gate the rate limiter
    // puts on x-forwarded-for.
    process.env.TRUST_PROXY = '1';
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/?room=the-lab-k4xp2q`, {
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'sloppers.fly.dev' },
      });
      const html = await res.text();

      expect(html).toContain('content="https://sloppers.fly.dev/assets/og-office.png"');
      expect(html).not.toContain('content="/assets/og-office.png"');
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });

  it('ignores forwarded headers when no proxy has been declared trustworthy', async () => {
    // On a direct deployment the client writes X-Forwarded-* itself. Without
    // TRUST_PROXY those headers are nobody's testimony — the card resolves
    // against the Host header Node already policed.
    const res = await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' },
    });
    const html = await res.text();

    expect(html).not.toContain('evil.example');
    expect(html).toContain(`content="http://127.0.0.1:${server.port}/assets/og-office.png"`);
  });

  it('cannot be talked into reflecting markup, even by a trusted proxy', async () => {
    // The reviewer's live probe: a forwarded host shaped like an attribute
    // breakout. Under TRUST_PROXY a compromised or sloppy proxy is still not
    // allowed to put <script> in every page — the allowlist rejects the
    // header and the origin falls back to Host.
    process.env.TRUST_PROXY = '1';
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        headers: {
          'x-forwarded-host': 'evil.com"><script>alert(document.domain)</script><meta x="',
          'x-forwarded-proto': 'javascript:alert(1)//',
        },
      });
      const html = await res.text();

      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('javascript:');
      expect(html).toContain(`content="http://127.0.0.1:${server.port}/assets/og-office.png"`);
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });

  it('serves the card itself from the app, so nothing has to reach a CDN', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/assets/og-office.png`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
  });
});
