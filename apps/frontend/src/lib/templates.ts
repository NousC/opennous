// RevPlay templates: the shapes the app reads. The templates themselves live on the server
// (packages/core/src/services/revPlayTemplates.mjs, GET-1087), so the app and agents read one list:
// GET /api/automations returns them, each with its flow drawn.
import type { Flow } from "@/lib/flows";

export type TemplateGroup = "sales" | "cs" | "reporting" | "product";
export const GROUP_LABEL: Record<TemplateGroup, string> = {
  sales: "Sales", cs: "Customer success", reporting: "Reporting", product: "Product",
};

/** A mark in the template's tool row: a tool's logo by slug, or a glyph key. */
export type TemplateTool = { slug: string; label: string } | { glyph: "agent" | "clock" | "signals" | "email"; label: string };

export type Template = {
  id: string;
  name: string;
  does: string;
  group: TemplateGroup;
  tools: TemplateTool[];
  /** Run by OpenNous for every workspace: shown locked, never copied. */
  byDefault?: boolean;
  /** For a default, what actually runs today, said plainly. */
  today?: string;
  flow: Flow;
};

export const templateById = (templates: Template[] | undefined, id: string | null) => templates?.find(t => t.id === id) ?? null;
