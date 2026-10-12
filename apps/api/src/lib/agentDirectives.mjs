import { ROLE_PROFILES, roleDirective, ALL_LENSES } from './roleProfiles.mjs';
// The member's personal-agent directives — the SINGLE source of "who you are working
// for", the rules they set, their format preferences, and their free-text instructions.
// Built once here so EVERY place the agent writes for them obeys the same rules — the
// Threads chat agent, the Studio email draft, future LinkedIn drafts — not just chat.
// (Before this, only the chat prompt loaded the profile; Studio drafting ignored it.)

// What each job actually cares about — a bare label ("sdr") means nothing to the model;
// the brief does.
// ── Ambassador ─────────────────────────────────────────────────────────────
//
// The first person at a new customer, and usually not their founder — the champion who bought
// it and is standing it up. They need every lens: the SDR's view of what's going cold, the
// AE's stage-gate, the CS read, the leadership roll-up. Listing nine job roles on one seat to
// achieve that is a fiddly thing that goes stale the moment we add a tenth, and it says
// nothing about who they actually are.
//
// So it is ONE role that means all of them. `role` (owner/admin/member) still governs
// permissions; this governs the LENS — what reporting, briefs and insights are shaped by.
// Re-exported from the canonical table (lib/roleProfiles.mjs) so there is one list of roles
// in the product, not one per file that happens to need it. Imported as well as re-exported —
// `expandRoles` below needs it as a real binding, which `export ... from` does not create.
export { ALL_LENSES };

/** 'ambassador' expands to every lens; everything else passes through unchanged. */
export function expandRoles(roles) {
  const list = Array.isArray(roles) ? roles : [];
  if (!list.some(r => String(r).toLowerCase() === 'ambassador')) return list;
  return [...new Set([...list.filter(r => String(r).toLowerCase() !== 'ambassador'), ...ALL_LENSES])];
}

// The one-line version, derived from the canonical profiles. Kept because several callers
// want a single sentence rather than the full block (an email draft, a compact header).
// `other` stays null — no role stated is not a role.
export const ROLE_BRIEFS = Object.fromEntries([
  ...Object.entries(ROLE_PROFILES).map(([k, p]) => [k, `${p.label.toLowerCase()}. ${p.objective} Lead with ${p.prioritise[0]}.`]),
  ['other', null],
]);

/**
 * Build the "who you are working for" block from a member profile. Returns '' when
 * there is nothing to say.
 *
 * @param opts.includePrefs  Retained for callers that still pass it; it no longer changes
 *   anything. The answer-format preferences it gated were part of the Behaviour surface,
 *   which is gone — how someone likes to be answered is learned now, not configured.
 */
export function buildMemberBlock(profile, { includePrefs = true } = {}) {
  if (!profile) return '';
  const lines = [];
  const { name, jobRole, jobRoles, workspaceName } = profile;

  if (name || workspaceName) {
    lines.push(`You are working for ${name || 'this user'}${workspaceName ? ` at ${workspaceName}` : ''}.`);
  }

  // The role block carries what this seat is FOR, what to lead with, and what to leave out —
  // not just a title. RevOps and Customer Success read the same graph and want almost nothing
  // in common from it, and "leave out" is most of that difference.
  const roles = Array.isArray(jobRoles) && jobRoles.length ? jobRoles : (jobRole ? [jobRole] : []);
  const directive = roleDirective(roles);
  if (directive) lines.push(directive);
  else if (jobRole && ROLE_BRIEFS[jobRole]) lines.push(`Their role: they are ${ROLE_BRIEFS[jobRole]}`);

  // ── What is NOT here any more, and why ───────────────────────────────────
  //
  // `agent_instructions`, `agent_rules`, `agent_name` and the format/length prefs used to be
  // injected here too: four fields a person filled in on a Behaviour settings page to describe
  // how they wanted to be worked with.
  //
  // That surface is gone. Asking someone to configure an assistant up front asks them to
  // predict, in a form, how they will want to be answered — before they have seen a single
  // answer. Across the whole product one person ever filled any of it in, and what they wrote
  // was a two-word request for shorter answers — which is exactly the kind of thing the agent now learns the first time
  // they say "shorter please" mid-conversation, and can UNLEARN when they change their mind.
  // A typed rule cannot do the second part, which is why it ages badly.
  //
  // So personalisation has two sources now and neither is a form:
  //   the ROLE, set by the company, which is the default before anyone has said anything, and
  //   MEMORY, learned from how they actually work (lib/memoryExtract.mjs), which supersedes.
  //
  // The columns are left in place, unread. Nothing is deleted on someone's behalf.
  // `agent_prefs` is still READ elsewhere for `memory_enabled` — that is a consent switch,
  // not a behaviour instruction, and it stays.

  if (!lines.length) return '';
  return `--- WHO YOU ARE WORKING FOR (their job, not just their title) ---\n${lines.join('\n')}`;
}

/**
 * Load the member's agent profile — their role, and the names to address them and the
 * workspace by. Best-effort: a failure degrades to a
 * generic prompt rather than breaking the write.
 */
export async function loadMemberProfile(supabase, workspaceId, internalUserId) {
  try {
    const [{ data: member }, { data: user }, { data: workspace }] = await Promise.all([
      supabase.from('workspace_members')
        // agent_instructions / agent_rules / agent_name are no longer read — see the note in
        // buildMemberBlock. agent_prefs stays for `memory_enabled`, a consent switch.
        .select('job_role, job_roles, agent_prefs')
        .eq('workspace_id', workspaceId).eq('user_id', internalUserId).maybeSingle(),
      supabase.from('users').select('name').eq('id', internalUserId).maybeSingle(),
      supabase.from('workspaces').select('name').eq('id', workspaceId).maybeSingle(),
    ]);
    return {
      name:          user?.name ?? null,
      workspaceName: workspace?.name ?? null,
      // The founder sets ROLES (plural) on the Members page; job_role is the older single
      // field. Read both, newest first — a member whose role was set this year had it written
      // to job_roles, and reading only the legacy column left the agent thinking they had none.
      jobRole:       (Array.isArray(member?.job_roles) && member.job_roles[0]) || member?.job_role || null,
      jobRoles:      expandRoles(Array.isArray(member?.job_roles) && member.job_roles.length ? member.job_roles : (member?.job_role ? [member.job_role] : [])),
      prefs:         member?.agent_prefs ?? null,
    };
  } catch {
    return null;
  }
}
