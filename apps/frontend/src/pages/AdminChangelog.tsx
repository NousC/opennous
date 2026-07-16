import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, ArrowLeft, Image as ImageIcon, Loader2, Check, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/components/ui/sonner";

type Tag = "feature" | "improvement" | "fix" | "announcement";

interface ChangelogEntry {
  id: string;
  title: string;
  description: string;
  image_url: string | null;
  tag: Tag;
  published_at: string;
  created_at: string;
}

const TAGS: { value: Tag; label: string; color: string }[] = [
  { value: "feature",      label: "New Feature",   color: "#00FF41" },
  { value: "improvement",  label: "Improvement",   color: "#60A5FA" },
  { value: "fix",          label: "Fix",           color: "#F59E0B" },
  { value: "announcement", label: "Announcement",  color: "#A78BFA" },
];

const EMPTY_FORM = {
  title: "",
  description: "",
  image_url: "",
  tag: "feature" as Tag,
  published_at: new Date().toISOString().slice(0, 10),
};

export default function AdminChangelog() {
  const navigate = useNavigate();
  const { session, loading: authLoading } = useAuth();

  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const apiUrl = import.meta.env.VITE_API_URL ?? "";

  useEffect(() => {
    if (!authLoading) loadEntries();
  }, [authLoading]);

  const headers = () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${session?.access_token ?? ""}`,
  });

  const loadEntries = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/changelog/entries`, { headers: headers() });
      const data = res.ok ? await res.json() : { entries: [] };
      setEntries(data.entries || []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.description.trim()) {
      toast.error("Title and description are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/changelog/entries`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          ...form,
          image_url: form.image_url.trim() || null,
          published_at: new Date(form.published_at).toISOString(),
        }),
      });
      if (!res.ok) throw new Error();
      toast.success("Entry published.");
      setForm(EMPTY_FORM);
      setShowForm(false);
      loadEntries();
    } catch {
      toast.error("Failed to save entry.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      const res = await fetch(`${apiUrl}/api/changelog/entries/${id}`, {
        method: "DELETE",
        headers: headers(),
      });
      if (!res.ok) throw new Error();
      toast.success("Entry deleted.");
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch {
      toast.error("Failed to delete entry.");
    } finally {
      setDeleting(null);
    }
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="min-h-screen bg-[#0D0D0D] antialiased text-white">
      {/* ─── Header ─────────────────────────────────────────────── */}
      <div className="border-b border-[#1A1A1A] px-6 py-4">
        <div className="max-w-[900px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate(-1)}
              className="text-[#4B5563] hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <p className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em]">Admin</p>
              <h1 className="text-[18px] font-bold tracking-[-0.02em]">Changelog CMS</h1>
            </div>
          </div>
          <button
            onClick={() => { setShowForm(true); setForm(EMPTY_FORM); }}
            className="h-9 px-4 rounded border border-[#00FF41]/40 bg-[#00FF41]/5 hover:bg-[#00FF41]/10 text-[#00FF41] text-[13px] font-mono font-medium transition-all inline-flex items-center gap-2"
          >
            <Plus className="w-3.5 h-3.5" />
            New entry
          </button>
        </div>
      </div>

      <div className="max-w-[900px] mx-auto px-6 py-10">

        {/* ─── Create Form ──────────────────────────────────────── */}
        {showForm && (
          <div className="rounded-xl border border-[#00FF41]/20 bg-[#080808] p-6 mb-10">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-[15px] font-bold">New changelog entry</h2>
              <button
                onClick={() => setShowForm(false)}
                className="text-[#4B5563] hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSave} className="space-y-5">
              {/* Tag */}
              <div>
                <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] block mb-2">
                  Tag
                </label>
                <div className="flex flex-wrap gap-2">
                  {TAGS.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, tag: t.value }))}
                      className="h-8 px-3 rounded border text-[12px] font-mono transition-all"
                      style={{
                        borderColor: form.tag === t.value ? t.color + "80" : "#1A1A1A",
                        color: form.tag === t.value ? t.color : "#4B5563",
                        background: form.tag === t.value ? t.color + "10" : "transparent",
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Title */}
              <div>
                <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] block mb-2">
                  Title
                </label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. MCP server now supports context streaming"
                  className="w-full h-10 px-3 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[14px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors"
                />
              </div>

              {/* Description */}
              <div>
                <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] block mb-2">
                  Description
                </label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="What changed and why it matters..."
                  rows={4}
                  className="w-full px-3 py-2.5 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[14px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors resize-none leading-relaxed"
                />
              </div>

              {/* Image URL */}
              <div>
                <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] block mb-2">
                  Image URL <span className="text-[#2D3748] normal-case tracking-normal">(optional)</span>
                </label>
                <div className="relative">
                  <ImageIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#2D3748]" />
                  <input
                    type="url"
                    value={form.image_url}
                    onChange={(e) => setForm((f) => ({ ...f, image_url: e.target.value }))}
                    placeholder="https://..."
                    className="w-full h-10 pl-9 pr-3 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[14px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors"
                  />
                </div>
              </div>

              {/* Date */}
              <div>
                <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] block mb-2">
                  Date
                </label>
                <input
                  type="date"
                  value={form.published_at}
                  onChange={(e) => setForm((f) => ({ ...f, published_at: e.target.value }))}
                  className="h-10 px-3 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[14px] font-mono focus:outline-none focus:border-[#333] transition-colors"
                />
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="h-9 px-5 rounded bg-[#00FF41] hover:bg-[#00e03a] text-black text-[13px] font-mono font-semibold transition-all inline-flex items-center gap-2 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  {saving ? "Publishing..." : "Publish entry"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="h-9 px-4 rounded border border-[#1A1A1A] hover:border-[#333] text-[#4B5563] hover:text-white text-[13px] font-mono transition-all"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ─── Entries List ─────────────────────────────────────── */}
        {loading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="rounded-xl border border-[#1A1A1A] bg-[#080808] p-5 animate-pulse">
                <div className="h-3 w-16 bg-[#1A1A1A] rounded mb-3" />
                <div className="h-5 w-1/2 bg-[#1A1A1A] rounded mb-2" />
                <div className="h-3 w-full bg-[#1A1A1A] rounded" />
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-24 rounded-xl border border-dashed border-[#1A1A1A]">
            <p className="text-[15px] font-mono text-white mb-1">No entries yet</p>
            <p className="text-[13px] font-mono text-[#4B5563]">
              Click "New entry" to publish your first changelog update.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] mb-2">
              {entries.length} {entries.length === 1 ? "entry" : "entries"}
            </p>
            {entries.map((entry) => {
              const tag = TAGS.find((t) => t.value === entry.tag) ?? TAGS[0];
              return (
                <div
                  key={entry.id}
                  className="rounded-xl border border-[#1A1A1A] bg-[#080808] p-5 flex items-start justify-between gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5 mb-2">
                      <span
                        className="inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wider"
                        style={{ color: tag.color, borderColor: tag.color + "4D" }}
                      >
                        {tag.label}
                      </span>
                      <span className="text-[11px] font-mono text-[#4B5563]">
                        {formatDate(entry.published_at)}
                      </span>
                    </div>
                    <h3 className="text-[15px] font-bold text-white leading-snug mb-1 truncate">
                      {entry.title}
                    </h3>
                    <p className="text-[13px] text-[#6B7280] leading-relaxed line-clamp-2">
                      {entry.description}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(entry.id)}
                    disabled={deleting === entry.id}
                    className="shrink-0 w-8 h-8 rounded border border-[#1A1A1A] hover:border-red-500/40 hover:text-red-400 text-[#4B5563] transition-all flex items-center justify-center"
                  >
                    {deleting === entry.id
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Trash2 className="w-3.5 h-3.5" />
                    }
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
