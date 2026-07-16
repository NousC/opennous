// Onboarding drip — dogfood follow-up sequence driven entirely by our own
// observation substrate. The product decides who gets the next email, from what
// it already knows about them.
//
// State is NOT stored in a separate table. Every signal already lives as an
// observation on the person in our own workspace:
//   interaction.welcome_email_sent     — the anchor (≈ signup), fired by onboarding
//   interaction.onboarding_drip_sent    — each nudge we send (value.step)
//   interaction.email_received/_replied — a reply → the natural exit signal
//   interaction.subscription_started    — converted → stop nudging
// The current step is just max(step) over the drip observations.
//
// Idempotency: each send is recorded with external_id `drip_<entityId>_<step>`.
// observations has a UNIQUE(workspace_id, source, external_id) index, so we
// reserve the step via an ON CONFLICT DO NOTHING insert FIRST and only send the
// email if that insert was new. A double tick can't double-email; a send that
// fails after reserving just means the founder's early user misses one nudge
// (logged loudly) — strictly better than spamming them.
//
// Cloud-only: gated on NOUS_DOGFOOD_WORKSPACE_ID (the workspace our signups land
// in). Unset → no-op, so self-hosters and other workspaces never run this.

import crypto from 'node:crypto';
import { getSupabaseClient, sendEmail } from '@nous/core';
import { DRIP } from './dripTemplates.mjs';

// First-year offer shown in the drip. This worker is cloud-only (it no-ops
// unless NOUS_DOGFOOD_WORKSPACE_ID is set), and every value is operator-driven
// via env, so no coupon id or pricing is baked into the open-source tree. The
// coupon id MUST match a real coupon in your Stripe account.
const OFFER = {
  couponId: process.env.STRIPE_PRO_ANNUAL_COUPON_ID || '',
  discountLabel: process.env.DRIP_OFFER_DISCOUNT_LABEL || '',
  firstYearPrice: process.env.DRIP_OFFER_FIRST_YEAR_PRICE || '',
  basePrice: process.env.DRIP_OFFER_BASE_PRICE || '',
  expiryDays: Number(process.env.DRIP_OFFER_EXPIRY_DAYS) || 3,
};

const WINDOW_DAYS = 21;      // only consider recent signups; older ones are past the sequence
const HOUR_MS = 3_600_000;

const REPLY_PROPS = ['interaction.email_received', 'interaction.email_replied'];
const RELEVANT_PROPS = [
  'interaction.welcome_email_sent',
  'interaction.onboarding_drip_sent',
  ...REPLY_PROPS,
  'interaction.subscription_started',
  'interaction.unsubscribed',
];

// Pure decision: given a person's relevant observations and the current time,
// which drip step (if any) is due to send? Exported for testing — no DB, no IO.
// Returns { send: false } or { send: true, step, subject }.
export function decideNextStep(obs, nowMs) {
  const welcomeAt = obs.find(o => o.property === 'interaction.welcome_email_sent')?.observed_at;
  if (!welcomeAt) return { send: false, reason: 'no_welcome' };
  const welcomeMs = new Date(welcomeAt).getTime();

  const replied = obs.some(o => REPLY_PROPS.includes(o.property) && new Date(o.observed_at).getTime() > welcomeMs);
  const converted = obs.some(o => o.property === 'interaction.subscription_started');
  const unsubscribed = obs.some(o => o.property === 'interaction.unsubscribed');
  if (replied) return { send: false, reason: 'replied' };
  if (converted) return { send: false, reason: 'converted' };
  if (unsubscribed) return { send: false, reason: 'unsubscribed' };

  const currentStep = obs
    .filter(o => o.property === 'interaction.onboarding_drip_sent')
    .reduce((max, o) => Math.max(max, Number(o.value?.step) || 0), 0);

  const tmpl = DRIP.find(d => d.step === currentStep + 1);
  if (!tmpl) return { send: false, reason: 'complete' };

  if (nowMs - welcomeMs < tmpl.delayHoursFromWelcome * HOUR_MS) return { send: false, reason: 'not_due' };

  return { send: true, step: tmpl.step, subject: tmpl.subject };
}

