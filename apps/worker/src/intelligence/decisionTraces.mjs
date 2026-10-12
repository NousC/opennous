// Phase 2 of the decision trace: attribute the OUTCOME back to the decision.
//
// The action layer already stamps rec_id onto a sent observation (raw.rec_id). This
// resolver turns each rec-linked send into a ri_decision_traces row, then looks for the
// outcome that followed on that entity within a window — a reply or a booked/held
// meeting — and attributes it to the decision. That closes the loop per decision, and
// gives the learning layer (Phase 3: recommendation-effectiveness, speed-to-lead) a
// clean corpus of "we decided X → did Y → Z happened".
//
// Two kinds of decision reach this resolver. Ours: an ri_recommendations row the engine
// produced, stamped as raw.rec_id by our own send lanes. Theirs: a recommendation the
// user's own agent made inside a skill, written down as an ri_decisions row and stamped as
// raw.decision_id by the plugin. Both are graded here, identically — the learning layer
// should not care which surface gave the advice, only whether it worked.

// Their response after our send. email_received = they emailed us back; the reply/
// positive_reply variants come from reply classification. (linkedin_message is left out
// on purpose — it carries both directions on one property.)
const REPLY_PROPS = ['interaction.reply', 'interaction.email_reply', 'interaction.email_received', 'interaction.outbound_positive_reply'];
const MEETING_PROPS = ['interaction.meeting_scheduled', 'interaction.meeting_booked', 'interaction.meeting_held'];
const BOUNCE_PROPS = ['interaction.email_bounced'];
const SEND_PROPS = ['interaction.email_sent', 'interaction.linkedin_message_sent', 'interaction.linkedin_invite_sent'];
const REPLY_WINDOW_D = 14;
const MEETING_WINDOW_D = 30;
const BOUNCE_WINDOW_D = 7;    // a bounce lands fast; after a week it's not this send's failure
const DAY = 86_400_000;

// The outcome vocabulary. A trace resolves to exactly one, and the learning layer reads
// which are wins vs failures — the loop only learns from failure if failure is recorded,
// not left as a null "still waiting". Positive: meeting, replied. Negative: bounced,
// opted_out, objection, no_response.
//
// A reply is not automatically a win. Its disposition (raw.reply_signal, set by reply
// classification) decides: an unsubscribe is a FAILURE, not a "replied" conversion — the
// bug this fixes is that every reply, including opt-outs, used to count as a positive.
export function classifyReplyOutcome(replySignal) {
  switch (replySignal) {
    case 'unsubscribe':
    case 'do_not_contact': return 'opted_out';
    case 'negative':
    case 'objection':      return 'objection';
    // Not a human outcome — ignore it and keep the trace open (a real reply may still come,
    // or it matures to no_response). out_of_office / auto_reply are noise, not engagement.
    case 'out_of_office':
    case 'auto_reply':     return null;
    // positive / positive_reply / neutral / unclassified inbound reply = genuine engagement.
    default:               return 'replied';
  }
}

