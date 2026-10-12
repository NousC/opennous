// The shapes Home reads from GET /api/home. Every field the Phase 2 contract adds is optional here,
// because older servers and the preview fixtures do not send them yet and the page must still draw.

import type { BookScope } from "@/hooks/useBookScope";

export type Scope = BookScope;

export type Meeting = {
  when: string; title: string | null; entity_id: string | null; name: string | null; company: string | null;
  attendees: { name: string | null; company: string | null; entity_id?: string | null }[];
  /** One line on what the meeting is for. Not sent yet (Phase 3, the meeting-purpose field). */
  purpose?: string | null;
};

export type Metrics = {
  deals_won_this_week: number; deals_won_last_week?: number; open_deals: number; open_deals_with_amount?: number;
  meetings_today: number; accounts_need_attention: number;
  follow_ups_ready?: number | null;
  /** Open deals quiet for 9+ days, or with a Nous health under 50. */
  deals_at_risk?: { count: number; value: number } | null;
};

export type WeekKey = "new" | "moved_up" | "won" | "slipped" | "lost";
/** One deal behind a "Pipeline this week" bar. `from`/`to` are stage labels for moved_up, won and
 *  lost, close dates (YYYY-MM-DD) for slipped, and null for new. */
export type WeekDeal = {
  id: string; company_id: string | null; name: string | null; account: string | null;
  value: number | null; from: string | null; to: string | null;
};
/** How the deals moved since Monday, from the CRM's own stage history (packages/core pipelineWeek). */
export type PipelineWeek = Record<WeekKey, number> & {
  has_history: boolean;
  value?: Partial<Record<WeekKey, number | null>> | null;
  deals?: Partial<Record<WeekKey, WeekDeal[]>> | null;
};
export type Pipeline = { open_value: number; won_value: number; open_count?: number | null; week: PipelineWeek | null };

export type DealChange = {
  deal_id: string; deal: string | null; account_id: string | null; account: string | null; domain?: string | null;
  stage: string | null; close_date: string; reason: string;
  hubspot_url?: string | null;
  /** The deal's amount. */
  value?: number | null;
};

/** A field Nous proposes to write to the CRM, with the words it came from. Sent once the HubSpot
 *  write-back ships; the preview fixtures already carry a few. */
export type CrmProposal = { object: string; field: string; value: string; quote?: string | null; speaker?: string | null; at?: string | null };

// ── The follow-up engine (Phase 3) ──────────────────────────────────────────
// A card the engine built from one meeting, or several merged into one card. Home receives it as
// `rec.followup` on a recommendation whose id starts "fu:"; GET /api/follow-ups sends the same card
// as a FollowUpRow. A card is decided through /api/follow-ups (approve, skip, which deal).
export type FollowUpStatus = "ready" | "approved" | "synced" | "skipped" | "merged";
/** One meeting folded into a card, oldest first. A merged card has two or more. */
export type FollowUpMeeting = {
  key?: string; source?: string | null; kind?: string | null; title?: string | null; at?: string | null;
  observation_id?: string | null;
};
export type FollowUpTask = {
  id: string; text: string; due?: string | null; due_phrase?: string | null;
  /** Proposed ticked. */
  on?: boolean;
  quote?: string | null; stated_by?: "us" | "them" | null; owed_by?: string | null;
  /** Already a real task (the call scorer filed it): shown, never filed again. */
  existing?: boolean;
  /** On a merged card: an earlier meeting's task the later call made moot, with why. Restorable. */
  dropped?: string | null;
};
export type FollowUpUpdate = { id: string; label: string; value: string; on?: boolean; quote?: string | null; speaker?: string | null };
export type FollowUpEmail = { to: string | string[]; subject: string; body: string };
export type DealOption = { id: string; name: string; value?: number | null; stage?: string | null };
/** The call touched more than one open deal and the engine is asking which one it belongs to.
 *  `chosen` is a deal id, "both" or "neither" once answered. */
