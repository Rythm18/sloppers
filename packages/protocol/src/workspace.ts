import { z } from 'zod';
import { avatarIdSchema, displayNameSchema, roleSchema, roomNameSchema } from './core.js';

/**
 * Everything configurable about a workspace, in one validated blob. Adding a
 * toggle is one line here and needs no migration: settings are always read
 * through this schema with defaults applied, so rows written before a field
 * existed are valid by construction.
 */
export const workspaceSettingsSchema = z.object({
  joinMode: z.enum(['link', 'knock', 'locked']).default('link'),
  /** Consent for the cross-workspace leaderboard. Off until someone opts in. */
  publicLeaderboard: z.boolean().default(false),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const defaultWorkspaceSettings: WorkspaceSettings = workspaceSettingsSchema.parse({});

/** Never throws: a corrupt row degrades to defaults rather than a dead office. */
export function parseSettings(raw: string): WorkspaceSettings {
  try {
    return workspaceSettingsSchema.parse(JSON.parse(raw));
  } catch {
    return { ...defaultWorkspaceSettings };
  }
}

export { type MemberRole, roleSchema } from './core.js';

export const memberStatusSchema = z.enum(['active', 'kicked', 'banned']);
export type MemberStatus = z.infer<typeof memberStatusSchema>;

const memberTarget = z.object({ memberId: z.string().min(1) });

export const adminOpSchema = z.discriminatedUnion('kind', [
  memberTarget.extend({ kind: z.literal('kick') }),
  memberTarget.extend({ kind: z.literal('ban'), reason: z.string().max(200).optional() }),
  memberTarget.extend({ kind: z.literal('unban') }),
  memberTarget.extend({ kind: z.literal('promote') }),
  memberTarget.extend({ kind: z.literal('demote') }),
  memberTarget.extend({ kind: z.literal('transfer') }),
  memberTarget.extend({ kind: z.literal('delete') }),
  z.object({ kind: z.literal('rename'), name: roomNameSchema }),
  z.object({ kind: z.literal('settings'), settings: workspaceSettingsSchema }),
  z.object({ kind: z.literal('rotate-invite') }),
  z.object({ kind: z.literal('knock-admit'), knockId: z.string().min(1) }),
  z.object({ kind: z.literal('knock-deny'), knockId: z.string().min(1) }),
  z.object({ kind: z.literal('link-device') }),
  z.object({ kind: z.literal('roster') }),
]);
export type AdminOp = z.infer<typeof adminOpSchema>;

export const knockViewSchema = z.object({
  id: z.string(),
  displayName: displayNameSchema,
  avatar: avatarIdSchema,
  requestedAt: z.number().int().positive(),
});
export type KnockView = z.infer<typeof knockViewSchema>;

export const rosterEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatar: z.string(),
  role: roleSchema,
  status: memberStatusSchema,
  sharing: z.boolean(),
  lastSeenAt: z.number().int().nonnegative(),
});
export type RosterEntry = z.infer<typeof rosterEntrySchema>;
