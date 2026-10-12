// The team that owns the workspace you're looking at — NOT the team your account was created
// in. They differ whenever you're a member of another company's workspace (an operator setting
// up a client, GET-241), and every "which team is this" question on screen (the rail name, the
// member list, where an invite goes, what the name field renames) means the first one.
//
// Source of truth: `userData.workspace_team` off /me (me.mjs). `userData.team` stays the
// account's home team and is only the fallback for an older API that doesn't send the field.
// Read the team through this helper; never pick between the two fields inline.

export type ActiveTeam = { id: string; name: string };

export function activeTeam(userData: any): ActiveTeam | null {
  const t = userData?.workspace_team ?? userData?.team ?? null;
  return t?.id ? { id: t.id, name: t.name ?? "" } : null;
}
