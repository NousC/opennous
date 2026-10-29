// Settings > Knowledge, the workspace context library (GET-875), in the app. Open source since
// 2026-10-29: the files, their versions (GET-1038) and the About us file (GET-1036) are the API's
// /api/context routes. On Cloud a file can also be tagged to RevBoxes (`boxes`); elsewhere it never is.
import { freshAccessToken } from "@/lib/freshToken";
import { PREVIEW } from "@/lib/preview";

export type ContextKind = "reference" | "instructions" | "icp" | "about";
export type ContextBlock = { id: string; title: string; body: string };
export type ContextFile = { id: string; title: string; body: string; document_id: string | null; kind?: ContextKind };
// A file saved once for the workspace. `boxes` are the RevBox tags this viewer can see; `hidden_boxes`
// counts tags on boxes they cannot open. Both are empty without RevBoxes.
export type LibraryFile = ContextFile & {
  kind: ContextKind; visibility: "boxes" | "workspace"; created_by: string; updated_at: string; icp_marked_at: string | null;
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
