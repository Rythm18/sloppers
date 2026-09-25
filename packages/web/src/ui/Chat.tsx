import type { ChatMessage } from '@sloppers/protocol';
import { CHAT_KEPT, MAX_CHAT_LENGTH, normalizeChatText } from '@sloppers/protocol';
import { useEffect, useRef, useState } from 'react';
import { sendAdmin, sendChat } from '../net/socket.js';
import { useStore } from '../store.js';
import { chatTime } from './format.js';
import { useKeyboardInset } from './viewport.js';

/**
 * The office's one conversation.
 *
 * Everything in here is plain text and nothing in it is parsed. React escapes
 * what it renders, which is most of the safety, and the rest is what is *not*
 * done: this app has no raw-HTML escape hatch anywhere in it, no markdown, and
 * no turning a URL into a link. That last one is a choice rather than an
 * omission. A clickable link is the affordance that makes a pasted address
 * worth pasting, and among a handful of friends the only thing it buys is one
 * fewer copy — against every phishing link in the world arriving pre-armed.
 * People can select a URL and copy it, the way they would out of a terminal.
 *
 * Nothing here needs to keep Phaser's hands off the keyboard, and that is
 * because the office already did the work twice: the scene registers its keys
 * with capture off, so a text field over the canvas actually receives w, a, s
 * and d, and `keyHeading` refuses to move the avatar while anything is
 * focused. This is an ordinary `<input>` for exactly that reason.
 */

/** How far from the bottom still counts as "watching the live end". */
const PINNED_PX = 40;

/** Consecutive lines by one person, close together, read as one turn. */
const SAME_TURN_MS = 2 * 60 * 1000;

/**
 * Whether this line should carry its author's name, or continue the one above.
 *
 * Repeating a name down six lines of somebody thinking out loud is most of
 * what makes a narrow chat panel unreadable. Two minutes is the gap after
 * which a follow-up is a new thought rather than the same one.
 */
export function startsTurn(message: ChatMessage, previous: ChatMessage | undefined): boolean {
  if (!previous) return true;
  return previous.memberId !== message.memberId || message.at - previous.at > SAME_TURN_MS;
}

export function Chat() {
  const open = useStore((s) => s.chatOpen);
  const messages = useStore((s) => s.chat);
  const you = useStore((s) => s.you);
  const myRole = useStore((s) => s.myRole);
  const unreadSince = useStore((s) => s.chatUnreadSince);
  const error = useStore((s) => s.chatError);
  const setChatOpen = useStore((s) => s.setChatOpen);
  const chatCaughtUp = useStore((s) => s.chatCaughtUp);
  const setChatError = useStore((s) => s.setChatError);
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  /**
   * Whether the log was at its live end when the last message arrived. A panel
   * that scrolls to the bottom unconditionally is a panel that yanks the page
   * out from under anybody reading back through this morning.
   */
  const pinned = useRef(true);
  // See `useKeyboardInset`: on a phone the panel sits on the bottom edge and
  // the keyboard slides over it. Nothing in CSS can see that happen.
  const inset = useKeyboardInset();

  // The dependencies are the whole point and neither is read in the body: this
  // is not a computation over `messages`, it is a reaction to a line arriving
  // or to the panel being shown. Dropping them — which is what the rule wants
  // — leaves a log that scrolls once on mount and never again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggers, not inputs
  useEffect(() => {
    const log = logRef.current;
    if (log && pinned.current) log.scrollTop = log.scrollHeight;
  }, [messages, open]);

  if (!open) return null;

  const canModerate = myRole === 'owner' || myRole === 'moderator';
  const ready = normalizeChatText(draft).length > 0;
  const left = MAX_CHAT_LENGTH - draft.length;

  const rememberScroll = () => {
    const log = logRef.current;
    if (!log) return;
    pinned.current = log.scrollHeight - log.scrollTop - log.clientHeight < PINNED_PX;
  };

  const say = (event: React.FormEvent) => {
    event.preventDefault();
    const text = normalizeChatText(draft);
    if (!text) return;
    sendChat(text);
    setDraft('');
    // Answering is what catches somebody up — the rule marking where they
    // stopped reading has done its job, and a refusal from before they typed
    // this is no longer about anything on screen.
    chatCaughtUp();
  };

  return (
    <section
      className="chat panel"
      aria-label="office chat"
      style={{ ['--kb' as string]: `${inset}px` }}
    >
      <div className="chat-head">
        <span className="panel-title">Chat</span>
        <button
          type="button"
          className="chat-close"
          aria-label="hide chat"
          onClick={() => setChatOpen(false)}
        >
          ×
        </button>
      </div>

      {/* `log` rather than `feed`: lines arrive at the end and nothing above
          them changes, which is what tells a screen reader to read out the new
          one rather than the panel. */}
      <div
        className="chat-log"
        ref={logRef}
        role="log"
        aria-live="polite"
        onScroll={rememberScroll}
      >
        {messages.length === 0 ? (
          <p className="chat-empty">
            Nobody has said anything yet. The office keeps the last {CHAT_KEPT} lines — long enough
            that something said at midnight is still here in the morning.
          </p>
        ) : (
          messages.map((message, i) => {
            const mine = message.memberId === you;
            return (
              <div key={message.id}>
                {/* Drawn *above* the first line somebody missed, so it reads
                    as a place in the conversation rather than as a label on
                    one message. */}
                {unreadSince !== null && message.at === unreadSince ? (
                  <p className="chat-mark">new</p>
                ) : null}
                <p className={`chat-line${mine ? ' chat-line-mine' : ''}`}>
                  {startsTurn(message, messages[i - 1]) ? (
                    <span className="chat-who" title={chatTime(message.at)}>
                      {message.displayName}
                    </span>
                  ) : null}
                  <span className="chat-text">{message.text}</span>
                  {mine || canModerate ? (
                    <button
                      type="button"
                      className="chat-remove"
                      // The name says whose line it takes down: a column of
                      // identical "delete" buttons is unusable by anybody who
                      // cannot see which one they are on.
                      aria-label={`delete ${message.displayName}'s message`}
                      onClick={() => sendAdmin({ kind: 'chat-delete', messageId: message.id })}
                    >
                      ×
                    </button>
                  ) : null}
                </p>
              </div>
            );
          })
        )}
      </div>

      {error ? (
        <p className="chat-error" role="status">
          {error}
        </p>
      ) : null}

      <form className="chat-compose" onSubmit={say}>
        <input
          className="input chat-input"
          value={draft}
          // The browser's own ceiling, so nobody can reach the wire's: it
          // truncates a paste rather than refusing the message behind it.
          maxLength={MAX_CHAT_LENGTH}
          placeholder="say something"
          aria-label="say something to the office"
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            // A refusal describes the thing that was just sent. Typing the
            // next one makes it stale.
            if (error) setChatError(null);
          }}
          onKeyDown={(event) => {
            // Back to the floor. Without it the only way out of the input on a
            // laptop is finding somewhere else to click — and WASD does
            // nothing at all while it holds focus, by design.
            if (event.key === 'Escape') event.currentTarget.blur();
          }}
        />
        <button type="submit" className="btn" disabled={!ready}>
          Say
        </button>
      </form>
      {/* Only once it is close enough to matter. A counter over an empty box is
          the panel worrying at somebody who has not typed anything. */}
      {left <= 60 ? <p className="chat-left">{left} left</p> : null}
    </section>
  );
}
