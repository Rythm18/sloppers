import { z } from 'zod';

/**
 * What one person says to the office.
 *
 * The first thing on this wire that a human authored for other humans, and
 * the only thing the server stores that was written rather than measured. The
 * rest of the protocol carries facts a machine observed — tokens, positions,
 * presence — which are wrong or right. A sentence is neither, and everything
 * in this file exists because of that difference: it is bounded, it is
 * flattened to one line, and it never carries anything that could make what
 * is drawn on screen disagree with what was actually typed.
 */

/**
 * The longest thing anybody may say at once.
 *
 * Five hundred is about four lines in the office's panel and comfortably more
 * than anyone types into a chat box between friends — the cap is here to bound
 * a table and a broadcast, not to cut somebody off mid-thought. The browser
 * sets the same number on the input, so a person can never reach it by
 * accident; only a hand-written client can, and it gets the schema's refusal.
 */
export const MAX_CHAT_LENGTH = 500;

/**
 * How many lines an office keeps, and the ceiling a browser holds in memory.
 *
 * One number for both on purpose: the scrollback a person can reach by
 * scrolling up is exactly the scrollback that survives the server going to
 * sleep, so there is no state where the panel shows something the office would
 * not hand back on the next visit.
 */
export const CHAT_KEPT = 200;

/** How many of those the office hands a browser that has just walked in. */
export const CHAT_BACKLOG = 50;

/**
 * Everything that can make rendered text lie about itself, removed before a
 * message is stored — so the string in the table is the string on the screen.
 *
 * React escapes markup, which is the attack everybody thinks of and the one
 * this does *not* address. These are the other half. `\p{Cc}` is every control
 * character — the bytes a terminal or a log viewer downstream would act on
 * rather than print, which is a real destination for this text the moment
 * anybody tails the server. Tab, newline and carriage return are in there too
 * and lose nothing by it: they become spaces one line above the whitespace
 * collapse that was going to flatten them anyway.
 *
 * The second set is the bidi embedding, override and isolate controls, whose
 * entire purpose is to make a run of characters display in an order other than
 * the one it is stored in. Named by codepoint rather than by `\p{Cf}`, which
 * would be the tidier rule and would also take every family emoji apart into
 * three people and a mystery — the zero-width joiner is in that category. This
 * is a chat between friends; emoji are most of what it is for.
 */
const CONTROLS = /\p{Cc}/gu;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * One line, as the office will keep it.
 *
 * Whitespace collapses to single spaces, which is what flattens a message to a
 * line: the panel is a narrow column of pixel furniture, and four hundred
 * newlines pasted into it would be four hundred rows of nothing pushing the
 * conversation off the top. Nobody writes a code block in here, and the day
 * somebody wants to, sending it as a link is the better answer anyway.
 *
 * Replaced with a space rather than removed, so that stripping a control
 * character out of the middle of two words cannot silently weld them together.
 *
 * The server runs this and stores what it returns; the browser runs the same
 * function to decide whether there is anything to send at all. One definition
 * of "empty", in one place, on both sides.
 */
export function normalizeChatText(raw: string): string {
  return raw.replace(CONTROLS, ' ').replace(BIDI, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * What a browser is allowed to put on the wire. Shape only — whether there is
 * anything *in* it is `normalizeChatText`'s question, and the server's to ask,
 * because the schema cannot see what a string looks like once it is flattened.
 */
export const chatTextSchema = z.string().min(1).max(MAX_CHAT_LENGTH);

/**
 * One line of an office's conversation.
 *
 * `displayName` rides along rather than being looked up from the member list,
 * and that is deliberate: a line is a record of what somebody said, under the
 * name they said it under. The room's live member map holds only people who
 * are *here*, so a name resolved at render time would go blank the moment its
 * author closed their laptop — which is precisely when their message is the
 * thing you came back to read.
 */
export const chatMessageSchema = z.object({
  id: z.string().min(1).max(64),
  memberId: z.string().min(1),
  displayName: z.string().min(1).max(32),
  text: z.string().min(1).max(MAX_CHAT_LENGTH),
  at: z.number().int().positive(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
