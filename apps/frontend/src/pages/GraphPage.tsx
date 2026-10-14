// /graph: who we know, accounts and people (GET-473). The Brain graph is gone (GET-796), so there is
// one graph and no switch above it. `?revbox=` narrows it to one RevBox's accounts (GET-858): the
// same tabs and panel, read from the box's scoped graph, with a way back and a way out.
import { Link, useSearchParams } from "react-router-dom";
import { RelationshipsGraph } from "@/components/graph/RelationshipsGraph";

export default function GraphPage() {
  const [params] = useSearchParams();
  const revbox = params.get("revbox");
  const banner = revbox ? (
    <span className="ml-2 inline-flex items-center gap-2 text-[12px] text-muted-foreground">
      <span>RevBox accounts only</span>
      <Link to={`/revboxes/${revbox}`} className="text-foreground hover:underline">Back to RevBox</Link>
      <Link to="/graph" className="hover:text-foreground hover:underline">Show all</Link>
    </span>
  ) : null;
  return (
    <div className="relative h-full w-full overflow-hidden">
      <RelationshipsGraph
        key={revbox ?? "workspace"}
        source={revbox ? { path: `/api/revboxes/${revbox}/graph`, key: `revbox-${revbox}` } : undefined}
        banner={banner}
      />
    </div>
  );
}
