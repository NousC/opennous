// A document's citations, resolved one way for every surface that draws it (GET-197): the Pages
// reader, its Evidence panel, and the chat's document panel. Two places numbering the same
// markers independently is exactly the bug the chat's useCitations exists to prevent.
import { useMemo } from "react";
import type { ReportSection } from "@/components/ReportBlocks";
import type { DocDetail, DocSource } from "./api";

const CITE_RE = /\[(c[a-z0-9]{4})\](?!\()/g;
const LEGACY_RE = /\[(\d{1,2})\](?!\()/g;
// "[cbvq8, clf45]" — a model grouping two tokens in one bracket. Prose only links one token per
// bracket, so a group rendered as raw text.
const GROUP_RE = /\[(c[a-z0-9]{4}(?:\s*[,;]\s*c[a-z0-9]{4})+)\]/g;

export const splitCiteGroups = (text: string) =>
  text.replace(GROUP_RE, (_m, inner: string) => inner.split(/\s*[,;]\s*/).map(t => `[${t}]`).join(""));

/**
 * Numbered in READING ORDER: the first marker a reader meets is [1]. Documents written before
 * cite tokens carry plain [1] [2] markers, numbered against their sources in stored order;
 * those are rewritten to the source's token so they link exactly like a new document's.
 */
export function useDocCitations(detail: DocDetail | undefined, sectionsOverride?: ReportSection[]) {
  return useMemo(() => {
    const base = sectionsOverride ?? detail?.document.sections ?? [];
    if (!detail) return { cited: [] as DocSource[], indexOf: (_t: string) => undefined as number | undefined, sections: base };
    const byOrdinal = [...detail.sources].sort((a, b) => a.ordinal - b.ordinal);
    const hasTokens = base.some(sec => /\[c[a-z0-9]{4}/.test(JSON.stringify(sec)));
    const rewrite = (text: string) => {
      const grouped = splitCiteGroups(text);
      if (hasTokens || !byOrdinal.length) return grouped;
      return grouped.replace(LEGACY_RE, (m, n) => {
        const src = byOrdinal[Number(n) - 1];
        return src?.cite_key ? `[${src.cite_key}]` : m;
      });
    };
    const sections = base.map(sec => ({
      ...sec,
      ...(typeof sec.body === "string" ? { body: rewrite(sec.body) } : {}),
      ...(Array.isArray(sec.blocks)
        ? { blocks: sec.blocks.map(b => (b && typeof (b as { body?: unknown }).body === "string" ? { ...b, body: rewrite((b as { body: string }).body) } : b)) }
        : {}),
    })) as ReportSection[];
    const text = sections.map(sec => JSON.stringify(sec)).join("\n");
    const byKey = new Map(detail.sources.filter(s => s.cite_key).map(s => [s.cite_key as string, s]));
    const order: DocSource[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(CITE_RE)) {
      const src = byKey.get(m[1]);
      if (src && !seen.has(src.ref)) { seen.add(src.ref); order.push(src); }
    }
    const index = new Map(order.map((s, i) => [s.cite_key as string, i + 1]));
    return { cited: order, indexOf: (token: string) => index.get(token), sections };
  }, [detail, sectionsOverride]);
}
