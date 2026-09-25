/**
 * The only place a role is ever compared. Voice muting will extend Action
 * rather than inventing its own check, the way `chat.delete` did.
 */
export type Role = 'owner' | 'moderator' | 'member';

export type Action =
  | 'workspace.rename'
  | 'workspace.settings'
  | 'workspace.rotate-invite'
  | 'workspace.transfer'
  | 'member.kick'
  | 'member.ban'
  | 'member.unban'
  | 'member.promote'
  | 'member.demote'
  | 'member.delete'
  | 'knock.decide'
  /**
   * Take somebody *else's* line out of the conversation. Taking your own back
   * needs no permission at all and never asks this — see `handleAdminOp`,
   * which checks authorship first, exactly as `member.delete` checks for self.
   */
  | 'chat.delete';

const MODERATOR_ACTIONS: ReadonlySet<Action> = new Set([
  'member.kick',
  'member.ban',
  'member.unban',
  'knock.decide',
  // Anybody who can show a person the door can take down a line they said.
  // The realistic need in a friends' office is not abuse, it is a secret
  // pasted into the wrong window — and making that wait for the owner to wake
  // up is the difference between a tool and a gesture.
  'chat.delete',
]);

export function can(role: Role, action: Action): boolean {
  if (role === 'owner') return true;
  if (role === 'moderator') return MODERATOR_ACTIONS.has(action);
  return false;
}

export function rank(role: Role): number {
  return role === 'owner' ? 2 : role === 'moderator' ? 1 : 0;
}

/**
 * Role comparison alone is not enough: moderators must not be able to kick
 * each other, and nobody may touch an owner. Owners outrank everyone but a
 * peer owner (a state transfer never produces, but which the check refuses
 * rather than assumes away).
 */
export function canActOn(actor: Role, target: Role): boolean {
  if (actor === 'member') return false;
  return rank(actor) > rank(target);
}
