import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { GitBranch, ArrowUpCircle, CheckCircle2, ExternalLink } from "lucide-react";

const REPO = "NousC/opennous";

type Commit = { sha: string; message: string };

// Self-host-only widget: compares the running build (api reports app_commit,
// set by update.sh) against GitHub's latest main, and shows a concise changelog
// so the operator can decide whether to run ./update.sh.
export function VersionWidget({ collapsed = false }: { collapsed?: boolean }) {
  const { userData } = useAuth();
  const u = userData as { self_hosted?: boolean; app_commit?: string | null } | null;
  const selfHosted = u?.self_hosted === true;
  const built = (u?.app_commit || "").slice(0, 7);

  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!selfHosted) return;
    let alive = true;
    fetch(`https://api.github.com/repos/${REPO}/commits?per_page=15&sha=main`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!alive || !Array.isArray(data)) return;
        setCommits(
          data.map((c: { sha: string; commit?: { message?: string } }) => ({
            sha: String(c.sha).slice(0, 7),
            message: String(c.commit?.message || "").split("\n")[0],
          })),
        );
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [selfHosted]);

  if (!selfHosted) return null;

  const latest = commits?.[0]?.sha;
  const known = !!latest && !!built;
  const upToDate = known && latest === built;
  const behindIdx = commits && built ? commits.findIndex((c) => c.sha === built) : -1;
  const behind = commits ? (behindIdx === -1 ? commits.length : behindIdx) : 0;

  if (collapsed) {
    return (
      <div className="px-2.5 pb-1 flex justify-center" title={upToDate ? "Up to date" : known ? "Update available" : "Checking…"}>
        <span className={`h-2 w-2 rounded-full ${upToDate ? "bg-emerald-500" : known ? "bg-amber-500" : "bg-muted-foreground/40"}`} />
      </div>
    );
  }

  return (
    <div className="px-2.5 pb-1 relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 hover:bg-muted/50 transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground/70 flex-shrink-0" strokeWidth={1.75} />
          <span className="text-[11px] text-muted-foreground truncate font-mono">{built ? built : "version"}</span>
        </span>
        {known &&
          (upToDate ? (
            <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> up to date
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              <ArrowUpCircle className="h-3 w-3" /> update
            </span>
          ))}
      </button>

      {open && (
        <div className="absolute bottom-full left-2.5 right-2.5 mb-1 z-50 rounded-lg border border-border bg-background shadow-lg p-3 text-[12px]">
          {!known ? (
            <p className="text-muted-foreground">Checking for updates…</p>
          ) : upToDate ? (
            <p className="text-foreground">You're on the latest version (<code className="font-mono text-[11px]">{built}</code>).</p>
          ) : (
            <>
              <p className="font-semibold text-foreground mb-1">
                {behind >= commits!.length ? `${behind}+ updates available` : `${behind} update${behind === 1 ? "" : "s"} available`}
              </p>
              <p className="text-muted-foreground mb-2">
                You're on <code className="font-mono">{built}</code>, latest is <code className="font-mono">{latest}</code>.
              </p>
              <ul className="space-y-1 mb-2 max-h-40 overflow-y-auto">
                {commits!.slice(0, behind >= commits!.length ? 6 : behind).map((c) => (
                  <li key={c.sha} className="text-foreground/80 leading-snug">
                    <span className="font-mono text-[10px] text-muted-foreground">{c.sha}</span> {c.message}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                To update: run <code className="font-mono bg-muted px-1 rounded">./update.sh</code> on your server.
              </p>
            </>
          )}
          <a
            href={`https://github.com/${REPO}/commits/main`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            View all on GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  );
}
