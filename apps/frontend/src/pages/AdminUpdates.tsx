import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, ChevronLeft, Loader2, Check, X, Pencil, ChevronDown, ChevronUp, Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/components/ui/sonner";

type Category = "Marketing" | "Sales" | "Development" | "Product" | "Design" | "Infrastructure" | "Positioning";

const CATEGORIES: Category[] = ["Marketing", "Sales", "Development", "Product", "Design", "Infrastructure", "Positioning"];

const CAT_COLOR: Record<Category, string> = {
  Marketing:      "#F59E0B",
  Sales:          "#3B82F6",
  Development:    "#10B981",
  Product:        "#8B5CF6",
  Design:         "#EC4899",
  Infrastructure: "#64748B",
  Positioning:    "#EA580C",
};

interface UpdateItem { category: Category; text: string }

interface WeeklyUpdate {
  id: string;
  week: number;
  title: string;
  date: string;
  description: string;
  items: UpdateItem[];
  yt_title: string | null;
  yt_url: string | null;
  published: boolean;
  created_at: string;
}

const EMPTY_FORM = {
  week: 1,
  title: "",
  date: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
  description: "",
  items: [] as UpdateItem[],
  yt_title: "",
  yt_url: "",
  published: true,
};

export default function AdminUpdates() {
  const navigate = useNavigate();
  const { session, loading: authLoading } = useAuth();

  const [updates, setUpdates] = useState<WeeklyUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const apiUrl = import.meta.env.VITE_API_URL ?? "";
  const headers = () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${session?.access_token ?? ""}`,
  });

  useEffect(() => {
    if (!authLoading) load();
  }, [authLoading]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/admin/updates`, { headers: headers() });
      const data = res.ok ? await res.json() : { updates: [] };
      setUpdates(data.updates || []);
    } catch {
      setUpdates([]);
    } finally {
      setLoading(false);
    }
  };

  const openNew = () => {
    const nextWeek = updates.length > 0 ? Math.max(...updates.map(u => u.week)) + 1 : 1;
    setForm({ ...EMPTY_FORM, week: nextWeek });
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (u: WeeklyUpdate) => {
    setForm({
      week: u.week,
      title: u.title,
      date: u.date,
      description: u.description,
      items: u.items,
      yt_title: u.yt_title ?? "",
      yt_url: u.yt_url ?? "",
      published: u.published,
    });
    setEditingId(u.id);
    setShowForm(true);
    setExpandedId(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.date.trim()) {
      toast.error("Title and date are required.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        week: form.week,
        title: form.title.trim(),
        date: form.date.trim(),
        description: form.description.trim(),
        items: form.items,
        yt_title: form.yt_title.trim() || null,
        yt_url: form.yt_url.trim() || null,
        published: form.published,
      };

      const res = await fetch(
        editingId ? `${apiUrl}/api/admin/updates/${editingId}` : `${apiUrl}/api/admin/updates`,
        { method: editingId ? "PATCH" : "POST", headers: headers(), body: JSON.stringify(body) }
      );
      if (!res.ok) throw new Error();
      toast.success(editingId ? "Update saved." : "Update published.");
      setShowForm(false);
      setEditingId(null);
      load();
    } catch {
      toast.error("Failed to save update.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      const res = await fetch(`${apiUrl}/api/admin/updates/${id}`, { method: "DELETE", headers: headers() });
      if (!res.ok) throw new Error();
      toast.success("Update deleted.");
      setUpdates(prev => prev.filter(u => u.id !== id));
    } catch {
      toast.error("Failed to delete.");
    } finally {
      setDeleting(null);
    }
  };

  const togglePublished = async (u: WeeklyUpdate) => {
    try {
      const res = await fetch(`${apiUrl}/api/admin/updates/${u.id}`, {
        method: "PATCH", headers: headers(),
        body: JSON.stringify({ published: !u.published }),
      });
      if (!res.ok) throw new Error();
      setUpdates(prev => prev.map(x => x.id === u.id ? { ...x, published: !u.published } : x));
    } catch {
      toast.error("Failed to update.");
    }
  };

  const addItem = () => setForm(f => ({ ...f, items: [...f.items, { category: "Development", text: "" }] }));
  const removeItem = (i: number) => setForm(f => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }));
  const updateItem = (i: number, field: "category" | "text", val: string) =>
    setForm(f => ({ ...f, items: f.items.map((item, idx) => idx === i ? { ...item, [field]: val } : item) }));

  return (
    <div className="min-h-screen bg-[#0D0D0D] antialiased text-white">
      {/* Header */}
      <div className="border-b border-[#1A1A1A] px-6 py-4 sticky top-0 bg-[#0D0D0D] z-10">
        <div className="max-w-[860px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate(-1)} className="text-[#4B5563] hover:text-white transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div>
              <p className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em]">Admin</p>
              <h1 className="text-[18px] font-bold tracking-[-0.02em]">Weekly Updates</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a href="/updates" target="_blank" rel="noopener noreferrer"
              className="text-[12px] font-mono text-[#4B5563] hover:text-white transition-colors">
              View public →
            </a>
            <button onClick={openNew}
              className="h-9 px-4 rounded border border-[#00FF41]/40 bg-[#00FF41]/5 hover:bg-[#00FF41]/10 text-[#00FF41] text-[13px] font-mono font-medium transition-all inline-flex items-center gap-2">
              <Plus className="w-3.5 h-3.5" /> New update
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-[860px] mx-auto px-6 py-10">

        {/* ── Form ── */}
        {showForm && (
          <div className="rounded-xl border border-[#00FF41]/20 bg-[#080808] p-6 mb-10">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-[15px] font-bold">{editingId ? "Edit update" : "New weekly update"}</h2>
              <button onClick={() => { setShowForm(false); setEditingId(null); }} className="text-[#4B5563] hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-5">
              {/* Week + Date row */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] block mb-2">Week #</label>
                  <input type="number" min={1} value={form.week}
                    onChange={e => setForm(f => ({ ...f, week: parseInt(e.target.value) || 1 }))}
                    className="w-full h-10 px-3 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[14px] font-mono focus:outline-none focus:border-[#333] transition-colors" />
                </div>
                <div>
                  <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] block mb-2">Date</label>
                  <input type="text" placeholder="April 25, 2026" value={form.date}
                    onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                    className="w-full h-10 px-3 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[14px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors" />
                </div>
              </div>

              {/* Title */}
              <div>
                <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] block mb-2">Title</label>
                <input type="text" placeholder="Going all in, building in public" value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  className="w-full h-10 px-3 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[14px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors" />
              </div>

              {/* Description */}
              <div>
                <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] block mb-2">Description</label>
                <textarea rows={5} placeholder="What happened this week..." value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[14px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors resize-none leading-relaxed" />
              </div>

              {/* Items */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em]">Update items</label>
                  <button type="button" onClick={addItem}
                    className="text-[11px] font-mono text-[#4B5563] hover:text-white transition-colors flex items-center gap-1">
                    <Plus className="w-3 h-3" /> Add item
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {form.items.map((item, i) => (
                    <div key={i} className="flex items-center gap-2">
                      {/* Category selector */}
                      <select value={item.category}
                        onChange={e => updateItem(i, "category", e.target.value)}
                        className="h-9 px-2 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-[12px] font-mono focus:outline-none focus:border-[#333] transition-colors flex-shrink-0"
                        style={{ color: CAT_COLOR[item.category as Category] ?? "#fff", minWidth: "130px" }}>
                        {CATEGORIES.map(c => (
                          <option key={c} value={c} style={{ color: CAT_COLOR[c] }}>{c}</option>
                        ))}
                      </select>
                      <input type="text" value={item.text} placeholder="What happened..."
                        onChange={e => updateItem(i, "text", e.target.value)}
                        className="flex-1 h-9 px-3 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[13px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors" />
                      <button type="button" onClick={() => removeItem(i)}
                        className="w-8 h-9 flex items-center justify-center text-[#4B5563] hover:text-red-400 transition-colors flex-shrink-0">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  {form.items.length === 0 && (
                    <p className="text-[12px] font-mono text-[#2D3748] py-2">No items yet — click "Add item"</p>
                  )}
                </div>
              </div>

              {/* YouTube (optional) */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] block mb-2">
                    YouTube title <span className="normal-case tracking-normal text-[#2D3748]">(optional)</span>
                  </label>
                  <input type="text" placeholder="Watch this week's video" value={form.yt_title}
                    onChange={e => setForm(f => ({ ...f, yt_title: e.target.value }))}
                    className="w-full h-10 px-3 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[14px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors" />
                </div>
                <div>
                  <label className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em] block mb-2">
                    YouTube URL <span className="normal-case tracking-normal text-[#2D3748]">(optional)</span>
                  </label>
                  <input type="url" placeholder="https://youtube.com/..." value={form.yt_url}
                    onChange={e => setForm(f => ({ ...f, yt_url: e.target.value }))}
                    className="w-full h-10 px-3 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[14px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors" />
                </div>
              </div>

              {/* Published toggle */}
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setForm(f => ({ ...f, published: !f.published }))}
                  className={`w-10 h-5 rounded-full transition-colors flex items-center ${form.published ? "bg-[#00FF41]" : "bg-[#1A1A1A]"}`}>
                  <span className={`w-4 h-4 rounded-full bg-white shadow transition-transform mx-0.5 ${form.published ? "translate-x-5" : "translate-x-0"}`} />
                </button>
                <span className="text-[13px] font-mono text-[#4B5563]">{form.published ? "Published" : "Draft"}</span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3 pt-1">
                <button type="submit" disabled={saving}
                  className="h-9 px-5 rounded bg-[#00FF41] hover:bg-[#00e03a] text-black text-[13px] font-mono font-semibold transition-all inline-flex items-center gap-2 disabled:opacity-50">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  {saving ? "Saving..." : editingId ? "Save changes" : "Publish update"}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }}
                  className="h-9 px-4 rounded border border-[#1A1A1A] hover:border-[#333] text-[#4B5563] hover:text-white text-[13px] font-mono transition-all">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ── List ── */}
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="w-5 h-5 animate-spin text-[#4B5563]" />
          </div>
        ) : updates.length === 0 ? (
          <div className="text-center py-24 rounded-xl border border-dashed border-[#1A1A1A]">
            <p className="text-[15px] font-mono text-white mb-1">No updates yet</p>
            <p className="text-[13px] font-mono text-[#4B5563]">Click "New update" to write your first one.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {updates.map(u => (
              <div key={u.id} className="rounded-xl border border-[#1A1A1A] bg-[#080808] overflow-hidden">
                {/* Row header */}
                <div className="flex items-center gap-4 px-5 py-4">
                  <span className="text-[11px] font-mono text-[#4B5563] flex-shrink-0">Week {u.week}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] font-mono text-white truncate">{u.title}</p>
                    <p className="text-[11px] font-mono text-[#4B5563] mt-0.5">{u.date}</p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${u.published ? "border-[#00FF41]/30 text-[#00FF41] bg-[#00FF41]/5" : "border-[#1A1A1A] text-[#4B5563]"}`}>
                      {u.published ? "live" : "draft"}
                    </span>
                    <button onClick={() => togglePublished(u)} title={u.published ? "Unpublish" : "Publish"}
                      className="w-8 h-8 flex items-center justify-center text-[#4B5563] hover:text-white hover:bg-[#1A1A1A] rounded transition-all">
                      {u.published ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={() => openEdit(u)}
                      className="w-8 h-8 flex items-center justify-center text-[#4B5563] hover:text-white hover:bg-[#1A1A1A] rounded transition-all">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setExpandedId(expandedId === u.id ? null : u.id)}
                      className="w-8 h-8 flex items-center justify-center text-[#4B5563] hover:text-white hover:bg-[#1A1A1A] rounded transition-all">
                      {expandedId === u.id ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={() => handleDelete(u.id)} disabled={deleting === u.id}
                      className="w-8 h-8 flex items-center justify-center text-[#4B5563] hover:text-red-400 hover:bg-red-400/10 rounded transition-all disabled:opacity-30">
                      {deleting === u.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {/* Expanded preview */}
                {expandedId === u.id && (
                  <div className="border-t border-[#1A1A1A] px-5 py-4 space-y-3">
                    {u.description && (
                      <p className="text-[13px] font-mono text-[#4B5563] leading-relaxed">{u.description}</p>
                    )}
                    {u.items.length > 0 && (
                      <div className="flex flex-col gap-2">
                        {u.items.map((item, i) => (
                          <div key={i} className="flex items-start gap-2">
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded flex-shrink-0"
                              style={{ background: CAT_COLOR[item.category as Category] + "20", color: CAT_COLOR[item.category as Category] }}>
                              {item.category}
                            </span>
                            <span className="text-[13px] font-mono text-[#6B7280]">{item.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
