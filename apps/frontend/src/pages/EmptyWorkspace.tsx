// Nothing open. When you close the last tab you land here instead of being forced back
// to a page — the same feeling as an editor's empty tab. A few ways back in, centered
// and quiet.

import { useNavigate } from "react-router-dom";

export default function EmptyWorkspace() {
  const navigate = useNavigate();
  // The command palette listens for ⌘K globally; re-emit it so "Go to…" opens it.
  const openPalette = () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));

  const Action = ({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) => (
    <button
      onClick={onClick}
      className="group inline-flex items-center gap-2 text-[14px] text-muted-foreground hover:text-foreground transition-colors"
    >
      <span>{label}</span>
      {hint && (
        <span className="text-[11px] text-muted-foreground/40 group-hover:text-muted-foreground/70 tabular-nums">
          {hint}
        </span>
      )}
    </button>
  );

  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 select-none">
      <Action label="New thread"      onClick={() => navigate("/")} />
      <Action label="Go to…" hint="⌘K" onClick={openPalette} />
      <Action label="Browse accounts" onClick={() => navigate("/accounts")} />
    </div>
  );
}
