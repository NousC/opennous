// /graph: who we know, accounts and people (GET-473). The Brain graph is gone (GET-796), so there is
// one graph and no switch above it. A Workspace-layer scope (cloud.graph.scope, GET-858) narrows it
// to one object's accounts: the same tabs and panel, read from that object's graph, with its banner.
import { RelationshipsGraph } from "@/components/graph/RelationshipsGraph";
import { useSearchParams } from "react-router-dom";
import { cloud } from "@/lib/cloud";

export default function GraphPage() {
  const [params] = useSearchParams();
  const scope = cloud.graph?.scope?.(params) ?? null;
  return (
    <div className="relative h-full w-full overflow-hidden">
      <RelationshipsGraph
        key={scope?.key ?? "workspace"}
        source={scope?.source}
        banner={scope?.banner ?? null}
      />
    </div>
  );
}