export async function resolveDecisionTraces(supabase, workspaceId) {
  // 1. Every rec-linked send becomes a trace row (idempotent on send_observation_id).
  // Two queries rather than one `.or()` over a json path: this pipeline predates the
  // decision loop and already worked, and a filter-syntax surprise here would take the
  // ENGINE'S OWN attribution down with the new column. Merged by observation id.
  const linkedSends = async (column) => {
    const { data, error } = await supabase.from('observations')
      .select('id, entity_id, property, observed_at, raw')
      .eq('workspace_id', workspaceId)
      .in('property', SEND_PROPS)
      .not(`raw->>${column}`, 'is', null)
      .order('observed_at', { ascending: false })
      .limit(3000);
    if (error) { console.error('[resolveDecisionTraces] send query failed:', column, error.message); return []; }
    return data ?? [];
  };
  const byId = new Map();
  for (const row of [...await linkedSends('rec_id'), ...await linkedSends('decision_id')]) {
    byId.set(row.id, row);
  }
  const sends = [...byId.values()];
  const now = new Date().toISOString();
  let created = 0;
  for (const s of sends ?? []) {
    if (!s.entity_id) continue;
    const { error } = await supabase.from('ri_decision_traces').upsert({
      workspace_id: workspaceId,
      rec_id: s.raw?.rec_id ?? null,
      decision_id: s.raw?.decision_id ?? null,
      entity_id: s.entity_id,
      send_observation_id: s.id,
      action_property: s.property,
      sent_at: s.observed_at,
      updated_at: now,
    }, { onConflict: 'workspace_id,send_observation_id', ignoreDuplicates: true });
    if (!error) created += 1;

    // The observation IS a confirmation: the send is on the record, so whatever the agent
    // claimed, this action demonstrably happened. Confirming here as well as from the hook
    // means an agent with no hook installed (Codex today, a future runtime) still closes
    // the loop — the hook only makes it faster and adds the provider's own message id.
    if (s.raw?.decision_id) {
      await supabase.from('ri_decisions').update({
        status: 'confirmed',
        confirmed_at: s.observed_at,
        confirmed_via: 'observation',
        send_observation_id: s.id,
        updated_at: now,
      }).eq('workspace_id', workspaceId).eq('decision_id', s.raw.decision_id).eq('status', 'proposed');
    }
  }

  // 2. Resolve the outcome for still-open traces — a meeting (stronger) or a reply
  //    on that entity after the send, inside the window.
  const { data: open } = await supabase.from('ri_decision_traces')
    .select('id, entity_id, sent_at')
    .eq('workspace_id', workspaceId).is('outcome', null)
    .limit(2000);
  const nowMs = Date.now();
  let resolved = 0;
  for (const t of open ?? []) {
    const sentMs = new Date(t.sent_at).getTime();
    const meetingBy = new Date(sentMs + MEETING_WINDOW_D * DAY).toISOString();
    const replyBy = new Date(sentMs + REPLY_WINDOW_D * DAY).toISOString();
    const bounceBy = new Date(sentMs + BOUNCE_WINDOW_D * DAY).toISOString();

    let outcome = null, obsId = null, at = null;

    // 1. Meeting — the strongest win. Beats everything, even a bounce (booked another way).
    const { data: mtg } = await supabase.from('observations')
      .select('id, observed_at')
      .eq('workspace_id', workspaceId).eq('entity_id', t.entity_id)
      .in('property', MEETING_PROPS).gt('observed_at', t.sent_at).lte('observed_at', meetingBy)
      .order('observed_at', { ascending: true }).limit(1).maybeSingle();
    if (mtg) { outcome = 'meeting'; obsId = mtg.id; at = mtg.observed_at; }

    // 2. Bounce — a delivery failure; this send never landed. A negative outcome.
    if (!outcome) {
      const { data: bnc } = await supabase.from('observations')
        .select('id, observed_at')
        .eq('workspace_id', workspaceId).eq('entity_id', t.entity_id)
        .in('property', BOUNCE_PROPS).gt('observed_at', t.sent_at).lte('observed_at', bounceBy)
        .order('observed_at', { ascending: true }).limit(1).maybeSingle();
      if (bnc) { outcome = 'bounced'; obsId = bnc.id; at = bnc.observed_at; }
    }

    // 3. Reply — but the disposition decides win vs failure. An unsubscribe is not a
    //    conversion; an objection is engagement but not a win; a positive reply is. We take
    //    the earliest reply that carries a real human disposition (skipping OOO/auto-reply).
    if (!outcome) {
      const { data: reps } = await supabase.from('observations')
        .select('id, observed_at, raw')
        .eq('workspace_id', workspaceId).eq('entity_id', t.entity_id)
        .in('property', REPLY_PROPS).gt('observed_at', t.sent_at).lte('observed_at', replyBy)
        .order('observed_at', { ascending: true }).limit(5);
      for (const rep of reps ?? []) {
        const o = classifyReplyOutcome(rep.raw?.reply_signal);
        if (o) { outcome = o; obsId = rep.id; at = rep.observed_at; break; }
      }
    }

    // 4. No response — matured (past the meeting window) with nothing back. A failure we
    //    can now learn from, instead of an open trace that silently reads as "not converted".
    if (!outcome && nowMs > sentMs + MEETING_WINDOW_D * DAY) {
      outcome = 'no_response';
    }

    if (outcome) {
      await supabase.from('ri_decision_traces')
        .update({ outcome, outcome_observation_id: obsId, outcome_at: at, updated_at: new Date().toISOString() })
        .eq('id', t.id);
      resolved += 1;
    }
  }

  return { traces: created, resolved };
}

// The intent-to-action gap. A recommendation the human ACCEPTED but that never produced an
// action is the most interesting negative in the dataset: either the agent claimed a send
// that never happened, or the person meant to and didn't. Left as 'proposed' forever it
// reads as "still pending" and quietly inflates our acceptance rate, so it matures here.
//
// The window is deliberately generous. A rep who approves a draft on Friday and sends it
// Monday has not broken a promise, and mislabelling that as a failure would teach the
// learning layer the wrong lesson.
const CONFIRM_WINDOW_D = 3;

// A proposal nobody ever answered. Longer than the confirm window because a draft sitting in
// front of someone is not a broken promise yet — people come back to them. Past this it is
// fair to call it what it is.
const ANSWER_WINDOW_D = 7;

export async function matureUnconfirmedDecisions(supabase, workspaceId) {
  const cutoff = new Date(Date.now() - CONFIRM_WINDOW_D * DAY).toISOString();
  const { data, error } = await supabase.from('ri_decisions')
    .update({ status: 'unconfirmed', updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('status', 'proposed')
    .in('verdict', ['accepted', 'edited'])
    .lt('verdict_at', cutoff)
    .select('id');
  if (error) { console.error('[matureUnconfirmedDecisions]', error.message); return { matured: 0 }; }
  return { matured: (data ?? []).length };
}

// The other way a decision goes nowhere, and the one the first pass missed: nobody ever
// answered it. A draft put in front of someone who neither sent nor discarded it has verdict
// 'pending', so the maturation above — which only looks at accepted and edited — left it
// 'proposed' forever. That is the state this system exists to make visible, sitting invisible.
//
// Kept apart from 'unconfirmed' on purpose. Advice agreed to and not done is a broken promise;
// advice never engaged with is a shrug. They say different things about what we are producing,
// and one number covering both would say neither.
export async function matureIgnoredDecisions(supabase, workspaceId) {
  const cutoff = new Date(Date.now() - ANSWER_WINDOW_D * DAY).toISOString();
  const { data, error } = await supabase.from('ri_decisions')
    .update({ status: 'ignored', updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('status', 'proposed')
    .eq('verdict', 'pending')
    .lt('created_at', cutoff)
    .select('id');
  if (error) { console.error('[matureIgnoredDecisions]', error.message); return { matured: 0 }; }
  return { matured: (data ?? []).length };
}
