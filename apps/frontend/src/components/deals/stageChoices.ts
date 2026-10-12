// The stage choices a person can set by hand, in the refined groups a rep actually uses (Lead /
// Qualification / Negotiation & Follow-ups) plus the two terminals. The stored pipeline_stage stays
// granular: each choice writes a canonical stage, and every granular stage folds back to its group
// on read. Used on the deal page of an account's own deal; CRM deals take their stage from the CRM.
import { salesGroupOf, SALES_GROUP_COLOR } from "@/config/lifecycle";

export const STAGE_CHOICES: { key: string; label: string; write: string; color: string }[] = [
  { key: "lead",          label: "Lead",                     write: "identified",  color: SALES_GROUP_COLOR.lead },
  { key: "qualification", label: "Qualification",            write: "discovery",   color: SALES_GROUP_COLOR.qualification },
  { key: "negotiation",   label: "Negotiation & Follow-ups", write: "negotiation", color: SALES_GROUP_COLOR.negotiation },
  { key: "closed_won",    label: "Closed Won",               write: "closed_won",  color: "#059669" },
  { key: "closed_lost",   label: "Closed Lost",              write: "closed_lost", color: "#dc2626" },
];

export const stageChoiceKey = (granular: string | null | undefined): string => {
  const g = String(granular ?? "");
  if (g === "closed_won") return "closed_won";
  if (["closed_lost", "disqualified", "churned"].includes(g)) return "closed_lost";
  return salesGroupOf(g) ?? "lead";
};
