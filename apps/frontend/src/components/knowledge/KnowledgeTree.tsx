// Documents in the sidebar (GET-1082): what this person can open right now, by folder. A folder with
// nothing in it doesn't show. The company repo is in Settings, for admins (GET-1118); switching a file
// on or off stays on the page behind Manage.
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FileText, Folder, SlidersHorizontal } from "lucide-react";
import type { LivingFile } from "@/components/knowledge/LivingFilesGroup";
import { RAIL_STROKE, railActive, railGroupLabel, railIcon, railIconActive, railIdle, railLabel, railLabelActive, railRow } from "@/components/shell/rail";
import { useAuth } from "@/contexts/AuthContext";
import { usePref } from "@/hooks/usePref";
import { cloud } from "@/lib/cloud";
import { FOLDED_PREF, isFolded, KNOWLEDGE_PATH, knowledgeKey, knowledgeRequest, libraryRows, playbookRows, pushedFolders, type ContextLibraryData, type KnowledgeRow } from "@/lib/knowledge";

export function KnowledgeTree() {
  const { session, userData } = useAuth();
  const ws = userData?.workspace?.id ?? "";
  const token = session?.access_token ?? "";
  const location = useLocation();
  const navigate = useNavigate();
  const ready = !!ws && !!token;
  const library = useQuery({ queryKey: knowledgeKey(ws), enabled: ready, queryFn: () => knowledgeRequest<ContextLibraryData>(ws, token, "/library") });
  const living = useQuery({ queryKey: ["living-files", ws], enabled: ready, queryFn: () => knowledgeRequest<{ files: LivingFile[]; can_manage: boolean }>(ws, token, "/living-files") });
  const [folded, setFolded] = usePref<string[]>(FOLDED_PREF, [], isFolded);

  const pages = cloud.knowledge?.pages ?? [];
  const files = library.data?.files ?? [];
  const kept = living.data?.files ?? [];

  const here = location.pathname + location.search;
  const toggle = (name: string) => setFolded(folded.includes(name) ? folded.filter((n) => n !== name) : [...folded, name]);

  const folder = (name: string, leaves: KnowledgeRow[]) => {
    const open = !folded.includes(name);
    return (
      <li key={name}>
        <div className={`${railRow} ${railIdle}`}>
          <button type="button" onClick={() => toggle(name)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1.5 py-[6px] pl-2 text-left">
            <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/45 transition-transform duration-fast ${open ? "rotate-90" : ""}`} strokeWidth={RAIL_STROKE} />
            <Folder className={`h-[14px] w-[14px] flex-shrink-0 ${railIcon}`} strokeWidth={RAIL_STROKE} />
            <span className={`truncate text-[13px] leading-tight ${railLabel}`}>{name}</span>
          </button>
          <button type="button" aria-label={`Manage ${name}`} title="Manage" onClick={() => navigate(KNOWLEDGE_PATH)}
            className="mr-1 rounded p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={RAIL_STROKE} />
          </button>
        </div>
        {open && (
          <ul className="flex flex-col gap-px">
            {leaves.map((leaf) => {
              const active = leaf.href !== KNOWLEDGE_PATH && here === leaf.href;
              return (
                <li key={leaf.key}>
                  <button type="button" onClick={() => navigate(leaf.href)} className={`${railRow} gap-2 py-[6px] pl-[28px] pr-2 text-left ${active ? railActive : railIdle}`}>
                    <FileText className={`h-[14px] w-[14px] flex-shrink-0 ${active ? railIconActive : railIcon}`} strokeWidth={RAIL_STROKE} />
                    <span className={`min-w-0 flex-1 truncate text-[12.5px] leading-tight ${leaf.off ? "text-muted-foreground/60" : active ? railLabelActive : railLabel}`}>{leaf.title}</span>
                    {leaf.off && <span className="flex-shrink-0 text-[11px] text-muted-foreground/50">Off</span>}
                    {leaf.error && <span aria-label="Update failed" className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-risk" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };

  const groups = [...pushedFolders(files), { name: "Playbooks", rows: playbookRows(files, kept, pages) }, { name: "Library", rows: libraryRows(files, kept) }].filter((f) => f.rows.length);
  return (
    <>
      <div className={`px-2 pb-1 pt-4 ${railGroupLabel}`}>Documents</div>
      <ul className="flex flex-col gap-px">{groups.map((f) => folder(f.name, f.rows))}</ul>
    </>
  );
}
