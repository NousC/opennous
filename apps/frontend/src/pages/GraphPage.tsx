// /graph: who we know, accounts and people (GET-473). The Brain graph is gone (GET-796), so there is
// one graph and no switch above it.
import { RelationshipsGraph } from "@/components/graph/RelationshipsGraph";

export default function GraphPage() {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <RelationshipsGraph />
    </div>
  );
}
