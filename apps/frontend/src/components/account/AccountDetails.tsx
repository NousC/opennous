// The account's own fields, click to edit, as the "Company details" section of the record's left
// pane (GET-608). They were a card on the Overview; the record's properties live in the left
// pane now, and editing them came along.
import { useState } from "react";
import { when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PaneSection, Pill, PropRow } from "@/components/record/RecordLayout";

/** A pasted URL or messy domain → the bare host the favicon service wants. */
export function normalizeDomain(s: string): string {
  return s.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "").toLowerCase();
}

/**
 * A property row whose value becomes an input on click, saved on Enter/blur (Esc cancels).
 * `normalize` cleans the input before saving, e.g. a pasted URL → a bare domain so the logo
 * resolves.
 */
export function EditableProp({ label, value, placeholder, onSave, normalize }: {
  label: string; value: string | null; placeholder?: string;
  onSave: (v: string) => void; normalize?: (v: string) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    setEditing(false);
    const v = normalize ? normalize(draft) : draft.trim();
    if (v !== (value ?? "")) onSave(v);
  };
  return (
    <PropRow label={label}>
      {editing ? (
        <input
          autoFocus value={draft} placeholder={placeholder} aria-label={label}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          className="w-full min-w-0 border-b border-border bg-transparent text-[13px] outline-none focus:border-foreground/50"
        />
      ) : (
        <button
          type="button"
          onClick={() => { setDraft(value ?? ""); setEditing(true); }}
          title="Click to edit"
          className={cn("-mx-1.5 -my-0.5 w-[calc(100%+12px)] rounded-md px-1.5 py-0.5 text-left transition-colors duration-fast [overflow-wrap:anywhere] hover:bg-hover", value ? "text-foreground" : "text-muted-foreground/50")}
        >
          {value || placeholder || "—"}
        </button>
      )}
    </PropRow>
  );
}

export function CompanyDetailsSection({ co, domain, getVal, onPatch }: {
  co: Record<string, unknown> & { name?: string; tech_stack?: unknown; enrichment_status?: string | null; last_activity_at?: string | null; employee_count?: number | null; industry?: string | null; location?: string | null; revenue_range?: string | null };
  domain: string | null;
  getVal: (key: string, fallback: string | null | undefined) => string | null;
  onPatch: (key: string, value: string) => void;
}) {
  const tech: string[] = co.tech_stack
    ? (Array.isArray(co.tech_stack) ? co.tech_stack.map(String) : String(co.tech_stack).split(/\s*,\s*/)).filter(Boolean)
    : [];
  const employees = getVal("employee_count", co.employee_count != null ? String(co.employee_count) : null);
  return (
    <PaneSection title="Company details">
      <EditableProp label="Name" value={getVal("name", co.name)} placeholder="Add a name" onSave={v => { if (v) onPatch("name", v); }} />
      <EditableProp label="Domain" value={domain} placeholder="Add a domain" normalize={normalizeDomain} onSave={v => onPatch("domain", v)} />
      <EditableProp label="Industry" value={getVal("industry", co.industry)} placeholder="Add industry" onSave={v => onPatch("industry", v)} />
      <EditableProp label="Employees" value={employees} placeholder="Add headcount" normalize={v => v.replace(/[^0-9]/g, "")} onSave={v => onPatch("employee_count", v)} />
      <EditableProp label="Location" value={getVal("location", co.location)} placeholder="Add location" onSave={v => onPatch("location", v)} />
      <EditableProp label="Revenue" value={getVal("revenue_range", co.revenue_range)} placeholder="Add revenue" onSave={v => onPatch("revenue_range", v)} />
      <PropRow label="Tech stack" empty={!tech.length}>
        <span className="flex flex-wrap gap-1">{tech.map(t => <Pill key={t}>{t}</Pill>)}</span>
      </PropRow>
      {co.enrichment_status && co.enrichment_status !== "enriched" && <PropRow label="Enrichment">{String(co.enrichment_status).replace(/_/g, " ")}</PropRow>}
      <PropRow label="Last activity" empty={!co.last_activity_at}>{when(co.last_activity_at)}</PropRow>
    </PaneSection>
  );
}
