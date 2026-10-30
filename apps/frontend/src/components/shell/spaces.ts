// The sidebar's three spaces (GET-1082). The top row is not page links: each tab is its own sidebar.
// The URL decides which one shows, so a link, a reload and Back all land in the right one. Every
// path not listed here is Home's.
export type SpaceId = "home" | "inbox" | "graph";

const PREFIXES: Record<Exclude<SpaceId, "home">, string[]> = {
  inbox: ["/inbox", "/tasks"],
  graph: ["/graph", "/insights", "/gtm-insights", "/knowledge"],
};

const within = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/");

export function spaceOf(pathname: string): SpaceId {
  if (PREFIXES.inbox.some((p) => within(pathname, p))) return "inbox";
  if (PREFIXES.graph.some((p) => within(pathname, p))) return "graph";
  return "home";
}
