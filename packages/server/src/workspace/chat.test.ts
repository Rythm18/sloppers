import { CHAT_KEPT } from '@sloppers/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/index.js';
import {
  appendChat,
  CHAT_MAX_AGE_MS,
  chatAuthor,
  pruneChat,
  recentChat,
  removeChat,
} from './chat.js';

/**
 * The table's own arithmetic, away from sockets: ordering, both caps, and the
 * scoping that keeps one office's ids from reaching into another.
 */

describe('chat storage', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(
      "INSERT INTO workspaces (id, name, invite_code, settings, created_at) VALUES ('w_a', 'the lab', 'the-lab-aaaaaa', '{}', 0)",
    ).run();
    db.prepare(
      "INSERT INTO workspaces (id, name, invite_code, settings, created_at) VALUES ('w_b', 'the annex', 'the-annex-bbbbbb', '{}', 0)",
    ).run();
    for (const [id, workspace] of [
      ['m_a', 'w_a'],
      ['m_b', 'w_a'],
      ['m_c', 'w_b'],
    ]) {
      db.prepare(
        'INSERT INTO members (id, workspace_id, secret, display_name, avatar, role, status, created_at, last_seen_at, last_present_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)',
      ).run(id, workspace, 's', id, 'pixel', 'member', 'active');
    }
  });

  afterEach(() => db.close());

  const ridham = { id: 'm_a', displayName: 'ridham' };
  const sam = { id: 'm_b', displayName: 'sam' };

  it('hands back the conversation oldest first, whatever order it went in', () => {
    // Written newest-first-ish on purpose: the read is `ORDER BY at DESC` with
    // a reverse behind it, and a reverse that went missing would still look
    // right on a log written in order.
    appendChat(db, 'w_a', ridham, 'third', 3000);
    appendChat(db, 'w_a', sam, 'first', 1000);
    appendChat(db, 'w_a', ridham, 'second', 2000);

    expect(recentChat(db, 'w_a', 10).map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  it('keeps the newest when it hands back fewer than there are', () => {
    for (let i = 0; i < 10; i++) appendChat(db, 'w_a', ridham, `line ${i}`, 1000 + i);
    expect(recentChat(db, 'w_a', 3).map((m) => m.text)).toEqual(['line 7', 'line 8', 'line 9']);
  });

  it('carries the name it was said under, not one looked up later', () => {
    const written = appendChat(db, 'w_a', sam, 'shipped it', 1000);
    expect(written.displayName).toBe('sam');
    expect(recentChat(db, 'w_a', 1)[0]?.displayName).toBe('sam');
  });

  it('never lets one office grow far past what it keeps', () => {
    // Twice the cap, one at a time, exactly as a busy afternoon arrives.
    for (let i = 0; i < CHAT_KEPT * 2; i++) appendChat(db, 'w_a', ridham, `line ${i}`, 1000 + i);
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE workspace_id = 'w_a'")
      .get() as { n: number };
    // The trim overshoots by design (see `TRIM_SLACK`) and must never undershoot.
    expect(n).toBeGreaterThanOrEqual(CHAT_KEPT);
    expect(n).toBeLessThanOrEqual(CHAT_KEPT + 50);
    // And what survives is the *end* of the conversation, not the start of it.
    expect(recentChat(db, 'w_a', 1)[0]?.text).toBe(`line ${CHAT_KEPT * 2 - 1}`);
  });

  it('trims one office without touching the one next door', () => {
    appendChat(db, 'w_b', { id: 'm_c', displayName: 'nina' }, 'still here', 1000);
    for (let i = 0; i < CHAT_KEPT * 2; i++) appendChat(db, 'w_a', ridham, `line ${i}`, 2000 + i);
    expect(recentChat(db, 'w_b', 10).map((m) => m.text)).toEqual(['still here']);
  });

  it('forgets a line once it is older than the retention window', () => {
    const now = 10 * CHAT_MAX_AGE_MS;
    appendChat(db, 'w_a', ridham, 'ancient', now - CHAT_MAX_AGE_MS - 1);
    appendChat(db, 'w_a', ridham, 'recent', now - 1000);

    expect(pruneChat(db, now)).toBe(1);
    expect(recentChat(db, 'w_a', 10).map((m) => m.text)).toEqual(['recent']);
  });

  it('resolves an author inside their own office and nowhere else', () => {
    const written = appendChat(db, 'w_a', sam, 'over here', 1000);
    expect(chatAuthor(db, written.id)).toEqual({ workspaceId: 'w_a', memberId: 'm_b' });
    // The room-scoping the delete path leans on lives in `Room.chatAuthorOf`,
    // which compares this answer's workspace against its own.
    expect(chatAuthor(db, written.id)?.workspaceId).not.toBe('w_b');
    expect(chatAuthor(db, 'c_nothing')).toBeNull();
  });

  it('takes one line out and leaves the rest of the conversation alone', () => {
    const first = appendChat(db, 'w_a', ridham, 'first', 1000);
    appendChat(db, 'w_a', sam, 'second', 2000);
    removeChat(db, first.id);
    expect(recentChat(db, 'w_a', 10).map((m) => m.text)).toEqual(['second']);
  });
});
