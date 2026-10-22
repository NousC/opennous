import { isWorkspaceSetUp } from './onboardingState.mjs';
import { expandRoles } from './agentDirectives.mjs';

/**
 * Who is acting, and is this workspace set up.
 *
 * The identity primitive every skill opens with — the plugin's `whoami` tool reads it over
 * HTTP, the in-app agent calls it in process. One definition, because the two surfaces
 * answering "who am I" differently is how a skill scoped to "your own book" quietly reports
 * on somebody else's.
 *
 * scope      admin  = the whole workspace · member = own book + the shared graph
 * roles      the member's GTM role(s) — a person can hold several (AE + founder)
 * setup      what the agent needs to decide between onboarding and working
 */
export async function resolveWhoami(supabase, { workspaceId, memberUserId = null, scope = 'admin', capability = 'read_write' }) {
  const { data: ws } = await supabase
    .from('workspaces').select('id, name, team_id, onboarding_activated_at').eq('id', workspaceId).maybeSingle();

  // Name/email live on users; GTM roles live on workspace_members (per workspace + member).
  const resolvePerson = async (uid) => {
    if (!uid) return null;
    const [{ data: u }, { data: wm }] = await Promise.all([
      supabase.from('users').select('id, name, email').eq('id', uid).maybeSingle(),
      supabase.from('workspace_members').select('job_roles, job_role').eq('workspace_id', workspaceId).eq('user_id', uid).maybeSingle(),
    ]);
    // 'ambassador' is one role meaning every lens — see agentDirectives.expandRoles.
    const roles = expandRoles(Array.isArray(wm?.job_roles) && wm.job_roles.length ? wm.job_roles : (wm?.job_role ? [wm.job_role] : []));
    return { user_id: u?.id ?? uid, name: u?.name ?? null, email: u?.email ?? null, roles };
  };

  // A bound member key resolves to that member; an admin/workspace key (no bound member)
  // acts on behalf of the workspace's FOUNDER — so whoami shows a name + role either way.
  let personId = memberUserId;
  if (!personId && ws?.team_id) {
    const { data: fm } = await supabase.from('team_members')
      .select('user_id').eq('team_id', ws.team_id).eq('role', 'founder').maybeSingle();
    personId = fm?.user_id ?? null;
  }
  let you = { user_id: null, name: null, email: null, scope, roles: [], capability };
  if (personId) {
    const p = await resolvePerson(personId);
    if (p) you = { ...p, scope, capability };
  }

  // Setup state — so the agent's FIRST call orients itself: onboard vs work. `onboarded` is
  // the SHARED expression (lib/onboardingState.mjs), the same one the app's router gate reads.
  // It used to be a hand-rolled copy that claimed to mirror the app and quietly didn't.
  // `accounts`/`has_icp` let the agent say something specific. `accounts` is companies (the
  // active company entities, as the onboarding checklist counts them); `people` is contacts,
  // which is what the shared setup gate has always read (GET-1011: whoami used to call the
  // people count "accounts").
  let setup = { onboarded: false, accounts: 0, people: 0, has_icp: false };
  try {
    const [{ count: companies }, { count: contacts }, { data: icp }] = await Promise.all([
      supabase.from('entities').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).eq('type', 'company').eq('status', 'active'),
      supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
      supabase.from('foundations').select('kind').eq('workspace_id', workspaceId).eq('kind', 'icp').maybeSingle(),
    ]);
    const accounts = companies ?? 0;
    const people = contacts ?? 0;
    const has_icp = !!icp;
    setup = {
      onboarded: isWorkspaceSetUp({ activatedAt: ws?.onboarding_activated_at, hasIcp: has_icp, accounts: people }),
      accounts, people, has_icp,
    };
  } catch { /* non-fatal — leave the fresh-workspace defaults */ }

  return { workspace: { id: ws?.id ?? workspaceId, name: ws?.name ?? null }, you, setup };
}
