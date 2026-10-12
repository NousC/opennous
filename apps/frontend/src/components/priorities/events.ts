// Decisions made in the Priorities inbox (GET-678), announced so Home, if it is open underneath,
// takes them too: Home keeps its own read of /api/home, not the inbox's query.

/** detail: { id: string; followup: FollowUp } — a follow-up approved, synced or skipped. */
export const FOLLOW_UP_DECIDED = "nous:follow-up-decided";
/** detail: { id: string } — an older recommendation dismissed. */
export const REC_DISMISSED = "nous:recommendation-dismissed";
/** detail: { id: string; status: "sent" | "rejected" } — a waiting draft approved and sent, or skipped (GET-681). */
export const ACTION_DECIDED = "nous:action-decided";
