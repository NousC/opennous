// /graph: who we know, accounts and people (GET-473). The Brain graph is gone (GET-796), so there is
// one graph and no switch above it. `?revbox=` narrows it to one RevBox's accounts (GET-858): the
// same tabs and panel, read from the box's graph, with a way back and a way out. The box's accounts
// are the ones its Accounts card counts: selected plus worked on by its jobs (GET-891). With
// `&source=runs` it is only the accounts the box's jobs touched in their last 30 days of runs (GET-872).
import { Link, useSearchParams } from "react-router-dom";
import { RelationshipsGraph } from "@/components/graph/RelationshipsGraph";

export default function GraphPage() {
  const [params] = useSearchParams();
  const revbox = params.get("revbox");
  const runs = params.get("source") === "runs";
  const banner = revbox ? (
    <span className="ml-2 inline-flex items-center gap-2 text-[12px] text-muted-foreground">
      <span>{runs ? "Accounts in this RevBox's recent runs" : "Accounts this RevBox works on"}</span>
      <Link to={`/revboxes/${revbox}`} className="text-foreground hover:underline">Back to RevBox</Link>
      <Link to="/graph" className="hover:text-foreground hover:underline">Show all</Link>
    </span>
  ) : null;
  return (
    <div className="relative h-full w-full overflow-hidden">
      <RelationshipsGraph
        key={revbox ? `${revbox}:${runs ? "runs" : "scope"}` : "workspace"}
        source={revbox ? (runs ? { path: `/api/revboxes/${revbox}/graph?source=runs`, key: `revbox-${revbox}-runs` } : { path: `/api/revboxes/${revbox}/graph`, key: `revbox-${revbox}` }) : undefined}
        banner={banner}
      />
    </div>
  );
}
