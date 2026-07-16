// /api/activity-stats — what's going on in the business.
//
// The Activities page used to lead with "total ops", "failed ops", "system /
// agent". Those describe the machine, not the work. Nobody opens this page asking
// how many HTTP calls succeeded; they open it asking whether anything is
// happening — are we talking to people, are they talking back, are meetings
// getting booked.
//
// So these numbers come from the graph (what actually happened with humans), not
// from the op log (what the software did). Deliberately nothing to do with Nous
// usage — that lives on Adoption.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const activityStatsRouter = Router();

const DAY = 86_400_000;
const PAGE = 1000;

// The interactions that are a real conversation with a human.
const OUTBOUND = /email_sent|linkedin_message_sent|message_sent|sequence|campaign/;
const INBOUND  = /replied|reply|received|inbound/;
const MEETING_HELD  = /meeting_held|call_held/;
const MEETING_BOOKED = /meeting_scheduled|meeting_booked/;

activityStatsRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const daysParam = req.query.days;
    const days = daysParam === 'all' ? null : Math.min(Math.max(parseInt(daysParam, 10) || 7, 1), 365);

    const supabase = getSupabaseClient();

    let q = supabase
      .from('observations')
      .select('entity_id, property, observed_at')
      .eq('workspace_id', workspaceId)
      .like('property', 'interaction.%');
    if (days != null) q = q.gte('observed_at', new Date(Date.now() - days * DAY).toISOString());

    // Page through — PostgREST caps a response at 1000 rows however big the limit,
    // and a silently truncated count is just a wrong number with confidence.
    const rows = [];
    for (let from = 0; from < 30_000; from += PAGE) {
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < PAGE) break;
    }

    const now = Date.now();
    let conversations = 0, replies = 0, meetingsHeld = 0, meetingsBooked = 0;
    const people = new Set();

    for (const r of rows) {
      const p = String(r.property);
      const isFuture = new Date(r.observed_at).getTime() > now;

      if (MEETING_HELD.test(p)) meetingsHeld++;
      else if (MEETING_BOOKED.test(p) && isFuture) meetingsBooked++;   // still to come

      if (INBOUND.test(p)) { replies++; conversations++; people.add(r.entity_id); }
      else if (OUTBOUND.test(p)) { conversations++; people.add(r.entity_id); }
      else if (MEETING_HELD.test(p)) people.add(r.entity_id);
    }

    return res.json({
      days: days ?? 'all',
      // Messages exchanged either way — the volume of actual contact.
      conversations,
      // The only number that means someone else engaged. Outbound is effort;
      // this is traction.
      replies,
      meetings_held: meetingsHeld,
      meetings_booked: meetingsBooked,
      // Distinct humans you actually interacted with.
      people_touched: people.size,
      // Reply rate is the health metric a GTM operator lives on.
      reply_rate: conversations ? Math.round((replies / conversations) * 1000) / 10 : 0,
    });
  } catch (err) {
    console.error('[GET /api/activity-stats]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
