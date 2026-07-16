import { useState, useEffect, useRef } from "react";
import { X, Upload, ArrowLeft, RefreshCw, Check } from "lucide-react";
import { toast } from "@/components/ui/sonner";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// ── CSV helpers ────────────────────────────────────────────────────────────

export function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim()); current = "";
    } else current += ch;
  }
  result.push(current.trim());
  return result;
}

export const IMPORT_FIELDS = [
  { key: "email",          label: "Email" },
  { key: "full_name",      label: "Full Name" },
  { key: "first_name",     label: "First Name" },
  { key: "last_name",      label: "Last Name" },
  { key: "company",        label: "Company" },
  { key: "domain",         label: "Domain" },
  { key: "job_title",      label: "Job Title" },
  { key: "phone",          label: "Phone" },
  { key: "deal_stage",     label: "Deal Stage" },
  { key: "source",         label: "Source" },
  { key: "linkedin_url",   label: "LinkedIn URL" },
  { key: "notes",          label: "Notes" },
  { key: "seniority",      label: "Seniority" },
  { key: "department",     label: "Department" },
  { key: "pipeline_stage", label: "Pipeline Stage" },
] as const;

export const IMPORT_AUTO_MATCH: Record<string, string[]> = {
  email:          ["email", "emailaddress", "mail"],
  first_name:     ["first_name", "firstname", "fname"],
  last_name:      ["last_name", "lastname", "lname", "surname"],
  full_name:      ["full_name", "fullname", "name"],
  company:        ["company", "companyname", "organization", "account"],
  domain:         ["domain", "website", "companydomain", "company_domain", "url", "web"],
  job_title:      ["title", "job_title", "jobtitle", "position", "role"],
  phone:          ["phone", "phonenumber", "mobile", "tel"],
  deal_stage:     ["deal_stage", "dealstage"],
  source:         ["source", "leadsource", "lead_source"],
  linkedin_url:   ["linkedin_url", "linkedin", "linkedinurl"],
  notes:          ["notes", "note", "comment", "description"],
  seniority:      ["seniority", "senioritylevel", "level"],
  department:     ["department", "dept", "team"],
  pipeline_stage: ["pipeline_stage", "pipelinestage", "pipeline"],
};

export function detectImportMappings(headers: string[]): Record<string, string> {
  const used = new Set<string>();
  const map: Record<string, string> = {};
  for (const h of headers) {
    const lh = h.toLowerCase().replace(/[-_\s]/g, "");
    for (const [field, aliases] of Object.entries(IMPORT_AUTO_MATCH)) {
      if (!used.has(field) && aliases.some(a => lh === a)) { map[h] = field; used.add(field); break; }
    }
    if (map[h] === undefined) map[h] = "";
  }
  return map;
}

export const SOURCE_LABELS: Record<string, string> = {
  gmail: "Gmail", smtp: "Email (SMTP)", linkedin: "LinkedIn",
  instantly: "Instantly", slack: "Slack",
};

// ── Importer body (state machine, no chrome) ───────────────────────────────

interface PeopleImportProps {
  workspaceId: string;
  token: string;
  onClose: () => void;
  onDone: () => void;
  // Onboarding: the history backfill still runs server-side (fire-and-forget),
  // but we skip the in-app "scanning" UI so the flow stays fast and just advances.
  skipScan?: boolean;
}

