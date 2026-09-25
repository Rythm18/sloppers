import { describe, expect, it } from 'vitest';
import { CHAT_BACKLOG, MAX_CHAT_LENGTH, normalizeChatText } from './chat.js';
import { collectorToServerSchema, serverToCollectorSchema } from './collector.js';
import { serverToWebSchema, webToServerSchema } from './web.js';

/**
 * The characters this file is about, written by codepoint.
 *
 * Every one of them is invisible or misleading on screen — which is the whole
 * reason they are stripped — so pasting them into a test literal would leave
 * assertions that cannot be read and diffs that cannot be reviewed.
 */
const NUL = String.fromCodePoint(0x00);
const BELL = String.fromCodePoint(0x07);
const ESC = String.fromCodePoint(0x1b);
/** Everything after it renders backwards. How `safe⁧txt.exe` is made. */
const RTL_OVERRIDE = String.fromCodePoint(0x202e);
const ISOLATE_START = String.fromCodePoint(0x2066);
const ISOLATE_END = String.fromCodePoint(0x2069);
/** Invisible, in the same Unicode category, and load-bearing for emoji. */
const ZWJ = String.fromCodePoint(0x200d);

describe('normalizeChatText', () => {
  it('flattens a message to one line', () => {
    expect(normalizeChatText('one\ntwo\r\n\tthree')).toBe('one two three');
    expect(normalizeChatText('  padded  ')).toBe('padded');
    expect(normalizeChatText('gaps      here')).toBe('gaps here');
  });

  it('is the one definition of empty, and a strict one', () => {
    // Each of these passes the schema's `min(1)` and is nothing at all by the
    // time it would be a message. The server asks this, not the schema, which
    // is why an empty answer has a refusal of its own rather than reading as a
    // malformed message.
    expect(normalizeChatText('')).toBe('');
    expect(normalizeChatText('   ')).toBe('');
    expect(normalizeChatText('\n\n\t')).toBe('');
    expect(normalizeChatText(NUL + BELL)).toBe('');
  });

  it('takes out control characters without welding the words together', () => {
    // A space, not a deletion: "drop table" is two words and must stay two.
    expect(normalizeChatText(`drop${NUL}table`)).toBe('drop table');
    expect(normalizeChatText(`bell${BELL}ringer`)).toBe('bell ringer');
    // The escape that would open an ANSI sequence in a terminal tailing the
    // server — the bracket and the digits are ordinary text and stay.
    expect(normalizeChatText(`${ESC}[31mred${ESC}[0m`)).toBe('[31mred [0m');
  });

  it('takes out the controls that make text display in the wrong order', () => {
    expect(normalizeChatText(`safe${RTL_OVERRIDE}txt.exe`)).toBe('safe txt.exe');
    expect(normalizeChatText(`${ISOLATE_START}isolated${ISOLATE_END}`)).toBe('isolated');
  });

  it('leaves an emoji whole', () => {
    // Stripping every invisible would be the tidier rule and would take a
    // family apart into three separate people. This is a chat between friends.
    const family = `${String.fromCodePoint(0x1f468)}${ZWJ}${String.fromCodePoint(0x1f469)}${ZWJ}${String.fromCodePoint(0x1f467)}`;
    expect(normalizeChatText(`nice ${family}`)).toBe(`nice ${family}`);
    expect(normalizeChatText('shipped ❤️')).toBe('shipped ❤️');
  });

  it('never grows a message past the cap it was checked against', () => {
    // The schema bounds the raw string; the server stores what comes out of
    // here. A normalizer that could lengthen anything would put a line in the
    // table longer than the wire ever agreed to carry.
    const raw = `${'x'.repeat(MAX_CHAT_LENGTH - 2)}\n\ty`;
    expect(normalizeChatText(raw).length).toBeLessThanOrEqual(raw.length);
  });
});

describe('chat on the wire', () => {
  it('takes a message up to the cap and refuses one past it', () => {
    expect(webToServerSchema.safeParse({ type: 'chat', text: 'hello' }).success).toBe(true);
    expect(
      webToServerSchema.safeParse({ type: 'chat', text: 'x'.repeat(MAX_CHAT_LENGTH) }).success,
    ).toBe(true);
    expect(
      webToServerSchema.safeParse({ type: 'chat', text: 'x'.repeat(MAX_CHAT_LENGTH + 1) }).success,
    ).toBe(false);
    expect(webToServerSchema.safeParse({ type: 'chat', text: '' }).success).toBe(false);
  });

  it('round-trips a broadcast line, a backlog, and a removal', () => {
    const message = {
      id: 'c_1',
      memberId: 'm_1',
      displayName: 'ridham',
      text: 'shipped it, look at the board',
      at: 1_700_000_000_000,
    };
    expect(serverToWebSchema.parse({ type: 'chat', message })).toEqual({ type: 'chat', message });

    const log = { type: 'chat-log', messages: [message], unreadSince: message.at };
    expect(serverToWebSchema.parse(log)).toEqual(log);
    // The mark is optional, and absent is the common case: most arrivals
    // missed nothing.
    expect(serverToWebSchema.parse({ type: 'chat-log', messages: [] })).toEqual({
      type: 'chat-log',
      messages: [],
    });

    expect(serverToWebSchema.parse({ type: 'chat-removed', id: 'c_1' })).toEqual({
      type: 'chat-removed',
      id: 'c_1',
    });
  });

  it('refuses a backlog bigger than the office ever sends', () => {
    const message = { id: 'c', memberId: 'm', displayName: 'r', text: 'x', at: 1 };
    const tooMany = Array.from({ length: CHAT_BACKLOG + 1 }, (_, i) => ({
      ...message,
      id: `c${i}`,
    }));
    expect(serverToWebSchema.safeParse({ type: 'chat-log', messages: tooMany }).success).toBe(
      false,
    );
  });

  it('carries a refusal code of its own, so it can reach the text box', () => {
    const refusal = { type: 'error', code: 'chat-refused', message: 'easy' };
    expect(serverToWebSchema.parse(refusal)).toEqual(refusal);
  });

  /**
   * `sloppers@0.2.1` is published and in use, and a collector never chats.
   * Everything chat added lives in the web union and the admin ops; the two
   * unions a daemon parses must be untouched by it, or an installed collector
   * starts dropping messages it used to understand.
   */
  it('changes nothing a collector parses', () => {
    const kinds = collectorToServerSchema.options.map((option) => option.shape.type.value);
    expect(kinds).toEqual(['hello', 'snapshot']);

    const answers = serverToCollectorSchema.options.map((option) => option.shape.type.value);
    expect(answers).toEqual(['hello-ok', 'error']);

    // And a chat message is not something a daemon can even say.
    expect(collectorToServerSchema.safeParse({ type: 'chat', text: 'hello' }).success).toBe(false);
  });
});
