// Settings > Knowledge, the workspace context library (GET-875), in the app. Open source since
// 2026-10-29: the files, their versions (GET-1038) and the About us file (GET-1036) are the API's
// /api/context routes. On Cloud a file can also be tagged to RevBoxes (`boxes`); elsewhere it never is.
import { freshAccessToken } from "@/lib/freshToken";
import { PREVIEW } from "@/lib/preview";

export type ContextKind = "reference" | "instructions" | "icp" | "about";
export type ContextVisibility = "boxes" | "workspace" | "operators";
export const VISIBILITY_LABEL: Record<ContextVisibility, string> = { boxes: "Only me", operators: "Operators", workspace: "Everyone" };
export type ContextBlock = { id: string; title: string; body: string };
export type ContextFile = { id: string; title: string; body: string; document_id: string | null; kind?: ContextKind };
// A file saved once for the workspace. `boxes` are the RevBox tags this viewer can see; `hidden_boxes`
// counts tags on boxes they cannot open. Both are empty without RevBoxes.
export type LibraryFile = ContextFile & {
  kind: ContextKind; visibility: ContextVisibility; folder?: string | null; created_by: string; updated_at: string; icp_marked_at: string | null;
  boxes: { id: string; name: string; shared: boolean }[]; hidden_boxes: number; can_edit: boolean;
};
export type ContextLibraryData = {
  files: LibraryFile[]; icp_file_id: string | null; about_file_id?: string | null; is_admin: boolean;
  boxes: { id: string; name: string; shared: boolean; access: "owner" | "editor" | "viewer"; blocks: ContextBlock[] }[];
};
/** One version of a context file (GET-1038): its text then, who wrote it, and the change note. */
export type ContextVersion = {
  id: string; file_id: string; title: string; kind: string; body: string;
  author_kind: "person" | "opennous" | "repo"; author: string; changelog: string | null; git_sha: string | null; created_at: string;
};
/** A file as the sidebar's tree and the explorer list it (GET-1082). `living` is a file OpenNous keeps; `off`, one switched off. */
export type KnowledgeRow = { key: string; title: string; href: string; type: string; updated?: string | null; off?: boolean; living?: boolean; error?: string | null };
type LivingRow = { key: string; title: string; enabled: boolean; file_id: string | null; last_run_at?: string | null; last_error?: string | null };
export const KNOWLEDGE_PATH = "/knowledge";
/** The Playbooks folder: the ICP, then the files OpenNous keeps. `pages` are the ones that open as a page (Cloud). */
export function playbookRows(files: LibraryFile[], living: LivingRow[], pages: readonly string[]): KnowledgeRow[] {
  const icp = files.find((f) => f.kind === "icp");
  const icpHref = pages.includes("icp") ? `${KNOWLEDGE_PATH}?page=icp` : icp ? `${KNOWLEDGE_PATH}?file=${icp.id}` : null;
  return [
    ...(icpHref ? [{ key: "icp", title: "ICP", href: icpHref, type: "ICP", updated: icp?.updated_at }] : []),
    ...living.map((f) => ({
      key: f.key, title: f.title, type: "Auto-updated", living: true, off: !f.enabled, updated: f.enabled ? f.last_run_at : null, error: f.last_error,
      // A file that is off has nothing to open yet.
      href: !f.enabled || !f.file_id ? KNOWLEDGE_PATH : f.key === "win_loss" && pages.includes("win-loss") ? `${KNOWLEDGE_PATH}?page=win-loss` : `${KNOWLEDGE_PATH}?file=${f.file_id}`,
    })),
  ];
}
/** The Library folder: every file that is not already in Playbooks. */
export function libraryRows(files: LibraryFile[], living: LivingRow[]): KnowledgeRow[] {
  const kept = new Set(living.map((f) => f.file_id));
  return files.filter((f) => f.kind !== "icp" && !kept.has(f.id) && !f.folder).map(row);
}
/** The folders operators push documents into (GET-1117), as far as this viewer may see them. */
export function pushedFolders(files: LibraryFile[]): { name: string; rows: KnowledgeRow[] }[] {
  const names = [...new Set(files.flatMap((f) => (f.folder ? [f.folder] : [])))].sort();
  return names.map((name) => ({ name, rows: files.filter((f) => f.folder === name).map(row) }));
}
const row = (f: LibraryFile): KnowledgeRow => ({
  key: f.id, title: f.title, href: `${KNOWLEDGE_PATH}?file=${f.id}`, updated: f.updated_at,
  type: [CONTEXT_KIND_LABEL[f.kind], f.visibility !== "workspace" && VISIBILITY_LABEL[f.visibility]].filter(Boolean).join(" · "),
});
/** Which folders are folded: one pref, so the tree and the explorer fold together. */
export const FOLDED_PREF = "sidebar.knowledge.folded";
export const isFolded = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export const CONTEXT_KIND_LABEL: Record<ContextKind, string> = { reference: "Reference", instructions: "Instructions", icp: "ICP", about: "About us" };

/** The library's query key, shared with every page that changes a file (the RevBox page too). */
export const knowledgeKey = (ws: string) => ["revbox-context-library", ws] as const;

/**
 * A request to /api/context: `path` like "/library" or "/files/<id>", the workspace added. A refusal
 * throws with its status and code (GET-878: icp_scorer_switch_required asks before scoring).
 */
export async function knowledgeRequest<T>(workspaceId: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const [route, own = ""] = path.split("?");
  const query = new URLSearchParams(own);
  query.set("workspaceId", workspaceId);
  const res = await fetch(`${import.meta.env.VITE_API_URL ?? ""}/api/context${route}?${query}`, {
    ...init, headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${(await freshAccessToken()) ?? token}`,
      // The preview's mock API plays two people (the visual tests' member view).
      ...(PREVIEW ? { "X-Preview-User": localStorage.getItem("nous.preview.role") === "member" ? "u2" : "u1" } : {}), ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status}).`), { status: res.status, code: typeof body.code === "string" ? body.code : undefined });
  return body as T;
}
