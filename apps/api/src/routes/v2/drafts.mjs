import { pickRecipientEmail } from '../../lib/recipientEmail.mjs';
import { Router } from 'express';
import { getSupabaseClient, resolveFocus, getAccountRecord, mirrorDraftAsDecision, readContextFromReq } from '@nous/core';

export const draftsV2Router = Router();

// POST /v2/drafts/email — draft an email for the operator to review and SEND themselves.
// The app's rule is "you draft, they send": this writes a pending_actions row (kind='email')
// that shows up as a card with To / Subject / Body and a Send button; it goes out from the
// operator's own Gmail only when they click send. The agent never sends. Same surface the
// in-app agent's propose_email uses.
// Body: { focus, subject, body, to?, rationale? }
//   focus     — the recipient (email / LinkedIn URL / entity UUID / name)
//   subject   — the email subject
//   body      — the email body, written in the operator's voice, no placeholders
//   to?       — override the recipient address (else the entity's best email is used)
//   rationale?— one line on what the draft is based on (shown to the operator)
draftsV2Router.post('/email', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { focus, subject, body, to, rationale } = req.body || {};
    if (!focus || !String(focus).trim()) return res.status(400).json({ error: 'focus_required' });
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body_required' });

    const r = await resolveFocus(supabase, workspaceId, String(focus));
    if (r.status === 'not_found') return res.status(404).json({ error: 'entity_not_found', focus });
    if (r.status === 'ambiguous') return res.json({ status: 'ambiguous', candidates: r.candidates });

    const acc = await getAccountRecord(supabase, workspaceId, r.entity_id, readContextFromReq(req));
    const claims = acc?.claims ?? {};
    const recipient =
      claims.name?.value
      ?? ([claims.first_name?.value, claims.last_name?.value].filter(Boolean).join(' ') || String(focus));

    // Recipient address: an explicit `to`, else an active email — the one they last wrote from (GET-255).
    let toEmail = typeof to === 'string' && to.includes('@') ? to.trim() : null;
    if (!toEmail) toEmail = await pickRecipientEmail(supabase, workspaceId, r.entity_id);
    if (!toEmail) {
      return res.status(422).json({
        error: 'no_email',
        recipient,
        detail: `No email on file for ${recipient}. Pass \`to\`, or draft a LinkedIn message instead.`,
      });
    }

    // Attribute the draft to the member the key acts as, so it lands in their review
    // surface. A workspace/admin key (no owner) files it to the workspace's primary member.
    let userId = req.memberUserId ?? null;
    if (!userId) {
      const { data: m } = await supabase
        .from('workspace_members').select('user_id').eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true }).limit(1).maybeSingle();
      userId = m?.user_id ?? null;
    }

    const { data, error } = await supabase.from('pending_actions').insert({
      workspace_id:    workspaceId,
      user_id:         userId,
      kind:            'email',
      entity_id:       r.entity_id,
      recipient,
      recipient_email: toEmail,
      subject:         (subject && String(subject).trim()) || '(no subject)',
      body:            String(body).trim(),
      rationale:       rationale ? String(rationale) : null,
    }).select('*').single();
    if (error) return res.status(500).json({ error: 'could_not_save_draft', detail: error.message });
    // The agent-facing draft route. Same mirror as the chat tools and the worklist — five
    // creation paths, one place that records them, so instrumenting a new surface is not
    // something a future change can quietly forget.
    await mirrorDraftAsDecision(supabase, workspaceId, data, {
      actionType: 'email_send', category: 'outreach', surface: 'agent', agent: 'api',
    });

    return res.json({
      status: 'awaiting_approval',
      action_id: data.id,
      kind: 'email',
      recipient,
      to: toEmail,
    });
  } catch (err) {
    console.error('[POST /v2/drafts/email]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