export type FollowUpAttribution = { question?: string | null; options: DealOption[]; chosen?: string | null };
/** What HubSpot says right now. Read only. */
export type FollowUpCrm = {
  deal?: string | null; stage?: string | null; amount?: number | null; close_date?: string | null;
  last_logged?: string | null; url?: string | null;
};
/** What reached HubSpot and Gmail (Phase 4 write-back), kept on the card as each item lands. */
export type FollowUpSync = {
  /** Card task id → HubSpot task id. */
  tasks?: Record<string, string>;
  /** The one HubSpot note the approved updates became. */
  note?: string | null;
  draft?: { url?: string | null; mailbox?: string | null } | null;
  synced_at?: string | null;
};
/** What an approval recorded: the counts the receipt reads. */
export type FollowUpVerdict = {
  tasks_ticked?: number; tasks_edited?: number; updates_ticked?: number; email_edited?: boolean;
  sync?: FollowUpSync | null;
};
export type FollowUp = {
  /** The follow_ups row id, without Home's "fu:" prefix. */
  follow_up_id?: string;
  status: FollowUpStatus;
  tasks: FollowUpTask[];
  updates: FollowUpUpdate[];
  email: FollowUpEmail | null;
  /** Sent from the card with Approve & send (GET-742). */
  email_sent?: { at: string; mailbox: string | null; subject?: string | null } | null;
  attribution: FollowUpAttribution | null;
  /** The latest meeting. */
  meeting?: { kind?: string | null; at?: string | null; title?: string | null } | null;
  meetings?: FollowUpMeeting[];
  summary?: string | null;
  crm?: FollowUpCrm | null;
  /** A stage or date that should move in HubSpot. Shown as a flag, never done by Nous. */
  deal_change?: { reason: string; url?: string | null } | null;
  verdict?: FollowUpVerdict | null;
  /** The workspace syncs approved follow-ups to HubSpot: the button reads "Sync to HubSpot". */
  writeback?: boolean;
};

/** One card from GET /api/follow-ups (and every POST's `follow_up`): the content at the top level. */
export type FollowUpRow = {
  id: string; status: FollowUpStatus;
  account: { id: string | null; name: string | null; domain: string | null };
  deal_id: string | null; reviewer_name: string | null;
  meetings: FollowUpMeeting[];
  summary: string | null; tasks: FollowUpTask[]; updates: FollowUpUpdate[];
  email: FollowUpEmail | null; attribution: FollowUpAttribution | null;
  deal_change: { reason: string; deal_id?: string | null; url?: string | null } | null;
  insights?: { category: string; text: string; quote?: string | null }[];
  crm?: FollowUpCrm | null;
  created_at: string; updated_at: string; decided_at?: string | null;
  verdict?: FollowUpVerdict | null;
  hubspot_url: string | null;
  writeback?: boolean;
};

/** One item POST /api/follow-ups/:id/sync could not write. `id` is the card task's, null for the note. */
export type SyncFailure = { kind: "task" | "note"; id: string | null; error: string; message: string; status?: number | null };
/** The Gmail draft a sync made, or why there is none. */
export type SyncDraft = { status: "created"; url: string | null; mailbox: string | null } | { status: "no_gmail" } | { status: "failed"; error: string; message: string | null };
/** POST /api/follow-ups/:id/sync. `error` is "crm_write_not_allowed" when HubSpot refused the write. */
export type SyncResult = {
  follow_up: FollowUpRow; filed?: number; sync?: FollowUpSync | null; failed?: SyncFailure[];
  draft?: SyncDraft | null; complete?: boolean; error?: string; message?: string;
};

/** POST /api/follow-ups/:id/approve. `tasks` are the ticked ones, as edited; a restored dropped
 *  task says so, or the server leaves it out. */
export type ApproveBody = {
  tasks: { id: string; text: string; due: string | null; restored?: boolean }[];
  updates: string[];
  email: { subject: string; body: string; from?: string } | null;
};

export type Recommendation = {
  id: string; kind: string; title: string; why: string | null; when: string | null; entity_id: string;
  account: { id: string | null; name: string | null; domain: string | null }; person?: string | null;
  person_photo?: string | null; person_email?: string | null; due?: string | null; assignee: string | null; created_at: string;
  /** A handoff's brief. Set only on kind "handoff"; opening the row opens this page. */
  document_id?: string | null;
  hubspot?: CrmProposal[];
  followup?: FollowUp | null;
};

export type HomeData = {
  meetings: Meeting[]; metrics: Metrics; recommendations: Recommendation[];
  pipeline?: Pipeline; deal_changes?: DealChange[];
  scope?: Scope;
  /** "My book" was asked for but the viewer is not mapped to a CRM owner, so this is the whole team. */
  scope_unmapped?: boolean;
};

/** One open task, as the Tasks page reads it (GET /api/tasks). */
export type Task = {
  id: string; entity_id: string; title: string; account: string | null; company: string | null; company_id?: string | null;
  owner_name: string | null; due_phrase: string | null; due_at?: string | null; status?: string; completed_at?: string | null;
  assignee?: { name: string | null } | null;
};

/** The parts of GET /api/home/recommendations/:id a follow-up card reads for "In HubSpot now". */
export type RecDetail = {
  impact: { deal: string | null; value: number | string | null; stage: string | null; close_date: string | null } | null;
  sources: { kind: string; when: string; system: string | null; title: string | null }[];
};
