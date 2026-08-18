import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migrations, runMigrations } from './migrations.js';

/** Build an empty database in the version-1 shape, with no fixtures. */
function emptyLegacyDb(): Database.Database {
  const db = new Database(':memory:');
  const first = migrations[0];
  if (!first) throw new Error('no migrations');
  db.transaction(() => first.up(db))();
  db.pragma('user_version = 1');
  return db;
}

/** Build a database in the version-1 shape with two rooms of members. */
function legacyDb(): Database.Database {
  const db = emptyLegacyDb();
  db.prepare('INSERT INTO rooms (code, name, created_at) VALUES (?, ?, ?)').run(
    'the-lab-k4xp2q',
    'the lab',
    1000,
  );
  db.prepare('INSERT INTO rooms (code, name, created_at) VALUES (?, ?, ?)').run(
    'demo',
    'demo floor',
    900,
  );
  const insert = db.prepare(
    'INSERT INTO members (id, room_code, secret, display_name, avatar, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('m_first', 'the-lab-k4xp2q', 's1', 'ridham', 'pixel', 1100, 1100);
  insert.run('m_later', 'the-lab-k4xp2q', 's2', 'sam', 'mochi', 1200, 1200);
  insert.run('m_demo', 'demo', 's3', 'maya', 'juniper', 950, 950);
  db.prepare(
    'INSERT INTO session_watermarks (session_id, member_id, harness, input, output, cache_read, cache_write, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('sess-1', 'm_first', 'claude-code', 500, 100, 90, 10, 1300);
  db.prepare(
    'INSERT INTO daily_stats (member_id, day, harness, input, output, cache_read, cache_write, sessions_run, active_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('m_first', '2026-08-18', 'claude-code', 500, 100, 90, 10, 1, 12);
  return db;
}

describe('migration 002', () => {
  it('carries every room and member across, oldest member owning the workspace', () => {
    const db = legacyDb();
    runMigrations(db);

    const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY created_at').all() as {
      id: string;
      name: string;
      invite_code: string;
      settings: string;
    }[];
    expect(workspaces).toHaveLength(2);
    const lab = workspaces.find((w) => w.invite_code === 'the-lab-k4xp2q');
    expect(lab?.name).toBe('the lab');
    expect(JSON.parse(lab?.settings ?? '{}').joinMode).toBe('link');

    const members = db
      .prepare('SELECT id, role, status, workspace_id FROM members ORDER BY created_at')
      .all() as { id: string; role: string; status: string; workspace_id: string }[];
    expect(members).toHaveLength(3);
    expect(members.find((m) => m.id === 'm_first')?.role).toBe('owner');
    expect(members.find((m) => m.id === 'm_later')?.role).toBe('member');
    expect(members.find((m) => m.id === 'm_demo')?.role).toBe('owner');
    expect(members.every((m) => m.status === 'active')).toBe(true);
    expect(members.find((m) => m.id === 'm_first')?.workspace_id).toBe(lab?.id);
  });

  it('carries daily stats over as model "unknown" and records legacy sessions', () => {
    const db = legacyDb();
    runMigrations(db);
    const usage = db.prepare('SELECT * FROM daily_usage').all() as {
      model: string;
      input: number;
      member_id: string;
    }[];
    expect(usage).toHaveLength(1);
    expect(usage[0]?.model).toBe('unknown');
    expect(usage[0]?.input).toBe(500);

    const legacy = db.prepare('SELECT * FROM legacy_sessions').all() as {
      session_id: string;
      member_id: string;
    }[];
    expect(legacy).toEqual([{ session_id: 'sess-1', member_id: 'm_first' }]);
  });

  it('frees a name once a member is no longer active', () => {
    const db = legacyDb();
    runMigrations(db);
    const ws = db
      .prepare('SELECT id FROM workspaces WHERE invite_code = ?')
      .get('the-lab-k4xp2q') as { id: string } | undefined;
    db.prepare('UPDATE members SET status = ? WHERE id = ?').run('kicked', 'm_later');
    expect(() =>
      db
        .prepare(
          'INSERT INTO members (id, workspace_id, secret, display_name, avatar, role, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('m_new', ws?.id, 's4', 'sam', 'pixel', 'member', 'active', 1400, 1400),
    ).not.toThrow();
  });

  it('does not embed the invite code in the workspace id', () => {
    const db = legacyDb();
    runMigrations(db);
    const workspaces = db.prepare('SELECT id, invite_code FROM workspaces').all() as {
      id: string;
      invite_code: string;
    }[];
    expect(workspaces.length).toBeGreaterThan(0);
    for (const w of workspaces) {
      // Every char left after stripping punctuation from a code (t, h, l, g,
      // k, x, p, q, ...) includes at least one letter outside a-f, so it can
      // never appear as a substring of a lowercase hex id — a cheap but
      // solid way to assert the code was not folded into the id.
      const strippedCode = w.invite_code.replace(/[^a-z0-9]/gi, '').toLowerCase();
      expect(w.id.toLowerCase()).not.toContain(strippedCode);
      expect(w.id).toMatch(/^w_[0-9a-f]{16}$/);
    }
  });

  it('mints distinct workspace ids even where the old index-suffixed scheme would collide', () => {
    // The old scheme was `w_${alnum(code).slice(0,12)}${i}`. A room coded
    // "demo1" at index 0 and one coded "demo" at index 10 both minted
    // "w_demo10" under that scheme, aborting the migration with a UNIQUE
    // constraint failure. Reproduce that exact shape and confirm it no
    // longer collides.
    const db = emptyLegacyDb();
    const insertRoom = db.prepare('INSERT INTO rooms (code, name, created_at) VALUES (?, ?, ?)');
    insertRoom.run('demo1', 'demo one', 100);
    for (let i = 0; i < 9; i++) {
      insertRoom.run(`filler-room-${i}`, `filler ${i}`, 200 + i);
    }
    insertRoom.run('demo', 'demo floor', 900);

    expect(() => runMigrations(db)).not.toThrow();

    const workspaces = db.prepare('SELECT id, invite_code FROM workspaces').all() as {
      id: string;
      invite_code: string;
    }[];
    expect(workspaces).toHaveLength(11);
    expect(new Set(workspaces.map((w) => w.id)).size).toBe(11);
    const demo1 = workspaces.find((w) => w.invite_code === 'demo1');
    const demo = workspaces.find((w) => w.invite_code === 'demo');
    expect(demo1?.id).toBeDefined();
    expect(demo?.id).toBeDefined();
    expect(demo1?.id).not.toBe(demo?.id);
  });

  it('salvages an orphaned member and their device into a synthesized workspace', () => {
    const db = emptyLegacyDb();
    // No corresponding row in `rooms` — simulates a legacy database where
    // that referential integrity was already broken before this migration
    // ever ran. Foreign keys are OFF for the whole migration loop, so
    // nothing there would catch it either; drop enforcement here too, just
    // to construct the otherwise-unreachable fixture.
    db.pragma('foreign_keys = OFF');
    db.prepare(
      'INSERT INTO members (id, room_code, secret, display_name, avatar, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('m_ghost', 'ghost-room', 'secret', 'ghost', 'pixel', 500, 500);
    db.prepare('INSERT INTO devices (key, member_id, created_at) VALUES (?, ?, ?)').run(
      'device-ghost',
      'm_ghost',
      600,
    );

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => runMigrations(db)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain('ghost-room');
    } finally {
      errorSpy.mockRestore();
    }

    const member = db
      .prepare('SELECT id, workspace_id, role, status FROM members WHERE id = ?')
      .get('m_ghost') as
      | { id: string; workspace_id: string; role: string; status: string }
      | undefined;
    expect(member?.status).toBe('active');
    expect(member?.role).toBe('owner');

    const workspace = db
      .prepare('SELECT id FROM workspaces WHERE invite_code = ?')
      .get('ghost-room') as { id: string } | undefined;
    expect(workspace?.id).toBeDefined();
    expect(member?.workspace_id).toBe(workspace?.id);

    const device = db.prepare('SELECT member_id FROM devices WHERE key = ?').get('device-ghost') as
      | { member_id: string }
      | undefined;
    expect(device?.member_id).toBe('m_ghost');

    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
