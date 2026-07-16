import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, Trash2, ExternalLink, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/components/ui/sonner";

type ResourceType = "repo" | "video" | "paper" | "docs" | "guide";

interface Resource {
  id: string;
  title: string;
  url: string;
  type: ResourceType;
  description: string | null;
  thumbnail_url: string | null;
  sort_order: number;
  published: boolean;
  created_at: string;
}

const TYPES: { value: ResourceType; label: string }[] = [
  { value: "repo", label: "Repository" },
  { value: "video", label: "Video" },
  { value: "paper", label: "Paper" },
  { value: "docs", label: "Docs" },
  { value: "guide", label: "Guide" },
];

interface FormState {
  url: string;
  title: string;
  type: ResourceType;
  description: string;
  thumbnail_url: string;
  sort_order: number;
  published: boolean;
}

const EMPTY_FORM: FormState = {
  url: "",
  title: "",
  type: "docs",
  description: "",
  thumbnail_url: "",
  sort_order: 0,
  published: true,
};

export default function AdminResources() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const apiUrl = import.meta.env.VITE_API_URL ?? "";

  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [unfurling, setUnfurling] = useState(false);

  const authHeaders = useCallback(
    () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token}`,
    }),
    [session],
  );

  const loadResources = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/admin/resources/links`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setResources(data.resources || []);
    } catch (err: any) {
      toast.error(err.message || "Failed to load resources");
    } finally {
      setLoading(false);
    }
  }, [session, apiUrl]);

  useEffect(() => {
    loadResources();
  }, [loadResources]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const handleUnfurl = async () => {
    if (!form.url.trim()) {
      toast.error("Paste a URL first");
      return;
    }
    setUnfurling(true);
    try {
      const res = await fetch(`${apiUrl}/api/admin/resources/unfurl`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ url: form.url.trim() }),
      });
      if (!res.ok) throw new Error("Could not read that URL");
      const data = await res.json();
      setForm((prev) => ({
        ...prev,
        title: data.title || prev.title,
        description: data.description || prev.description,
        thumbnail_url: data.image || prev.thumbnail_url,
        type: (data.type as ResourceType) || prev.type,
      }));
      toast.success("Details fetched — review and save");
    } catch (err: any) {
      toast.error(err.message || "Unfurl failed — fill the fields manually");
    } finally {
      setUnfurling(false);
    }
  };

  const handleSave = async () => {
    if (!form.title.trim() || !form.url.trim()) {
      toast.error("Title and URL are required");
      return;
    }
    setSaving(true);
    try {
      const endpoint = editingId
        ? `${apiUrl}/api/admin/resources/links/${editingId}`
        : `${apiUrl}/api/admin/resources/links`;
      const res = await fetch(endpoint, {
        method: editingId ? "PATCH" : "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          title: form.title.trim(),
          url: form.url.trim(),
          type: form.type,
          description: form.description.trim() || null,
          thumbnail_url: form.thumbnail_url.trim() || null,
          sort_order: Number(form.sort_order) || 0,
          published: form.published,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success(editingId ? "Resource updated" : "Resource added");
      resetForm();
      await loadResources();
    } catch (err: any) {
      toast.error(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (r: Resource) => {
    setEditingId(r.id);
    setForm({
      url: r.url,
      title: r.title,
      type: r.type,
      description: r.description || "",
      thumbnail_url: r.thumbnail_url || "",
      sort_order: r.sort_order,
      published: r.published,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this resource?")) return;
    try {
      const res = await fetch(`${apiUrl}/api/admin/resources/links/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (!res.ok) throw new Error("Failed to delete");
      toast.success("Resource deleted");
      if (editingId === id) resetForm();
      await loadResources();
    } catch (err: any) {
      toast.error(err.message || "Failed to delete");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Button variant="ghost" size="icon" onClick={() => navigate("/admin/cms")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">Resources</h1>
            <p className="text-sm text-muted-foreground">
              Curated links for the Coffee Shop hub — repos, videos, papers, docs.
            </p>
          </div>
        </div>

        {/* Form */}
        <div className="rounded-xl border border-border p-5 mb-8 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">
              {editingId ? "Edit resource" : "Add a resource"}
            </h2>
            {editingId && (
              <Button variant="ghost" size="sm" onClick={resetForm}>
                <Plus className="h-3.5 w-3.5 mr-1" /> New
              </Button>
            )}
          </div>

          {/* URL + unfurl */}
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">URL</Label>
            <div className="flex gap-2">
              <Input
                placeholder="https://github.com/... or a YouTube link"
                value={form.url}
                onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={handleUnfurl}
                disabled={unfurling}
                className="shrink-0"
              >
                {unfurling ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-1.5" /> Fetch
                  </>
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste a link and hit Fetch — title, description and image auto-fill.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Title</Label>
            <Input
              value={form.title}
              onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Type</Label>
              <select
                value={form.type}
                onChange={(e) => setForm((p) => ({ ...p, type: e.target.value as ResourceType }))}
                className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Sort order
              </Label>
              <Input
                type="number"
                value={form.sort_order}
                onChange={(e) =>
                  setForm((p) => ({ ...p, sort_order: Number(e.target.value) || 0 }))
                }
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Description
            </Label>
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Thumbnail URL
            </Label>
            <Input
              placeholder="Optional — auto-filled for videos"
              value={form.thumbnail_url}
              onChange={(e) => setForm((p) => ({ ...p, thumbnail_url: e.target.value }))}
            />
            {form.thumbnail_url && (
              <img
                src={form.thumbnail_url}
                alt=""
                className="mt-2 h-24 rounded-md border border-border object-cover"
              />
            )}
          </div>

          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={form.published}
                onChange={(e) => setForm((p) => ({ ...p, published: e.target.checked }))}
              />
              Published (visible on the site)
            </label>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {editingId ? "Update" : "Add resource"}
            </Button>
          </div>
        </div>

        {/* List */}
        <h2 className="text-sm font-medium mb-3">
          All resources {resources.length > 0 && `(${resources.length})`}
        </h2>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : resources.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No resources yet — add your first one above.
          </div>
        ) : (
          <div className="space-y-2">
            {resources.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 rounded-lg border border-border p-3"
              >
                {r.thumbnail_url ? (
                  <img
                    src={r.thumbnail_url}
                    alt=""
                    className="h-12 w-20 rounded object-cover shrink-0"
                  />
                ) : (
                  <div className="h-12 w-20 rounded bg-muted shrink-0 flex items-center justify-center text-[10px] uppercase text-muted-foreground">
                    {r.type}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{r.title}</span>
                    {!r.published && (
                      <span className="text-[10px] uppercase tracking-wide rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                        Draft
                      </span>
                    )}
                  </div>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 truncate"
                  >
                    {r.url} <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
                  {r.type}
                </span>
                <Button variant="ghost" size="sm" onClick={() => handleEdit(r)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(r.id)}
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