export async function runOnboardingDrip() {
  // Self-host never runs the founder drip sequence — it's our cloud lifecycle
  // marketing. (Already implied by NOUS_DOGFOOD_WORKSPACE_ID being unset, but
  // guard explicitly so it can never fire on a self-hoster's own users.)
  if (process.env.SELF_HOSTED === 'true') return;
  const workspaceId = process.env.NOUS_DOGFOOD_WORKSPACE_ID;
  if (!workspaceId) return;  // not configured — cloud-only feature

  const supabase = getSupabaseClient();
  const startedAt = Date.now();
  const windowISO = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  // Start-date guard: never act on signups whose welcome predates NOUS_DRIP_START_AT.
  // Set this to the moment the drip is enabled so existing signups aren't
  // retroactively blasted with the sequence (and a real discount code) — only
  // people who sign up from enable-time forward enter it. Falls back to the
  // 21-day window when unset.
  const startAt = process.env.NOUS_DRIP_START_AT;
  const sinceISO = startAt && startAt > windowISO ? startAt : windowISO;

  // Candidates: everyone who got a welcome email since the effective start.
  const { data: welcomeRows, error: wErr } = await supabase
    .from('observations')
    .select('entity_id')
    .eq('workspace_id', workspaceId)
    .eq('property', 'interaction.welcome_email_sent')
    .gte('observed_at', sinceISO);
  if (wErr) {
    if (wErr.code === '42P01' || wErr.code === 'PGRST205') return;  // table missing — skip
    console.error('[onboarding_drip] welcome scan failed:', wErr.message);
    return;
  }
  const entityIds = [...new Set((welcomeRows || []).map(r => r.entity_id))];
  if (entityIds.length === 0) return;

  let sent = 0;
  for (const entityId of entityIds) {
    try {
      if (await processEntity(supabase, workspaceId, entityId)) sent++;
    } catch (err) {
      console.error(`[onboarding_drip] entity ${entityId} error:`, err.message);
    }
  }

  console.log(`[onboarding_drip] scanned ${entityIds.length} · sent ${sent} · ${Date.now() - startedAt}ms`);
}

