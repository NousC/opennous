// The Intel tab's colours (GET-799): one per group, used by the lens pills, the type tags, the
// Story's lanes and the qualification tags on the left pane, so a group reads the same everywhere.
// Distinct in lightness as well as hue, so the lanes stay apart for colour-blind readers.

export const GROUP_COLOR: Record<string, string> = {
  blockers: "#A9472A",
  risks: "#B0412E",
  buying: "#2E7A4C",
  objections: "#B4720F",
  decision: "#4A5BAE",
  stakeholders: "#7449AC",
  stack: "#56636F",
  competitors: "#857F72",
  other: "#A9A8A2",
};

/** The Story's lanes (core/db/intelTimeline.ts) in the Intel tab's colours. */
const LANE_GROUP: Record<string, string> = {
  buying: "buying", blockers: "blockers", objections: "objections", timeline: "decision",
  stakeholders: "stakeholders", tech: "stack", risks: "risks",
};
export const laneColor = (lane: string): string => GROUP_COLOR[LANE_GROUP[lane] ?? "other"] ?? GROUP_COLOR.other;

/** A tint of a group colour for a tag's fill: the hex with an alpha byte. */
export const tint = (hex: string, alpha = "14") => `${hex}${alpha}`;

// ── Colour by meaning (GET-805) ──────────────────────────────────────────────
// Red works against the deal, amber is their problem or a rival, green moves toward a yes, blue
// is what they want and when, violet is who, slate is how they work today. The Intel tab's
// Current state and board, and the left pane's qualification tags, all read these.

export const MEANING = {
  red: "#B0412E", amber: "#B4720F", green: "#2E7A4C", blue: "#3F63B5", violet: "#7449AC", slate: "#5D6B78",
} as const;

export type IntelColumn = "headwinds" | "tailwinds" | "context";
export type IntelCat = { key: string; label: string; one: string; color: string; column: IntelColumn };

/** The categories a rep reads, in reading order within their column. */
export const INTEL_CATS: IntelCat[] = [
  { key: "blockers", label: "Blockers", one: "Blocker", color: MEANING.red, column: "headwinds" },
  { key: "objections", label: "Objections", one: "Objection", color: MEANING.red, column: "headwinds" },
  { key: "risks", label: "Risks", one: "Risk", color: MEANING.red, column: "headwinds" },
  { key: "competitors", label: "Competitors", one: "Competitor", color: MEANING.amber, column: "headwinds" },
  { key: "pains", label: "Pains", one: "Pain", color: MEANING.amber, column: "headwinds" },
  { key: "buying", label: "Buying signals", one: "Buying signal", color: MEANING.green, column: "tailwinds" },
  { key: "budget", label: "Budget", one: "Budget", color: MEANING.green, column: "tailwinds" },
  { key: "timeline", label: "Timeline", one: "Timeline", color: MEANING.blue, column: "tailwinds" },
  { key: "goals", label: "Goals", one: "Goal", color: MEANING.blue, column: "tailwinds" },
  { key: "people", label: "Stakeholders", one: "Stakeholders", color: MEANING.violet, column: "tailwinds" },
  { key: "stack", label: "Tech stack", one: "Tech stack", color: MEANING.slate, column: "context" },
  { key: "statusquo", label: "Status quo", one: "Status quo", color: MEANING.slate, column: "context" },
  { key: "adoption", label: "Adoption", one: "Adoption", color: MEANING.slate, column: "context" },
  { key: "profile", label: "Company", one: "Company", color: MEANING.slate, column: "context" },
  { key: "preferences", label: "Preferences", one: "Preference", color: MEANING.slate, column: "context" },
  { key: "notes", label: "Notes", one: "Note", color: MEANING.slate, column: "context" },
];

/** A fact's category (the extractor's word) → the Intel category it is read under. */
const CATEGORY_TO_INTEL: Record<string, string> = {
  blocker: "blockers", objection: "objections", risk_signal: "risks", staff_change: "risks", "declined expansion": "risks",
  competitor: "competitors", pain: "pains", performance: "pains",
  buying_signal: "buying", expansion_signal: "buying", budget: "budget", timeline: "timeline",
  goal: "goals", requirement: "goals", authority: "people", relationship: "people",
  tech_stack: "stack", status_quo: "statusquo", adoption: "adoption", proficiency: "adoption",
  firmographic: "profile", seasonality: "profile", preference: "preferences",
};
export const intelCatOf = (category: string | null | undefined): string =>
  CATEGORY_TO_INTEL[String(category ?? "").toLowerCase()] ?? "notes";
export const INTEL_CAT = Object.fromEntries(INTEL_CATS.map(c => [c.key, c])) as Record<string, IntelCat>;
