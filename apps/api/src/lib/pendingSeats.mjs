// The seat someone was promised on a sales call.
//
// A normal signup lands on a core plan — the plugin experience, Home is an Install page,
// there is no in-app agent. That is right for someone who found the product themselves and
// wrong for a team that was just sold the Custom plan: they arrive to a CLI they were never
// pitched, and someone fixes it by hand while they watch their first impression form.
//
// So the sale is written down first, against an email. This applies it the moment that person
// signs in, before they see anything.

import { getSupabaseClient, companyDomainFromEmail, companyNameFromDomain, adoptCrmOwnership } from '@nous/core';
import { canClaimByEmailMatch } from './authProvider/index.mjs';

/**
 * Claim the pending seat for this email, if there is one. Idempotent and best-effort: a
 * failure here must never block a sign-in, because a person who cannot get in is a worse
 * outcome than a person on the wrong plan for ten minutes.
 *
 * A seat is matched by email alone (no token), and it can carry a plan and a seat in
 * someone else's workspace, so the email must be proven: always on Clerk (Cloud
 * unchanged), and on Supabase only when confirmed by a real email round-trip, never
 * under autoconfirm (see canClaimByEmailMatch). `authUserId` is the auth provider's id
 * for that check; `canClaim` is injectable for tests.
 *
 * Returns what it applied, or null.
 */
export async function claimPendingSeat(supabase, { email, userId, teamId, workspaceId, authUserId }, { canClaim = canClaimByEmailMatch } = {}) {
  if (!email || !userId) return null;
  try {
    const { data: seat } = await supabase
      .from('pending_seats')
      .select('id, plan_id, member_role, job_roles, workspace_id, expires_at, person_name, company_name, company_site')
      .ilike('email', email.trim())
      .is('claimed_at', null)
      .maybeSingle();
    if (!seat) return null;
    if (seat.expires_at && new Date(seat.expires_at).getTime() < Date.now()) return null;
    if (!(await canClaim(authUserId, email))) {
      console.warn(`[PENDING_SEAT] not claimed for ${email}: the address is not proven (Supabase autoconfirm or unconfirmed)`);
      return null;
    }

    const applied = {};

    // The plan. Written on the TEAM's subscription, which is what every gate reads.
    if (seat.plan_id && teamId) {
      const { data: existing } = await supabase
        .from('subscriptions').select('id').eq('team_id', teamId).maybeSingle();
      if (existing?.id) {
        await supabase.from('subscriptions').update({ plan_id: seat.plan_id, status: 'active' }).eq('id', existing.id);
      } else {
        await supabase.from('subscriptions').insert({ team_id: teamId, plan_id: seat.plan_id, status: 'active' });
      }
      applied.plan_id = seat.plan_id;
    }

    // The seat itself. `workspace_id` on the promise means they were invited into an EXISTING
    // customer's workspace — a second seat — rather than starting their own.
    const targetWs = seat.workspace_id ?? workspaceId;
    if (targetWs) {
      const { data: member } = await supabase
        .from('workspace_members').select('id').eq('workspace_id', targetWs).eq('user_id', userId).maybeSingle();
      const patch = { role: seat.member_role, job_roles: seat.job_roles, job_role: seat.job_roles?.[0] ?? null };
      if (member?.id) await supabase.from('workspace_members').update(patch).eq('id', member.id);
      else await supabase.from('workspace_members').insert({ workspace_id: targetWs, user_id: userId, ...patch });
      // Their book becomes theirs: imported CRM records carry the owner's EMAIL and no user id
      // until that person exists (GET-284). Fire-and-forget — never fail a seat claim on it.
      adoptCrmOwnership(supabase, targetWs, userId)
        .then(r => r.activities || r.accounts ? console.log(`[SEAT] adopted ${r.activities} conversations, ${r.accounts} accounts for ${userId}`) : null)
        .catch(e => console.warn('[SEAT] adopt failed:', e?.message || e));
      applied.workspace_id = targetWs;
      applied.member_role = seat.member_role;
      applied.job_roles = seat.job_roles;
    }

    // What the sales call already knew. Filling these now is what lets the agent's FIRST
    // message say "you're the admin for Acme" instead of asking for a company name somebody
    // wrote down last week. Never overwrite something they have already set themselves.
    if (seat.person_name) {
      await supabase.from('users').update({ name: seat.person_name }).eq('id', userId).is('name', null)
        .then(() => {}, () => {});
    }
    if ((seat.company_name || seat.company_site) && targetWs) {
      const { data: ws } = await supabase
        .from('workspaces').select('name, website').eq('id', targetWs).maybeSingle();
      const patch = {};
      // Sign-up names a fresh workspace before this runs — `name || 'My Workspace'` in
      // ensureUserAndTeam — so "not set" never meant null, and the company name never landed.
      // That automatic name counts as unset. Only on their OWN workspace: a second seat joining
      // an existing customer (`seat.workspace_id`) keeps whatever that workspace is called.
      let autoNamed = !ws?.name;
      if (!autoNamed && !seat.workspace_id) {
        const { data: u } = await supabase.from('users').select('name').eq('id', userId).maybeSingle();
        autoNamed = ws.name === 'My Workspace' || (!!u?.name && ws.name === u.name);
      }
      if (seat.company_name && autoNamed) patch.name = seat.company_name;
      if (seat.company_site && !ws?.website) {
        patch.website = String(seat.company_site).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
      }
      if (Object.keys(patch).length) {
        await supabase.from('workspaces').update(patch).eq('id', targetWs).then(() => {}, () => {});
        applied.workspace = patch;
      }
    }

    await supabase.from('pending_seats')
      .update({ claimed_at: new Date().toISOString(), claimed_by: userId })
      .eq('id', seat.id);

    console.log(`[PENDING_SEAT] claimed ${email} → ${JSON.stringify(applied)}`);
    return applied;
  } catch (e) {
    // Never block a sign-in over this.
    console.error('[PENDING_SEAT] claim failed:', e?.message || e);
    return null;
  }
}

/** Write down a seat sold on a call. Upserts, so a second call corrects the first. */
export async function promiseSeat({
  email, planId = 'custom', memberRole = 'owner', jobRoles = ['ambassador'],
  workspaceId = null, note = null, createdBy = null, expiresAt = null,
  personName = null, companyName = null, companySite = null,
  supabase = getSupabaseClient(),
}) {
  const addr = String(email ?? '').trim().toLowerCase();
  if (!addr.includes('@')) return { error: 'invalid_email' };

  // A work address already says where they work: rowan@harborline.example → harborline.example, "Harborline".
  // Only a fallback — what the operator typed wins — and never for a personal mailbox, whose
  // domain is the mail provider, not the employer.
  companySite = companySite || companyDomainFromEmail(addr);
  companyName = companyName || companyNameFromDomain(companySite);

  // Replace any unclaimed promise for this address rather than stacking a second one behind
  // it — the newest conversation is the true one.
  await supabase.from('pending_seats').delete().ilike('email', addr).is('claimed_at', null);

  const { data, error } = await supabase.from('pending_seats').insert({
    email: addr, plan_id: planId, member_role: memberRole, job_roles: jobRoles,
    workspace_id: workspaceId, note, created_by: createdBy, expires_at: expiresAt,
    person_name: personName, company_name: companyName, company_site: companySite,
  }).select('id').single();
  if (error) return { error: 'insert_failed', detail: error.message };
  return { id: data.id, email: addr, plan_id: planId, job_roles: jobRoles };
}