async function processEntity(supabase, workspaceId, entityId) {
  const { data: obs, error } = await supabase
    .from('observations')
    .select('property, value, observed_at')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .in('property', RELEVANT_PROPS)
    .order('observed_at', { ascending: true });
  if (error || !obs?.length) return false;

  const decision = decideNextStep(obs, Date.now());
  if (!decision.send) return false;
  const tmpl = DRIP.find(d => d.step === decision.step);

  // Need email + first name to send. Read the contacts view (v2-substrate-backed).
  const { data: contact } = await supabase
    .from('contacts')
    .select('email, first_name')
    .eq('workspace_id', workspaceId)
    .eq('id', entityId)
    .maybeSingle();
  if (!contact?.email) return false;
  const name = (contact.first_name || 'there').toString().trim() || 'there';

  // Steps that carry the one-time offer (2 & 3) only go out once we can mint a
  // real, per-user, expiring Stripe code. Until that's wired, hold them rather
  // than send an email with a dead link — strictly safer than a broken offer.
  let offer = null;
  if (tmpl.needsOffer) {
    offer = await mintOffer({ supabase, workspaceId, entityId, email: contact.email });
    if (!offer) {
      console.log(`[onboarding_drip] step ${tmpl.step} for ${entityId} held — offer not configured`);
      return false;
    }
  }

  // Reserve the step first (ON CONFLICT DO NOTHING). Empty result → already sent.
  const externalId = `drip_${entityId}_${tmpl.step}`;
  const { data: reserved, error: insErr } = await supabase
    .from('observations')
    .upsert(
      {
        workspace_id: workspaceId,
        entity_id: entityId,
        kind: 'event',
        property: 'interaction.onboarding_drip_sent',
        value: { step: tmpl.step },
        source: 'onboarding_drip',
        method: 'cron',
        external_id: externalId,
        observed_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,source,external_id', ignoreDuplicates: true },
    )
    .select('id');
  if (insErr) {
    console.error(`[onboarding_drip] reserve failed for ${entityId} step ${tmpl.step}:`, insErr.message);
    return false;
  }
  if (!reserved?.length) return false;  // another tick already reserved this step

  const { text, html } = tmpl.render({ name, ...(offer || {}) });
  const res = await sendEmail({ to: contact.email, subject: tmpl.subject, text, html, tag: 'ONBOARDING_DRIP' });
  if (!res.sent) {
    // Step is recorded but the send failed. We do NOT roll back (avoids a resend
    // loop that could double-email); this user just misses this nudge.
    console.error(`[onboarding_drip] send failed for ${contact.email} step ${tmpl.step} (reason=${res.reason}) — step recorded, will not retry`);
    return false;
  }
  console.log(`[onboarding_drip] step ${tmpl.step} → ${contact.email}`);
  return true;
}

// Mint the per-user, single-use, 3-day-expiry Pro-annual promo code and return
// the email context for it: { promoCode, checkoutUrl, firstYearPrice, basePrice,
// discountLabel }. Returns null when the offer isn't configured yet, which holds
// steps 2 & 3 (see needsOffer). One code per user is reused across steps 2 & 3 —
// keyed by an `interaction.onboarding_offer_minted` observation so step 3 sends
// the SAME code with its real remaining expiry.
//
// One code per user, reused across steps 2 & 3 (so step 3's "expires today"
// counts down the SAME code). Recorded as an interaction.onboarding_offer_minted
// observation keyed by external_id offer_<entityId> — that's the idempotency
// anchor: present → reuse, absent → mint.
async function mintOffer({ supabase, workspaceId, entityId, email }) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;  // not configured → hold offer steps
  const appBase = (process.env.APP_URL || process.env.VITE_APP_URL || 'https://app.opennous.cloud').replace(/\/$/, '');

  const display = {
    discountLabel: OFFER.discountLabel,
    firstYearPrice: OFFER.firstYearPrice,
    basePrice: OFFER.basePrice,
  };

  // Reuse an already-minted code if we have one.
  const { data: existing } = await supabase
    .from('observations')
    .select('value')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('property', 'interaction.onboarding_offer_minted')
    .limit(1)
    .maybeSingle();
  if (existing?.value?.code && existing?.value?.checkout_url) {
    return { promoCode: existing.value.code, checkoutUrl: existing.value.checkout_url, ...display };
  }

  // Mint a fresh single-use, 3-day promotion code off the coupon.
  const code = `NOUS-PRO-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const expiresAt = Math.floor(Date.now() / 1000) + OFFER.expiryDays * 86_400;
  const form = new URLSearchParams({
    coupon: OFFER.couponId,
    code,
    max_redemptions: '1',
    expires_at: String(expiresAt),
    'metadata[entity_id]': entityId,
    'metadata[offer]': 'onboarding_pro_annual_y1',
  });

  let promoId;
  try {
    const res = await fetch('https://api.stripe.com/v1/promotion_codes', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[onboarding_drip] promo code create failed for ${email}: ${res.status} ${errText}`);
      return null;
    }
    promoId = (await res.json())?.id;
  } catch (err) {
    console.error(`[onboarding_drip] promo code exception for ${email}:`, err.message);
    return null;
  }

  const checkoutUrl = `${appBase}/settings?section=billing&plan=pro&interval=year&code=${encodeURIComponent(code)}`;

  // Record so it's reused next step and visible on the timeline. Best-effort:
  // if this insert fails the code still works, we just might mint a new one later.
  await supabase
    .from('observations')
    .upsert(
      {
        workspace_id: workspaceId,
        entity_id: entityId,
        kind: 'event',
        property: 'interaction.onboarding_offer_minted',
        value: { code, promotion_code_id: promoId, checkout_url: checkoutUrl, expires_at: expiresAt },
        source: 'onboarding_drip',
        method: 'cron',
        external_id: `offer_${entityId}`,
        observed_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,source,external_id', ignoreDuplicates: true },
    );

  console.log(`[onboarding_drip] minted ${code} for ${email}`);
  return { promoCode: code, checkoutUrl, ...display };
}
