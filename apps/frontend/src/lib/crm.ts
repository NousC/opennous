// The connected CRM's name, everywhere the app mentions it (GET-602, interface refresh).
//
// "Open in HubSpot", "Deals mirror HubSpot", "HubSpot health" were written for the first CRM we
// supported. A workspace on Salesforce or Attio should read its own CRM's name, and one with no CRM
// connected reads "your CRM". `useCrm()` (hooks/useCrm.ts) learns the provider from the onboarding
// checklist; `crmName()` returns the last known label for strings built outside React.
export type CrmProvider = "hubspot" | "salesforce" | "attio";

export const CRM_LABEL: Record<CrmProvider, string> = { hubspot: "HubSpot", salesforce: "Salesforce", attio: "Attio" };
/** Brand colour for the small CRM mark next to a CRM link. */
export const CRM_COLOR: Record<CrmProvider, string> = { hubspot: "#FF7A59", salesforce: "#1798C1", attio: "#1A1A18" };

export function isCrmProvider(p: unknown): p is CrmProvider {
  return p === "hubspot" || p === "salesforce" || p === "attio";
}

export function crmLabel(provider: string | null | undefined): string {
  return isCrmProvider(provider) ? CRM_LABEL[provider] : "your CRM";
}

let last = "your CRM";
/** The connected CRM's label as last read by useCrm; "your CRM" until then. */
export function crmName(): string {
  return last;
}
export function rememberCrm(label: string) {
  last = label;
}
