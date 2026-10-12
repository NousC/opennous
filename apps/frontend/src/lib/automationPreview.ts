// The editor's preview (GET-566): the flow's variables filled from one real trigger — the
// deal that closed most recently, or one of the few before it. Fields read it from context so
// no panel has to pass it along.
import { createContext } from "react";

export type PreviewSample = { entity_id: string; deal_id: string | null; name: string; at: string | null };

export type Preview = {
  samples: PreviewSample[];
  sample: PreviewSample | null;
  vars: Record<string, unknown>;
  loading: boolean;
  /** Preview with another of the recent samples. */
  pick: (entityId: string) => void;
};

export const PreviewContext = createContext<Preview | null>(null);

/** A variable's value as the email will print it. */
export function shown(v: unknown): string {
  if (v == null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
