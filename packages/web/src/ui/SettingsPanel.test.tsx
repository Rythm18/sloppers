// @vitest-environment jsdom
import type {
  AdminOp,
  KnockView,
  MemberRole,
  MemberStatus,
  RosterEntry,
  ServerToWeb,
  WorkspaceSettings,
} from '@sloppers/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendAdmin } from '../net/socket.js';
import { useStore } from '../store.js';
import { SettingsPanel } from './SettingsPanel.js';

/**
 * Every button in this panel is a destructive-capable `AdminOp` on the wire.
 * These tests are about the decisions — which op each control sends, who is
 * offered which control, and what has to happen before a removal fires — not
 * about the markup around them.
 */

vi.mock('../net/socket.js', () => ({ sendAdmin: vi.fn() }));

const sendAdminMock = vi.mocked(sendAdmin);
const ops = (): AdminOp[] => sendAdminMock.mock.calls.map(([op]) => op);
/** Everything the panel sent except the roster fetch it makes on open. */
const opsAfterOpening = (): AdminOp[] => ops().filter((op) => op.kind !== 'roster');

const ROOM = 'the-lab-k4xp2q';
const OPEN_DOOR: WorkspaceSettings = { joinMode: 'link', publicLeaderboard: false };

function memberView(id: string, displayName: string, role: MemberRole) {
  return {
    id,
    displayName,
    avatar: 'pixel',
    role,
    presence: 'active' as const,
    position: { x: 0, y: 0, dir: 'down' as const, moving: false },
    sessions: [],
    today: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      sessionsRun: 0,
      activeMinutes: 0,
    },
    sharing: false,
  };
}

function person(
  id: string,
  displayName: string,
  role: MemberRole,
  status: MemberStatus = 'active',
): RosterEntry {
  return { id, displayName, avatar: 'pixel', role, status, sharing: false, lastSeenAt: 0 };
}

/** A server message arriving at a mounted panel, flushed like a real one. */
const apply = (msg: ServerToWeb) => act(() => useStore.getState().applyServer(msg));
const setOpen = (open: boolean) => act(() => useStore.getState().setSettingsOpen(open));

/** Put a viewer in an office with the panel open, the way the server would. */
function seed(options: {
  role: MemberRole;
  roster?: RosterEntry[];
  knocks?: KnockView[];
  settings?: WorkspaceSettings;
}): void {
  useStore.getState().reset();
  apply({
    type: 'world',
    you: { memberId: 'me' },
    roomCode: ROOM,
    roomName: 'the lab',
    members: [memberView('me', 'ridham', options.role)],
    leaderboard: [],
  });
  apply({
    type: 'workspace',
    roomCode: ROOM,
    roomName: 'the lab',
    settings: options.settings ?? OPEN_DOOR,
  });
  if (options.roster) apply({ type: 'roster', members: options.roster });
  if (options.knocks) apply({ type: 'knocks', knocks: options.knocks });
  setOpen(true);
}

const button = (name: string) => screen.getByRole('button', { name });

