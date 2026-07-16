import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, ArrowLeft, ArrowRight, ChevronLeft, Loader2, Check, X, Pencil } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/components/ui/sonner";

type Status = "planned" | "in_progress" | "shipped";

interface RoadmapItem {
  id: string;
  title: string;
  description: string | null;
  status: Status;
  sort_order: number;
  created_at: string;
}

const COLUMNS: { status: Status; label: string; dot: string; accent: string }[] = [
  { status: "planned",     label: "Planned",     dot: "#9CA3AF", accent: "#9CA3AF" },
  { status: "in_progress", label: "In Progress", dot: "#818CF8", accent: "#818CF8" },
  { status: "shipped",     label: "Shipped",     dot: "#34D399", accent: "#34D399" },
];

const STATUS_ORDER: Status[] = ["planned", "in_progress", "shipped"];

export default function AdminRoadmap() {
  const navigate = useNavigate();
  const { session, loading: authLoading } = useAuth();

  const [items, setItems] = useState<RoadmapItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);

  // Add form state (per column)
  const [addingTo, setAddingTo] = useState<Status | null>(null);
  const [addForm, setAddForm] = useState({ title: "", description: "" });
  const [saving, setSaving] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ title: "", description: "" });
  const [editSaving, setEditSaving] = useState(false);

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
      const res = await fetch(`${apiUrl}/api/roadmap/items`, { headers: headers() });
      const data = res.ok ? await res.json() : { items: [] };
      setItems(data.items || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  const itemsFor = (status: Status) =>
    items.filter((i) => i.status === status).sort((a, b) => a.sort_order - b.sort_order);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addForm.title.trim() || !addingTo) return;
    setSaving(true);
    try {
      const colItems = itemsFor(addingTo);
      const sort_order = colItems.length > 0 ? Math.max(...colItems.map((i) => i.sort_order)) + 1 : 0;
      const res = await fetch(`${apiUrl}/api/admin/roadmap/items`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          title: addForm.title.trim(),
          description: addForm.description.trim() || null,
          status: addingTo,
          sort_order,
        }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setItems((prev) => [...prev, data.item]);
      setAddForm({ title: "", description: "" });
      setAddingTo(null);
      toast.success("Item added.");
    } catch {
      toast.error("Failed to add item.");
    } finally {
      setSaving(false);
    }
  };

  const handleMove = async (item: RoadmapItem, direction: "left" | "right") => {
    const idx = STATUS_ORDER.indexOf(item.status);
    const newIdx = direction === "left" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= STATUS_ORDER.length) return;
    const newStatus = STATUS_ORDER[newIdx];

    setMoving(item.id);
    try {
      const colItems = itemsFor(newStatus);
      const sort_order = colItems.length > 0 ? Math.max(...colItems.map((i) => i.sort_order)) + 1 : 0;
      const res = await fetch(`${apiUrl}/api/admin/roadmap/items/${item.id}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ status: newStatus, sort_order }),
      });
      if (!res.ok) throw new Error();
      setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, status: newStatus, sort_order } : i));
    } catch {
      toast.error("Failed to move item.");
    } finally {
      setMoving(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      const res = await fetch(`${apiUrl}/api/admin/roadmap/items/${id}`, {
        method: "DELETE",
        headers: headers(),
      });
      if (!res.ok) throw new Error();
      setItems((prev) => prev.filter((i) => i.id !== id));
      toast.success("Item deleted.");
    } catch {
      toast.error("Failed to delete item.");
    } finally {
      setDeleting(null);
    }
  };

  const startEdit = (item: RoadmapItem) => {
    setEditingId(item.id);
    setEditForm({ title: item.title, description: item.description ?? "" });
  };

  const handleEditSave = async (id: string) => {
    if (!editForm.title.trim()) return;
    setEditSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/admin/roadmap/items/${id}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          title: editForm.title.trim(),
          description: editForm.description.trim() || null,
        }),
      });
      if (!res.ok) throw new Error();
      setItems((prev) =>
        prev.map((i) =>
          i.id === id
            ? { ...i, title: editForm.title.trim(), description: editForm.description.trim() || null }
            : i
        )
      );
      setEditingId(null);
      toast.success("Item updated.");
    } catch {
      toast.error("Failed to update item.");
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0D0D0D] antialiased text-white">
      {/* Header */}
      <div className="border-b border-[#1A1A1A] px-6 py-4">
        <div className="max-w-[1200px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate(-1)} className="text-[#4B5563] hover:text-white transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div>
              <p className="text-[11px] font-mono text-[#4B5563] uppercase tracking-[0.15em]">Admin</p>
              <h1 className="text-[18px] font-bold tracking-[-0.02em]">Roadmap</h1>
            </div>
          </div>
          <a
            href="/roadmap"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] font-mono text-[#4B5563] hover:text-white transition-colors"
          >
            View public page →
          </a>
        </div>
      </div>

      {/* Kanban board */}
      <div className="max-w-[1200px] mx-auto px-6 py-10">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="w-5 h-5 animate-spin text-[#4B5563]" />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-5">
            {COLUMNS.map((col, colIdx) => {
              const colItems = itemsFor(col.status);
              return (
                <div key={col.status} className="flex flex-col gap-3">
                  {/* Column header */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: col.dot }}
                      />
                      <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[#4B5563]">
                        {col.label}
                      </span>
                      <span className="text-[11px] font-mono text-[#2D3748]">{colItems.length}</span>
                    </div>
                    <button
                      onClick={() => { setAddingTo(col.status); setAddForm({ title: "", description: "" }); }}
                      className="w-6 h-6 rounded flex items-center justify-center text-[#4B5563] hover:text-white hover:bg-[#1A1A1A] transition-all"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Add form */}
                  {addingTo === col.status && (
                    <form
                      onSubmit={handleAdd}
                      className="rounded-lg border border-[#333] bg-[#111] p-3 flex flex-col gap-2"
                    >
                      <input
                        autoFocus
                        type="text"
                        value={addForm.title}
                        onChange={(e) => setAddForm((f) => ({ ...f, title: e.target.value }))}
                        placeholder="Item title..."
                        className="w-full h-8 px-2.5 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[13px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors"
                      />
                      <textarea
                        value={addForm.description}
                        onChange={(e) => setAddForm((f) => ({ ...f, description: e.target.value }))}
                        placeholder="Description (optional)..."
                        rows={2}
                        className="w-full px-2.5 py-1.5 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[12px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors resize-none leading-relaxed"
                      />
                      <div className="flex items-center gap-2 pt-0.5">
                        <button
                          type="submit"
                          disabled={saving || !addForm.title.trim()}
                          className="h-7 px-3 rounded text-[12px] font-mono font-medium transition-all inline-flex items-center gap-1.5 disabled:opacity-40"
                          style={{ background: col.accent + "20", color: col.accent, border: `1px solid ${col.accent}40` }}
                        >
                          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                          Add
                        </button>
                        <button
                          type="button"
                          onClick={() => setAddingTo(null)}
                          className="h-7 px-3 rounded border border-[#1A1A1A] hover:border-[#333] text-[#4B5563] hover:text-white text-[12px] font-mono transition-all"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Items */}
                  {colItems.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-lg border border-[#1A1A1A] bg-[#080808] hover:border-[#2D3748] transition-all group"
                    >
                      {editingId === item.id ? (
                        <div className="p-3 flex flex-col gap-2">
                          <input
                            autoFocus
                            type="text"
                            value={editForm.title}
                            onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                            className="w-full h-8 px-2.5 rounded border border-[#333] bg-[#0D0D0D] text-white text-[13px] font-mono focus:outline-none transition-colors"
                          />
                          <textarea
                            value={editForm.description}
                            onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                            placeholder="Description (optional)..."
                            rows={2}
                            className="w-full px-2.5 py-1.5 rounded border border-[#1A1A1A] bg-[#0D0D0D] text-white text-[12px] font-mono placeholder:text-[#2D3748] focus:outline-none focus:border-[#333] transition-colors resize-none leading-relaxed"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleEditSave(item.id)}
                              disabled={editSaving || !editForm.title.trim()}
                              className="h-7 px-3 rounded bg-white/5 border border-white/10 hover:bg-white/10 text-white text-[12px] font-mono transition-all inline-flex items-center gap-1.5 disabled:opacity-40"
                            >
                              {editSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                              Save
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="h-7 px-3 rounded border border-[#1A1A1A] text-[#4B5563] hover:text-white text-[12px] font-mono transition-all"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="p-3">
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <p
                              className={`text-[13px] font-mono leading-snug flex-1 ${
                                col.status === "shipped" ? "text-[#4B5563] line-through" : "text-white"
                              }`}
                            >
                              {item.title}
                            </p>
                            {/* Actions — always visible on this compact toolbar */}
                            <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => startEdit(item)}
                                className="w-6 h-6 rounded flex items-center justify-center text-[#4B5563] hover:text-white hover:bg-[#1A1A1A] transition-all"
                                title="Edit"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                              {colIdx > 0 && (
                                <button
                                  onClick={() => handleMove(item, "left")}
                                  disabled={moving === item.id}
                                  className="w-6 h-6 rounded flex items-center justify-center text-[#4B5563] hover:text-white hover:bg-[#1A1A1A] transition-all disabled:opacity-30"
                                  title="Move left"
                                >
                                  {moving === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowLeft className="w-3 h-3" />}
                                </button>
                              )}
                              {colIdx < COLUMNS.length - 1 && (
                                <button
                                  onClick={() => handleMove(item, "right")}
                                  disabled={moving === item.id}
                                  className="w-6 h-6 rounded flex items-center justify-center text-[#4B5563] hover:text-white hover:bg-[#1A1A1A] transition-all disabled:opacity-30"
                                  title="Move right"
                                >
                                  {moving === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
                                </button>
                              )}
                              <button
                                onClick={() => handleDelete(item.id)}
                                disabled={deleting === item.id}
                                className="w-6 h-6 rounded flex items-center justify-center text-[#4B5563] hover:text-red-400 hover:bg-red-400/10 transition-all disabled:opacity-30"
                                title="Delete"
                              >
                                {deleting === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                              </button>
                            </div>
                          </div>
                          {item.description && (
                            <p className="text-[11px] font-mono text-[#4B5563] leading-relaxed mt-1">
                              {item.description}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {colItems.length === 0 && addingTo !== col.status && (
                    <div className="rounded-lg border border-dashed border-[#1A1A1A] p-4 text-center">
                      <p className="text-[11px] font-mono text-[#2D3748]">No items</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
