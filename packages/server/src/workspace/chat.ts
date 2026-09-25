import { CHAT_BACKLOG, CHAT_KEPT, type ChatMessage } from '@sloppers/protocol';
import type { Db } from '../db/index.js';
import { chatMessageId } from '../ids.js';

/**
 * The conversation, on disk.
 *
 * Every function here is bounded, and that is the point. This is the first
 * table in the schema people fill by hand rather than by working, and the
 * roadmap already lists "unbounded table growth" as a standing debt against
 * the three tables that grow on their own. Adding a fourth — one that grows
 * as fast as anybody can type — without a cap would be signing up for the
 * same bill knowingly.
 *
 * Two caps, because they answer different questions. `CHAT_KEPT` is how far
 * back somebody can scroll, and it is what stops one busy afternoon from
 * pushing a month of an office's storage around. `CHAT_MAX_AGE_MS` is how
 * long a sentence somebody typed sits on a disk after everyone has forgotten
 * it, which is a question about them rather than about the database.
 */

/** How long a line survives, however quiet the office has been since. */
export const CHAT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How far past `CHAT_KEPT` an office is allowed to drift before it is trimmed.
 *
 * The trim is a DELETE with a subquery, and running it on every single message
 * would be a scan per sentence for a table that is already at its cap 99% of
 * the time. Letting it overshoot by fifty means one trim per fifty messages
 * and a scrollback that is somewhere between 200 and 250 — which is nobody's
 * problem, because `CHAT_BACKLOG` is what a browser is actually handed.
 */
const TRIM_SLACK = 50;

interface ChatRow {
  id: string;
  member_id: string;
  display_name: string;
  body: string;
  at: number;
}

function toMessage(row: ChatRow): ChatMessage {
  return {
    id: row.id,
    memberId: row.member_id,
    displayName: row.display_name,
    text: row.body,
    at: row.at,
  };
}

/**
 * Write one line and hand back what the room should broadcast.
 *
 * `text` arrives already flattened by `normalizeChatText` — this does not
 * normalize again, because the value stored and the value broadcast have to be
 * the same string, and the only way to guarantee that is for exactly one place
 * to decide what it is.
 */
export function appendChat(
  db: Db,
  workspaceId: string,
  author: { id: string; displayName: string },
  text: string,
  now: number,
): ChatMessage {
  const message: ChatMessage = {
    id: chatMessageId(),
    memberId: author.id,
    displayName: author.displayName,
    text,
    at: now,
  };
  db.prepare(
    'INSERT INTO chat_messages (id, workspace_id, member_id, display_name, body, at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(message.id, workspaceId, author.id, author.displayName, text, now);
  trimChat(db, workspaceId);
  return message;
}

/** Drop everything past `CHAT_KEPT`, once the overshoot is worth a scan. */
function trimChat(db: Db, workspaceId: string): void {
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE workspace_id = ?')
    .get(workspaceId) as { n: number };
  if (n <= CHAT_KEPT + TRIM_SLACK) return;
  // `rowid` breaks the tie, not the id: two messages can share a millisecond
  // (two tabs, one keystroke apart) and the ids are random, so ordering by
  // them would drop an arbitrary one of a pair and keep the other.
  db.prepare(`
    DELETE FROM chat_messages
    WHERE workspace_id = ?
      AND id NOT IN (
        SELECT id FROM chat_messages
        WHERE workspace_id = ?
        ORDER BY at DESC, rowid DESC
        LIMIT ?
      )
  `).run(workspaceId, workspaceId, CHAT_KEPT);
}

/**
 * The newest lines of one office, oldest first.
 *
 * Read newest-first and reversed rather than ordered ascending with an offset:
 * "the last fifty" has no offset to compute, and the index is already in the
 * right direction for it.
 */
export function recentChat(db: Db, workspaceId: string, limit = CHAT_BACKLOG): ChatMessage[] {
  const rows = db
    .prepare(`
      SELECT id, member_id, display_name, body, at FROM chat_messages
      WHERE workspace_id = ?
      ORDER BY at DESC, rowid DESC
      LIMIT ?
    `)
    .all(workspaceId, limit) as ChatRow[];
  return rows.reverse().map(toMessage);
}

/**
 * Who said this, and in which office — the two facts a delete has to check
 * before it does anything. Null for a line that is already gone, which is an
 * ordinary outcome: two moderators can reach for the same message.
 */
export function chatAuthor(
  db: Db,
  messageId: string,
): { workspaceId: string; memberId: string } | null {
  const row = db
    .prepare('SELECT workspace_id, member_id FROM chat_messages WHERE id = ?')
    .get(messageId) as { workspace_id: string; member_id: string } | undefined;
  return row ? { workspaceId: row.workspace_id, memberId: row.member_id } : null;
}

export function removeChat(db: Db, messageId: string): void {
  db.prepare('DELETE FROM chat_messages WHERE id = ?').run(messageId);
}

/**
 * Forget everything older than the retention window, across every office.
 *
 * Runs beside the stale-member sweep rather than on a clock of its own,
 * because the two are the same kind of promise — the office does not keep
 * things about people indefinitely — and a second daily timer is a second
 * thing to forget to start.
 */
export function pruneChat(db: Db, now: number = Date.now()): number {
  return db.prepare('DELETE FROM chat_messages WHERE at < ?').run(now - CHAT_MAX_AGE_MS).changes;
}