describe('SettingsPanel', () => {
  beforeEach(() => {
    sendAdminMock.mockClear();
    useStore.getState().reset();
  });

  afterEach(cleanup);

  it('stays shut until the store opens it, and shuts again on Escape', () => {
    seed({ role: 'owner' });
    setOpen(false);
    render(<SettingsPanel />);
    expect(screen.queryByRole('dialog')).toBeNull();

    setOpen(true);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useStore.getState().settingsOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts focus inside the dialog when it opens', () => {
    seed({ role: 'owner' });
    const { container } = render(<SettingsPanel />);
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    expect(container.contains(document.activeElement)).toBe(true);
  });

  describe('being modal about it', () => {
    /** The panel with something behind it, the way the app renders it. */
    function renderOverTheOffice() {
      const view = render(
        <>
          <button type="button" data-testid="behind">
            out on the floor
          </button>
          <SettingsPanel />
        </>,
      );
      const behind = view.getByTestId('behind');
      return { ...view, behind };
    }

    it('pulls a wandering focus back in rather than letting Tab out', () => {
      seed({ role: 'owner' });
      const { behind } = renderOverTheOffice();
      const dialog = screen.getByRole('dialog');

      behind.focus();
      expect(document.activeElement).toBe(behind);

      fireEvent.keyDown(window, { key: 'Tab' });

      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('holds focus at the far end when it wraps', () => {
      seed({ role: 'owner' });
      renderOverTheOffice();
      const dialog = screen.getByRole('dialog');
      const stops = [
        ...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
      ];
      const last = stops.at(-1);
      if (!last) throw new Error('the dialog should have somewhere to put focus');

      last.focus();
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(document.activeElement).toBe(stops[0]);

      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);
    });

    it('marks the office behind it inert, and hands it back on the way out', () => {
      seed({ role: 'owner' });
      const { behind } = renderOverTheOffice();

      // `aria-modal` alone tells assistive tech the background is unavailable
      // while leaving it perfectly reachable.
      expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
      expect(behind.hasAttribute('inert')).toBe(true);

      setOpen(false);

      expect(behind.hasAttribute('inert')).toBe(false);
    });
  });

  describe('the ops each control sends', () => {
    it('sends the door mode the person picked, leaving the rest of the settings alone', () => {
      seed({ role: 'owner', settings: { joinMode: 'link', publicLeaderboard: true } });
      render(<SettingsPanel />);

      fireEvent.click(screen.getByRole('radio', { name: /Ask to join/ }));

      expect(opsAfterOpening()).toEqual([
        { kind: 'settings', settings: { joinMode: 'knock', publicLeaderboard: true } },
      ]);
    });

    it('sends the leaderboard consent, leaving the door alone', () => {
      seed({ role: 'owner', settings: { joinMode: 'locked', publicLeaderboard: false } });
      render(<SettingsPanel />);

      fireEvent.click(screen.getByRole('checkbox'));

      expect(opsAfterOpening()).toEqual([
        { kind: 'settings', settings: { joinMode: 'locked', publicLeaderboard: true } },
      ]);
    });

    it('renames and rotates from the office section', () => {
      seed({ role: 'owner' });
      render(<SettingsPanel />);

      fireEvent.change(screen.getByLabelText('office name'), { target: { value: ' the annex ' } });
      fireEvent.click(button('Rename'));
      fireEvent.click(button('Rotate invite link'));

      expect(opsAfterOpening()).toEqual([
        { kind: 'rename', name: 'the annex' },
        { kind: 'rotate-invite' },
      ]);
    });

    it('admits and turns away the person each knock button names', () => {
      seed({
        role: 'moderator',
        knocks: [
          { id: 'k1', displayName: 'theo', avatar: 'pixel', requestedAt: 1 },
          { id: 'k2', displayName: 'nina', avatar: 'pixel', requestedAt: 2 },
        ],
      });
      render(<SettingsPanel />);

      fireEvent.click(button('Turn away: theo'));
      fireEvent.click(button('Let in: nina'));

      expect(opsAfterOpening()).toEqual([
        { kind: 'knock-deny', knockId: 'k1' },
        { kind: 'knock-admit', knockId: 'k2' },
      ]);
    });

    it('promotes, demotes, and unbans the member each button names', () => {
      seed({
        role: 'owner',
        roster: [
          person('me', 'ridham', 'owner'),
          person('sam', 'sam', 'member'),
          person('lee', 'lee', 'moderator'),
          person('old', 'jules', 'member', 'banned'),
        ],
      });
      render(<SettingsPanel />);

      fireEvent.click(button('Make moderator: sam'));
      fireEvent.click(button('Step down: lee'));
      fireEvent.click(button('Unban: jules'));

      expect(opsAfterOpening()).toEqual([
        { kind: 'promote', memberId: 'sam' },
        { kind: 'demote', memberId: 'lee' },
        { kind: 'unban', memberId: 'old' },
      ]);
    });

    it('asks the server for the roster when a moderator opens the panel', () => {
      seed({ role: 'moderator' });
      render(<SettingsPanel />);

      expect(ops()).toEqual([{ kind: 'roster' }]);
    });

    it('asks once, and leaves the office to volunteer everything after that', () => {
      seed({ role: 'moderator' });
      render(<SettingsPanel />);
      sendAdminMock.mockClear();

      // Admin ops are rate-limited, and people arriving is exactly when a
      // moderator needs the panel working. The server pushes these changes;
      // the panel must not go asking for them.
      apply({ type: 'member', member: memberView('sam', 'sam', 'member') });
      apply({ type: 'member', member: memberView('lee', 'lee', 'member') });
      apply({ type: 'member-left', memberId: 'sam' });

      expect(ops()).toEqual([]);
    });

    it('does not ask for the roster on behalf of someone who cannot see it', () => {
      seed({ role: 'member' });
      render(<SettingsPanel />);

      expect(ops()).toEqual([]);
    });

    it('mints a device link for anyone who asks', () => {
      seed({ role: 'member' });
      render(<SettingsPanel />);

      fireEvent.click(button('Sign in on another device'));

      expect(opsAfterOpening()).toEqual([{ kind: 'link-device' }]);
    });
  });

  describe('removing somebody', () => {
    const roster = [person('me', 'ridham', 'owner'), person('sam', 'sam', 'member')];

    it('sends kick — not ban — once the removal is confirmed', () => {
      seed({ role: 'owner', roster });
      render(<SettingsPanel />);

      fireEvent.click(button('Remove: sam'));
      expect(opsAfterOpening()).toEqual([]);

      fireEvent.click(button('Yes, remove: sam'));

      expect(opsAfterOpening()).toEqual([{ kind: 'kick', memberId: 'sam' }]);
    });

    it('sends ban — not kick — once the ban is confirmed', () => {
      seed({ role: 'owner', roster });
      render(<SettingsPanel />);

      fireEvent.click(button('Ban: sam'));
      expect(opsAfterOpening()).toEqual([]);

      fireEvent.click(button('Yes, ban: sam'));

      expect(opsAfterOpening()).toEqual([{ kind: 'ban', memberId: 'sam' }]);
    });

    it('fires nothing on the first click, and nothing at all if the answer is no', () => {
      seed({ role: 'owner', roster });
      render(<SettingsPanel />);

      fireEvent.click(button('Ban: sam'));
      expect(opsAfterOpening()).toEqual([]);
      fireEvent.click(button('Never mind: sam'));

      expect(opsAfterOpening()).toEqual([]);
      // Back to a row, not a question — and armed again from scratch.
      expect(button('Ban: sam')).toBeTruthy();
    });

    it('names the person and the cost in the question it asks', () => {
      seed({ role: 'owner', roster });
      render(<SettingsPanel />);

      fireEvent.click(button('Ban: sam'));

      expect(screen.getByText(/Ban sam\?/).textContent).toContain('none of their stats');
      // The question takes the focus the armed button had, so a keyboard
      // answer lands on the confirmation rather than nowhere.
      expect(document.activeElement).toBe(button('Yes, ban: sam'));
    });

    it('asks about one person at a time', () => {
      seed({
        role: 'owner',
        roster: [...roster, person('lee', 'lee', 'member')],
      });
      render(<SettingsPanel />);

      fireEvent.click(button('Ban: sam'));
      expect(screen.queryByRole('button', { name: 'Yes, ban: lee' })).toBeNull();

      // Two irreversible questions open at once is two chances to answer the
      // wrong one. Arming lee puts sam's question away.
      fireEvent.click(button('Remove: lee'));

      expect(screen.queryByRole('button', { name: 'Yes, ban: sam' })).toBeNull();
      expect(button('Ban: sam')).toBeTruthy();
      fireEvent.click(button('Yes, remove: lee'));
      expect(opsAfterOpening()).toEqual([{ kind: 'kick', memberId: 'lee' }]);
    });

    it('puts the question away when somebody else gets there first', () => {
      seed({ role: 'owner', roster });
      render(<SettingsPanel />);
      fireEvent.click(button('Ban: sam'));
      expect(button('Yes, ban: sam')).toBeTruthy();

      // Another admin banned sam while this question sat open. Answering it
      // now would fire an op the office refuses, silently.
      apply({
        type: 'roster',
        members: [person('me', 'ridham', 'owner'), person('sam', 'sam', 'member', 'banned')],
      });

      expect(screen.queryByRole('button', { name: 'Yes, ban: sam' })).toBeNull();
      expect(opsAfterOpening()).toEqual([]);
      expect(button('Unban: sam')).toBeTruthy();
    });
  });

  describe('who is offered what', () => {
    const roster = [
      person('me', 'ridham', 'moderator'),
      person('boss', 'ridham-senior', 'owner'),
      person('lee', 'lee', 'moderator'),
      person('sam', 'sam', 'member'),
    ];

    it('shows a plain member nothing to moderate with', () => {
      seed({
        role: 'member',
        roster,
        knocks: [{ id: 'k1', displayName: 'theo', avatar: 'pixel', requestedAt: 1 }],
      });
      render(<SettingsPanel />);

      expect(screen.queryByText('People')).toBeNull();
      expect(screen.queryByText('Waiting to come in')).toBeNull();
      expect(screen.queryByText('The door')).toBeNull();
      expect(screen.queryByText('Office')).toBeNull();
      expect(screen.queryByText('Leaderboard')).toBeNull();
      expect(
        screen.queryByRole('button', { name: /^(Remove|Ban|Unban|Make moderator):/ }),
      ).toBeNull();
      // What is theirs, they still get.
      expect(screen.getByText('This device')).toBeTruthy();
      expect(screen.getByText('Leave for good')).toBeTruthy();
    });

    it('keeps the owner-only sections away from a moderator', () => {
      seed({ role: 'moderator', roster });
      render(<SettingsPanel />);

      expect(screen.queryByText('Office')).toBeNull();
      expect(screen.queryByText('The door')).toBeNull();
      expect(screen.queryByText('Leaderboard')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Rotate invite link' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Make moderator: sam' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Step down: lee' })).toBeNull();
      // Moderating is still theirs to do.
      expect(screen.getByText('People')).toBeTruthy();
      expect(button('Remove: sam')).toBeTruthy();
    });

    it('offers a moderator no way to remove a peer or the owner', () => {
      seed({ role: 'moderator', roster });
      render(<SettingsPanel />);

      expect(screen.queryByRole('button', { name: 'Remove: lee' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Ban: lee' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Remove: ridham-senior' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Ban: ridham-senior' })).toBeNull();
      // Nor themselves.
      expect(screen.queryByRole('button', { name: 'Remove: ridham' })).toBeNull();
    });

    it('gives the owner the whole panel', () => {
      seed({
        role: 'owner',
        roster: [person('me', 'ridham', 'owner'), person('sam', 'sam', 'member')],
      });
      render(<SettingsPanel />);

      for (const title of ['Office', 'The door', 'Leaderboard', 'People', 'This device']) {
        expect(screen.getByText(title)).toBeTruthy();
      }
      expect(button('Remove: sam')).toBeTruthy();
    });
  });

  describe('the name it compares against', () => {
    it('follows a rename instead of holding the name the panel opened with', () => {
      seed({ role: 'owner' });
      render(<SettingsPanel />);
      const input = screen.getByLabelText('office name') as HTMLInputElement;

      fireEvent.change(input, { target: { value: 'the annex' } });
      expect((button('Rename') as HTMLButtonElement).disabled).toBe(false);

      // Renamed elsewhere — another tab, another device. That is the office's
      // name now, and a half-typed idea is not competing with it.
      apply({ type: 'workspace', roomCode: ROOM, roomName: 'the vault', settings: OPEN_DOOR });

      expect(input.value).toBe('the vault');
      expect((button('Rename') as HTMLButtonElement).disabled).toBe(true);
    });

    it("starts each visit from the office name, not last visit's abandoned draft", () => {
      seed({ role: 'owner' });
      render(<SettingsPanel />);

      fireEvent.change(screen.getByLabelText('office name'), { target: { value: 'abandoned' } });
      setOpen(false);
      setOpen(true);

      expect((screen.getByLabelText('office name') as HTMLInputElement).value).toBe('the lab');
    });

    it('accepts exactly the office name the server would', () => {
      seed({ role: 'owner' });
      render(<SettingsPanel />);

      // The server refuses anything longer; typing it in full and being told
      // no on arrival is not a thing this input should allow.
      expect((screen.getByLabelText('office name') as HTMLInputElement).maxLength).toBe(32);
    });
  });

  describe('deleting yourself', () => {
    it('unlocks only for your own name, and tracks it if the name changes', () => {
      seed({ role: 'member' });
      render(<SettingsPanel />);
      const confirm = () => button('Delete me') as HTMLButtonElement;

      expect(confirm().disabled).toBe(true);
      fireEvent.change(screen.getByLabelText('your name'), { target: { value: 'sam' } });
      expect(confirm().disabled).toBe(true);

      fireEvent.change(screen.getByLabelText('your name'), { target: { value: 'ridham' } });
      expect(confirm().disabled).toBe(false);

      // Renamed out from under the typed confirmation: the gate is the name
      // the office knows now, not the one this component read on first render.
      apply({ type: 'member', member: memberView('me', 'rid', 'member') });
      expect(confirm().disabled).toBe(true);

      fireEvent.change(screen.getByLabelText('your name'), { target: { value: 'rid' } });
      fireEvent.click(confirm());
      expect(opsAfterOpening()).toEqual([{ kind: 'delete', memberId: 'me' }]);
    });

    it('stays locked while the office has not said who you are', () => {
      seed({ role: 'member' });
      // No member view to read a name from — an empty box must not match an
      // empty name and fire a delete at nobody.
      apply({ type: 'member-left', memberId: 'me' });
      render(<SettingsPanel />);

      expect((button('Delete me') as HTMLButtonElement).disabled).toBe(true);
    });

    it('tells an owner to hand the keys over rather than offering a button that fails', () => {
      seed({ role: 'owner' });
      render(<SettingsPanel />);

      expect(screen.queryByRole('button', { name: 'Delete me' })).toBeNull();
      expect(screen.getByText(/holding the keys/)).toBeTruthy();
    });
  });
});