function useImportState({ workspaceId, token, onClose, onDone, skipScan }: PeopleImportProps) {
  const [step, setStep] = useState<"upload" | "mapping" | "scanning">("upload");
  const [dragOver, setDragOver] = useState(false);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvSampleRow, setCsvSampleRow] = useState<Record<string, string>>({});
  const [csvAllRows, setCsvAllRows] = useState<Record<string, string>[]>([]);
  const [fieldMappings, setFieldMappings] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ created: number; updated: number } | null>(null);
  const [enrichJobId, setEnrichJobId] = useState<string | null>(null);
  const [enrichProgress, setEnrichProgress] = useState<{ contacts: any[]; done: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step !== "scanning" || !enrichJobId || !token) return;
    const poll = async () => {
      try {
        const r = await fetch(`${apiUrl}/api/contacts/enrich-progress/${enrichJobId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const d = await r.json();
        if (d.found) setEnrichProgress({ contacts: d.contacts, done: d.done });
      } catch { /* silent */ }
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => clearInterval(id);
  }, [step, enrichJobId, token]);

  const parseCSVFile = async (file: File) => {
    try {
      const text = await file.text();
      const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/);
      if (lines.length < 2) { toast.error("CSV is empty or has no data rows"); return; }
      const headers = parseCSVLine(lines[0]);
      const rows = lines.slice(1).map(line => {
        const vals = parseCSVLine(line);
        const row: Record<string, string> = {};
        headers.forEach((h, i) => { row[h] = vals[i]?.trim() || ""; });
        return row;
      }).filter(r => Object.values(r).some(v => v));
      setCsvHeaders(headers); setCsvAllRows(rows);
      setCsvSampleRow(rows[0] || {}); setFieldMappings(detectImportMappings(headers));
      setStep("mapping");
    } catch { toast.error("Failed to parse CSV"); }
  };

  const runImport = async () => {
    setImporting(true);
    try {
      const rows = csvAllRows.map(row => {
        const mapped: Record<string, string> = {};
        for (const [col, field] of Object.entries(fieldMappings)) {
          if (field && row[col]) mapped[field] = row[col];
        }
        if (mapped.full_name && !mapped.first_name && !mapped.last_name) {
          const parts = mapped.full_name.trim().split(/\s+/);
          mapped.first_name = parts[0] || "";
          mapped.last_name = parts.slice(1).join(" ") || "";
          delete mapped.full_name;
        }
        return mapped;
      }).filter(r => r.email || r.linkedin_url);

      if (!rows.length) {
        toast.error("No rows with a mapped Email or LinkedIn URL — please map at least one column");
        return;
      }

      const res = await fetch(`${apiUrl}/api/contacts/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId, rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setImportResult({ created: data.created || 0, updated: data.updated || 0 });

      if (data.jobId && !skipScan) {
        setEnrichJobId(data.jobId);
        setEnrichProgress(null);
        setStep("scanning");
      } else {
        // Backfill (data.jobId) still runs on the server; in skipScan mode we just
        // don't surface its progress — advance immediately.
        toast.success(data.created > 0 ? `${data.created} contacts imported` : `${data.updated} contacts updated`);
        onDone();
      }
    } catch (err: any) {
      toast.error(err.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  return {
    step, setStep, dragOver, setDragOver, csvHeaders, csvSampleRow, csvAllRows,
    fieldMappings, setFieldMappings, importing, importResult, enrichProgress,
    fileRef, parseCSVFile, runImport, onClose, onDone,
  };
}

// ── Shared button styles ───────────────────────────────────────────────────

const BTN_PRIMARY = "inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-[13px] font-semibold hover:bg-primary/90 disabled:opacity-40 transition-colors";
const BTN_SECONDARY = "inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-accent disabled:opacity-40 transition-colors";

// ── Step subtitle ──────────────────────────────────────────────────────────

function stepSubtitle(step: string) {
  if (step === "upload")   return "Upload a CSV of contacts to add to your workspace.";
  if (step === "mapping")  return "Match each CSV column to a contact field.";
  return "Backfilling history from your connected tools.";
}

function ImportBody(s: ReturnType<typeof useImportState>) {
  if (s.step === "scanning") {
    return (
      <div className="px-6 py-5">
        <div className="flex items-center gap-2.5 mb-4">
          {s.enrichProgress?.done
            ? <Check className="h-4 w-4 text-emerald-600" />
            : <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground/70" />}
          <span className="text-[13px] font-medium text-foreground">
            {s.enrichProgress?.done ? "Scan complete" : "Scanning contact history…"}
          </span>
          {s.importResult && (
            <span className="text-[12px] text-muted-foreground/70 ml-auto">
              {s.importResult.created} new · {s.importResult.updated} updated
            </span>
          )}
        </div>

        <div className="space-y-2 max-h-[55vh] overflow-y-auto">
          {(s.enrichProgress?.contacts ?? []).map((contact: any) => {
            const entries = Object.entries(contact.sources as Record<string, { status: string; count: number }>);
            const active = entries.filter(([, val]) => val.status !== "skipped");
            const allSkipped = active.length === 0;
            return (
              <div key={contact.id} className="rounded-lg border border-border px-4 py-3">
                <div className="text-[13px] text-foreground mb-2">
                  {contact.name}
                  {contact.email && <span className="text-muted-foreground/70 ml-2">{contact.email}</span>}
                </div>
                {allSkipped ? (
                  <div className="text-[12px] text-muted-foreground/50 italic">No integrations connected</div>
                ) : (
                  <div className="space-y-1.5">
                    {active.map(([src, val]) => (
                      <div key={src} className="flex items-center justify-between">
                        <span className="text-[12px] text-muted-foreground">{SOURCE_LABELS[src] ?? src}</span>
                        {val.status === "pending" && <span className="text-[12px] text-muted-foreground/50">Waiting…</span>}
                        {val.status === "scanning" && (
                          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/70 animate-pulse" />Scanning…
                          </span>
                        )}
                        {val.status === "done" && val.count > 0 && (
                          <span className="flex items-center gap-1 text-[12px] text-emerald-600">
                            <Check className="h-3 w-3" />{val.count} found
                          </span>
                        )}
                        {val.status === "done" && val.count === 0 && (
                          <span className="text-[12px] text-muted-foreground/50">—</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {s.enrichProgress?.done && (s.enrichProgress.contacts?.length ?? 0) === 0 && (
            <div className="rounded-lg border border-dashed border-border py-8 px-4 text-[12px] text-muted-foreground/70 text-center">
              Connect Gmail, LinkedIn, or other integrations to scan contact history automatically.
            </div>
          )}
          {!s.enrichProgress && (
            <div className="flex justify-center py-10">
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground/50" />
            </div>
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-border/60">
          <button
            disabled={!s.enrichProgress?.done}
            onClick={() => { s.onDone(); s.onClose(); }}
            className={`${BTN_PRIMARY} w-full h-10`}
          >
            {s.enrichProgress?.done ? "Done" : "Scanning…"}
          </button>
        </div>
      </div>
    );
  }

  if (s.step === "upload") {
    return (
      <div className="px-6 py-6">
        <div
          onDragOver={e => { e.preventDefault(); s.setDragOver(true); }}
          onDragLeave={() => s.setDragOver(false)}
          onDrop={e => {
            e.preventDefault(); s.setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f?.name.endsWith(".csv")) s.parseCSVFile(f); else toast.error("Please drop a .csv file");
          }}
          onClick={() => s.fileRef.current?.click()}
          className={`flex flex-col items-center justify-center gap-3 h-44 rounded-xl border-2 border-dashed cursor-pointer transition-colors select-none ${
            s.dragOver ? "border-foreground bg-muted/50" : "border-border hover:border-border hover:bg-accent"
          }`}
        >
          <div className="h-11 w-11 rounded-xl bg-muted flex items-center justify-center">
            <Upload className="h-5 w-5 text-muted-foreground/70" />
          </div>
          <div className="text-center">
            <p className="text-[13px] text-foreground/80">
              Drop a CSV file here, or <span className="font-semibold text-foreground">click to browse</span>
            </p>
            <p className="text-[12px] text-muted-foreground/70 mt-1">You'll map the columns in the next step.</p>
          </div>
        </div>
        <input
          ref={s.fileRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) s.parseCSVFile(f); }}
        />
      </div>
    );
  }

  // mapping
  return (
    <div>
      <div className="overflow-y-auto" style={{ maxHeight: "60vh" }}>
        <div className="grid grid-cols-[1fr_200px_1fr] gap-4 px-6 py-2.5 border-b border-border bg-muted/50">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">CSV column</span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Maps to</span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Sample</span>
        </div>
        {s.csvHeaders.map(col => (
          <div key={col} className="grid grid-cols-[1fr_200px_1fr] gap-4 items-center px-6 py-3 border-b border-border/60 last:border-0">
            <span className="text-[13px] text-foreground/80 truncate pr-2">{col}</span>
            <select
              value={s.fieldMappings[col] || ""}
              onChange={e => s.setFieldMappings(p => ({ ...p, [col]: e.target.value }))}
              className="h-9 rounded-lg border border-border bg-background text-[13px] text-foreground/80 px-2.5 outline-none hover:border-border focus:border-ring transition-colors"
            >
              <option value="">— Skip —</option>
              {IMPORT_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <span className="text-[12px] text-muted-foreground/70 truncate">{s.csvSampleRow[col] || "—"}</span>
          </div>
        ))}
      </div>
      <div className="px-6 py-3.5 border-t border-border/60 flex items-center justify-between">
        <button onClick={() => s.setStep("upload")} className={BTN_SECONDARY}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-muted-foreground/70">{s.csvAllRows.length} rows</span>
          <button onClick={s.runImport} disabled={s.importing} className={BTN_PRIMARY}>
            {s.importing
              ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Importing…</>
              : <><Upload className="h-3.5 w-3.5" /> Import people</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// Embeddable panel — no backdrop, no header. Caller wraps it however.
export function PeopleImportPanel(props: PeopleImportProps) {
  const state = useImportState(props);
  return <ImportBody {...state} />;
}

// Full modal — backdrop + header + panel.
export function PeopleImportModal(props: PeopleImportProps) {
  const state = useImportState(props);
  const maxWidth = state.step === "mapping" ? 640 : state.step === "scanning" ? 540 : 480;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={state.step === "scanning" ? undefined : props.onClose}
    >
      <div
        className="bg-background rounded-xl border border-border shadow-2xl w-full"
        style={{ maxWidth }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 py-4 border-b border-border/60">
          <div>
            <h2 className="text-[16px] font-bold tracking-tight text-foreground">Import people</h2>
            <p className="text-[12px] text-muted-foreground mt-0.5">{stepSubtitle(state.step)}</p>
          </div>
          <button
            onClick={props.onClose}
            className="h-8 w-8 -mr-1.5 -mt-0.5 flex items-center justify-center rounded-lg text-muted-foreground/70 hover:bg-accent hover:text-foreground/80 transition-colors flex-shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ImportBody {...state} />
      </div>
    </div>
  );
}
