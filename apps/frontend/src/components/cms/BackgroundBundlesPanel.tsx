import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, Upload, Loader2, Package, Pencil, Layout, ChevronDown } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface BundleAsset {
  id?: string;
  bundle_id?: string;
  asset_type: 'cover' | 'divider' | 'inner' | 'closing';
  position: number;
  image_url: string;
  theme_type: 'dark' | 'light';
  treatment?: string;
}

interface Bundle {
  id: string;
  name: string;
  description: string;
  color_family: string;
  secondary_color: string;
  industry_tags: string[];
  style: string | string[];
  vibe: string[] | null;
  theme: string | null;
  cover_layout: string | null;
  is_active: boolean;
  created_at: string;
  background_bundle_assets: BundleAsset[];
}

const VIBES = [
  { value: 'clean_consultant', label: 'Clean Consultant', desc: 'White base, single accent, crisp typography' },
  { value: 'dark_tech', label: 'Dark Tech', desc: 'Dark backgrounds, neon accents, geometric' },
  { value: 'premium_authority', label: 'Premium Authority', desc: 'Deep rich colors, gold accents, executive' },
  { value: 'bold_creative', label: 'Bold Creative', desc: 'High saturation, expressive, artistic' },
  { value: 'soft_organic', label: 'Soft Organic', desc: 'Earth tones, rounded shapes, warm' },
  { value: 'minimal_mono', label: 'Minimal Mono', desc: 'Near-zero decoration, typography focused' },
  { value: 'vibrant_saas', label: 'Vibrant SaaS', desc: 'Bright gradients, playful, startup energy' },
  { value: 'editorial', label: 'Editorial', desc: 'Magazine-like, serif fonts, muted palette' },
];
const THEMES = ['light', 'dark'];

/** Safely extract a string[] from vibe field — handles nested JSON strings from DB corruption */
function parseVibes(raw: any): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    // Could be an array of clean strings or stringified arrays — flatten
    const flat: string[] = [];
    for (const item of raw) {
      if (typeof item === 'string') {
        // Check if item is itself a JSON array string
        if (item.startsWith('[')) {
          try { flat.push(...parseVibes(JSON.parse(item))); continue; } catch {}
        }
        flat.push(item);
      }
    }
    return [...new Set(flat)]; // deduplicate
  }
  if (typeof raw === 'string') {
    if (raw.startsWith('[')) {
      try { return parseVibes(JSON.parse(raw)); } catch {}
    }
    return [raw];
  }
  return [];
}
const INDUSTRIES = ['agency', 'software', 'consulting', 'startup', 'marketing', 'design', 'technology', 'finance', 'healthcare'];

// Named color presets — admin picks a name, system stores hex for matching
const COLOR_PRESETS = [
  { name: 'Blue', hex: '#3b82f6', family: 'cool' },
  { name: 'Light Blue', hex: '#60a5fa', family: 'cool' },
  { name: 'Navy', hex: '#1e3a5f', family: 'dark' },
  { name: 'Teal', hex: '#14b8a6', family: 'cool' },
  { name: 'Green', hex: '#22c55e', family: 'cool' },
  { name: 'Dark Green', hex: '#166534', family: 'dark' },
  { name: 'Orange', hex: '#f97316', family: 'warm' },
  { name: 'Light Orange', hex: '#fb923c', family: 'warm' },
  { name: 'Red', hex: '#ef4444', family: 'warm' },
  { name: 'Light Red', hex: '#f87171', family: 'warm' },
  { name: 'Pink', hex: '#ec4899', family: 'warm' },
  { name: 'Purple', hex: '#a855f7', family: 'cool' },
  { name: 'Indigo', hex: '#6366f1', family: 'cool' },
  { name: 'Yellow', hex: '#eab308', family: 'vibrant' },
  { name: 'Gold', hex: '#d97706', family: 'warm' },
  { name: 'Coral', hex: '#f97066', family: 'warm' },
  { name: 'Slate', hex: '#64748b', family: 'neutral' },
  { name: 'Gray', hex: '#6b7280', family: 'neutral' },
  { name: 'Charcoal', hex: '#374151', family: 'dark' },
  { name: 'Black', hex: '#1a1a1a', family: 'dark' },
];

// Slots that every bundle should have
const ASSET_SLOTS = [
  { type: 'cover' as const, position: 0, label: 'Cover' },
  { type: 'inner' as const, position: 0, label: 'Inner 1' },
  { type: 'inner' as const, position: 1, label: 'Inner 2' },
  { type: 'inner' as const, position: 2, label: 'Inner 3' },
  { type: 'divider' as const, position: 0, label: 'Divider' },
  { type: 'closing' as const, position: 0, label: 'Closing' },
];

export function BackgroundBundlesPanel() {
  const { session } = useAuth();
  const apiUrl = import.meta.env.VITE_API_URL || '';

  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [editingBundleId, setEditingBundleId] = useState<string | null>(null);
  const [expandedBundleId, setExpandedBundleId] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Inspiration images from background_inspirations table
  const [inspirations, setInspirations] = useState<{ id: string; image_url: string; page_type: string; background_type: string; style: string; title: string }[]>([]);
  const [showInspirationPicker, setShowInspirationPicker] = useState(false);
  const [inspirationPickerTarget, setInspirationPickerTarget] = useState<{ bundleId?: string; slotKey: string; assetType: string; position: number } | null>(null);

  // Create form state
  const [form, setForm] = useState({
    name: '',
    description: '',
    color_family: 'neutral',
    secondary_color: '#3b82f6',
    industry_tags: [] as string[],
    vibe: ['clean_consultant'] as string[],
    theme: 'light',
    styles: ['modern'] as string[],
    cover_layout: '',
    is_active: true,
  });

  // Pending files/URLs for create flow
  const [pendingFiles, setPendingFiles] = useState<Record<string, File>>({});
  const [pendingUrls, setPendingUrls] = useState<Record<string, string>>({});

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<{ bundleId?: string; slotKey: string; assetType: string; position: number } | null>(null);

  const headers = {
    'Authorization': `Bearer ${session?.access_token}`,
    'Content-Type': 'application/json'
  };

  useEffect(() => { loadBundles(); loadInspirations(); }, []);

  async function loadBundles() {
    try {
      setLoading(true);
      const res = await fetch(`${apiUrl}/api/admin/background-bundles`, { headers });
      if (!res.ok) throw new Error('Failed to load bundles');
      const data = await res.json();
      setBundles(data.bundles || []);
    } catch (error: any) {
      toast.error('Failed to load bundles: ' + error.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadInspirations() {
    try {
      const res = await fetch(`${apiUrl}/api/admin/background-inspirations`, { headers });
      if (!res.ok) return;
      const data = await res.json();
      // API returns flat array of inspirations
      const items = Array.isArray(data.inspirations) ? data.inspirations : [];
      setInspirations(items.filter((i: any) => i.image_url && i.active !== false));
    } catch {
      // Non-critical — inspirations are optional
    }
  }

  async function selectInspirationForSlot(imageUrl: string) {
    if (!inspirationPickerTarget) return;
    const { bundleId, slotKey, assetType, position } = inspirationPickerTarget;

    if (bundleId) {
      // Existing bundle — create asset with the inspiration URL directly
      try {
        setUploading(`${bundleId}-${assetType}-${position}` );
        const res = await fetch(`${apiUrl}/api/admin/background-bundles/${bundleId}/assets/from-url`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ image_url: imageUrl, asset_type: assetType, position })
        });
        if (!res.ok) throw new Error('Failed to add inspiration');
        toast.success('Inspiration added');
        loadBundles();
      } catch (error: any) {
        toast.error(error.message);
      } finally {
        setUploading(null);
      }
    } else {
      // Create flow — store URL for later
      setPendingUrls(prev => ({ ...prev, [slotKey]: imageUrl }));
    }

    setShowInspirationPicker(false);
    setInspirationPickerTarget(null);
  }

  async function createBundle() {
    try {
      setSaving(true);

      // 1. Create the bundle
      const res = await fetch(`${apiUrl}/api/admin/background-bundles`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...form, style: form.styles, vibe: form.vibe, theme: form.theme, cover_layout: form.cover_layout || null })
      });
      if (!res.ok) throw new Error('Failed to create bundle');
      const data = await res.json();
      const bundleId = data.bundle.id;

      // 2. Upload any pending files
      const fileEntries = Object.entries(pendingFiles);
      const urlEntries = Object.entries(pendingUrls);
      const totalAssets = fileEntries.length + urlEntries.length;
      if (totalAssets > 0) {
        toast.info(`Adding ${totalAssets} images...`);
        for (const [slotKey, file] of fileEntries) {
          const [assetType, posStr] = slotKey.split('-');
          await uploadAsset(bundleId, assetType, parseInt(posStr), file);
        }
        // Add inspiration URL assets
        for (const [slotKey, imageUrl] of urlEntries) {
          const [assetType, posStr] = slotKey.split('-');
          await fetch(`${apiUrl}/api/admin/background-bundles/${bundleId}/assets/from-url`, {
            method: 'POST', headers,
            body: JSON.stringify({ image_url: imageUrl, asset_type: assetType, position: parseInt(posStr) })
          });
        }
      }

      toast.success('Bundle created');
      setShowCreateDialog(false);
      resetForm();
      loadBundles();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function updateBundle(bundleId: string, updates: Partial<Bundle>) {
    try {
      const res = await fetch(`${apiUrl}/api/admin/background-bundles/${bundleId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(updates)
      });
      if (!res.ok) throw new Error('Failed to update');
      loadBundles();
    } catch (error: any) {
      toast.error(error.message);
    }
  }

  async function deleteBundle(bundleId: string) {
    try {
      const res = await fetch(`${apiUrl}/api/admin/background-bundles/${bundleId}`, {
        method: 'DELETE',
        headers
      });
      if (!res.ok) throw new Error('Failed to delete');
      toast.success('Bundle deleted');
      setDeleteTarget(null);
      loadBundles();
    } catch (error: any) {
      toast.error(error.message);
    }
  }

  async function uploadAsset(bundleId: string, assetType: string, position: number, file: File) {
    const uKey = `${bundleId}-${assetType}-${position}`;
    try {
      setUploading(uKey);
      const formData = new FormData();
      formData.append('image', file);
      formData.append('asset_type', assetType);
      formData.append('position', String(position));

      const res = await fetch(`${apiUrl}/api/admin/background-bundles/${bundleId}/assets`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session?.access_token}` },
        body: formData
      });
      if (!res.ok) throw new Error('Upload failed');
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setUploading(null);
    }
  }

  async function deleteAsset(assetId: string) {
    try {
      await fetch(`${apiUrl}/api/admin/background-bundles/assets/${assetId}`, {
        method: 'DELETE',
        headers
      });
      loadBundles();
    } catch (error: any) {
      toast.error(error.message);
    }
  }

  function resetForm() {
    setForm({ name: '', description: '', color_family: 'neutral', secondary_color: '#3b82f6', industry_tags: [], vibe: ['clean_consultant'], theme: 'light', styles: ['modern'], cover_layout: '', is_active: true });
    setPendingFiles({});
    setPendingUrls({});
  }

  function toggleIndustryTag(tag: string) {
    setForm(prev => ({
      ...prev,
      industry_tags: prev.industry_tags.includes(tag)
        ? prev.industry_tags.filter(t => t !== tag)
        : [...prev.industry_tags, tag]
    }));
  }

  function toggleStyle(s: string) {
    setForm(prev => ({
      ...prev,
      styles: prev.styles.includes(s)
        ? prev.styles.filter(t => t !== s)
        : [...prev.styles, s]
    }));
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !uploadTarget) return;

    if (uploadTarget.bundleId) {
      // Existing bundle — upload immediately
      uploadAsset(uploadTarget.bundleId, uploadTarget.assetType, uploadTarget.position, file).then(() => loadBundles());
    } else {
      // Create flow — store file for later upload
      setPendingFiles(prev => ({ ...prev, [uploadTarget.slotKey]: file }));
    }
    setUploadTarget(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function triggerFileUpload(bundleId: string | undefined, slotKey: string, assetType: string, position: number) {
    setUploadTarget({ bundleId, slotKey, assetType, position });
    // Small delay to ensure state is set before file dialog opens
    setTimeout(() => fileInputRef.current?.click(), 0);
  }

  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null);

  function getSlotKey(type: string, position: number) {
    return `${type}-${position}`;
  }

  function handleFileDrop(file: File, slotKey: string, bundleId?: string, assetType?: string, position?: number) {
    if (!file.type.startsWith('image/')) {
      toast.error('Only image files are allowed');
      return;
    }
    if (bundleId && assetType !== undefined && position !== undefined) {
      uploadAsset(bundleId, assetType, position, file).then(() => loadBundles());
    } else {
      setPendingFiles(prev => ({ ...prev, [slotKey]: file }));
    }
  }

  function renderAssetSlot(slot: typeof ASSET_SLOTS[0], bundleId?: string, assets?: BundleAsset[]) {
    // Use slotKey for pending files (no bundleId prefix — shared across create flow)
    const slotKey = getSlotKey(slot.type, slot.position);
    // Use uniqueKey for UI state (drag, uploading) — scoped to bundle
    const scopeId = bundleId || '_new';
    const uniqueKey = `${scopeId}-${slotKey}`;
    const asset = assets?.find(a => a.asset_type === slot.type && a.position === slot.position);
    const pendingFile = bundleId ? undefined : pendingFiles[slotKey];
    const pendingUrl = bundleId ? undefined : pendingUrls[slotKey];
    const isUploading = uploading === uniqueKey;
    const previewUrl = pendingFile ? URL.createObjectURL(pendingFile) : (pendingUrl || asset?.image_url);
    const isDragOver = dragOverSlot === uniqueKey;

    return (
      <div key={uniqueKey} className="relative group">
        <div
          className={`aspect-[3/4] rounded-lg border-2 border-dashed flex items-center justify-center cursor-pointer transition-all overflow-hidden ${
            isDragOver ? 'border-primary bg-primary/10 scale-105' :
            previewUrl ? 'border-solid border-border hover:border-primary/50' : 'border-muted-foreground/20 bg-muted/30 hover:border-primary/50'
          }`}
          onClick={() => triggerFileUpload(bundleId, slotKey, slot.type, slot.position)}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverSlot(uniqueKey); }}
          onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverSlot(uniqueKey); }}
          onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverSlot(null); }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOverSlot(null);
            const file = e.dataTransfer.files?.[0];
            if (file) handleFileDrop(file, slotKey, bundleId, slot.type, slot.position);
          }}
        >
          {isUploading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : isDragOver ? (
            <div className="flex flex-col items-center gap-1 text-primary">
              <Upload className="h-5 w-5" />
              <span className="text-[9px] font-medium">Drop here</span>
            </div>
          ) : previewUrl ? (
            <img src={previewUrl} alt={slot.label} className="w-full h-full object-cover" />
          ) : (
            <div className="flex flex-col items-center gap-1 text-muted-foreground/40">
              <Upload className="h-4 w-4" />
              <span className="text-[9px]">Drop or click</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-center gap-1 mt-1">
          <span className="text-[10px] text-muted-foreground font-medium">{slot.label}</span>
          {!previewUrl && inspirations.length > 0 && (
            <button
              className="text-[9px] text-primary hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                setInspirationPickerTarget({ bundleId, slotKey: slotKey, assetType: slot.type, position: slot.position });
                setShowInspirationPicker(true);
              }}
            >
              browse
            </button>
          )}
        </div>
        {asset && bundleId && (
          <button
            className={`mt-0.5 mx-auto block text-[9px] px-1.5 py-0.5 rounded ${
              asset.theme_type === 'dark' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-800'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              const newType = asset.theme_type === 'dark' ? 'light' : 'dark';
              fetch(`${apiUrl}/api/admin/background-bundles/assets/${asset.id}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ theme_type: newType })
              }).then(() => loadBundles());
            }}
          >
            {asset.theme_type === 'dark' ? '🌙 dark' : '☀️ light'}
          </button>
        )}
        {(asset || pendingFile || pendingUrl) && (
          <button
            className="absolute -top-1.5 -right-1.5 bg-destructive text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
            onClick={(e) => {
              e.stopPropagation();
              if (asset?.id) {
                deleteAsset(asset.id);
              } else if (pendingFile) {
                setPendingFiles(prev => { const next = { ...prev }; delete next[slotKey]; return next; });
              } else if (pendingUrl) {
                setPendingUrls(prev => { const next = { ...prev }; delete next[slotKey]; return next; });
              }
            }}
          >
            x
          </button>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Background Bundles</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Pre-curated visual packages. Each bundle contains cover, inner page variants, divider, and closing backgrounds.
          </p>
        </div>
        <Button onClick={() => { resetForm(); setShowCreateDialog(true); }} className="gap-2">
          <Plus className="h-4 w-4" />
          New Bundle
        </Button>
      </div>

      {/* Bundle List */}
      {bundles.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Package className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No bundles yet. Create your first background bundle.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {bundles.map(bundle => (
            <Card key={bundle.id} className={`transition-all ${!bundle.is_active ? 'opacity-40' : ''}`}>
              <CardHeader className="pb-3 cursor-pointer" onClick={() => setExpandedBundleId(expandedBundleId === bundle.id ? null : bundle.id)}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${expandedBundleId === bundle.id ? '' : '-rotate-90'}`} />
                    <div className="w-5 h-5 rounded-full border shadow-sm" style={{ backgroundColor: bundle.secondary_color || '#3b82f6' }} />
                    <CardTitle className="text-base">{bundle.name}</CardTitle>
                    <div className="flex gap-1">
                      {parseVibes(bundle.vibe).map(v => (
                        <Badge key={v} variant="default" className="text-[10px] bg-violet-100 text-violet-700 border-violet-200">
                          {VIBES.find(vb => vb.value === v)?.label || v}
                        </Badge>
                      ))}
                      {bundle.theme && (
                        <Badge variant="outline" className="text-[10px]">
                          {bundle.theme}
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[10px]">
                        {COLOR_PRESETS.find(c => c.hex === bundle.secondary_color)?.name || bundle.color_family}
                      </Badge>
                      {bundle.industry_tags?.map(tag => (
                        <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => {
                        setEditingBundleId(editingBundleId === bundle.id ? null : bundle.id);
                        if (expandedBundleId !== bundle.id) setExpandedBundleId(bundle.id);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Switch
                      checked={bundle.is_active}
                      onCheckedChange={(checked) => updateBundle(bundle.id, { is_active: checked } as any)}
                    />
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteTarget(bundle.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              {expandedBundleId === bundle.id && (
              <CardContent className="pt-0 space-y-3">
                {/* Inline edit panel */}
                {editingBundleId === bundle.id && (
                  <div className="border rounded-lg p-3 space-y-3 bg-muted/30">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Name</Label>
                        <Input
                          defaultValue={bundle.name}
                          className="h-8 text-sm"
                          onBlur={(e) => { if (e.target.value !== bundle.name) updateBundle(bundle.id, { name: e.target.value } as any); }}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Color</Label>
                        <div className="flex gap-1 flex-wrap mt-1">
                          {COLOR_PRESETS.map(color => (
                            <button
                              key={color.name}
                              type="button"
                              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-all ${
                                bundle.secondary_color === color.hex ? 'bg-primary/10 ring-1 ring-primary font-medium' : 'hover:bg-muted'
                              }`}
                              onClick={() => updateBundle(bundle.id, { secondary_color: color.hex, color_family: color.family } as any)}
                            >
                              <div className="w-2.5 h-2.5 rounded-full border" style={{ backgroundColor: color.hex }} />
                              {color.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">Vibes</Label>
                      <div className="flex gap-1 flex-wrap mt-1">
                        {VIBES.map(v => {
                          const currentVibes = parseVibes(bundle.vibe);
                          const isActive = currentVibes.includes(v.value);
                          return (
                            <Badge
                              key={v.value}
                              variant={isActive ? 'default' : 'outline'}
                              className="cursor-pointer text-[10px]"
                              title={v.desc}
                              onClick={() => {
                                const updated = isActive
                                  ? currentVibes.filter(x => x !== v.value)
                                  : [...currentVibes, v.value];
                                updateBundle(bundle.id, { vibe: updated } as any);
                              }}
                            >
                              {v.label}
                            </Badge>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">Theme</Label>
                      <div className="flex gap-1 flex-wrap mt-1">
                        {THEMES.map(t => (
                          <Badge
                            key={t}
                            variant={bundle.theme === t ? 'default' : 'outline'}
                            className="cursor-pointer text-[10px]"
                            onClick={() => updateBundle(bundle.id, { theme: t } as any)}
                          >
                            {t}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">Industry Tags</Label>
                      <div className="flex gap-1 flex-wrap mt-1">
                        {INDUSTRIES.map(tag => {
                          const isActive = bundle.industry_tags?.includes(tag);
                          return (
                            <Badge
                              key={tag}
                              variant={isActive ? 'default' : 'outline'}
                              className="cursor-pointer text-[10px]"
                              onClick={() => {
                                const updated = isActive
                                  ? (bundle.industry_tags || []).filter(t => t !== tag)
                                  : [...(bundle.industry_tags || []), tag];
                                updateBundle(bundle.id, { industry_tags: updated } as any);
                              }}
                            >
                              {tag}
                            </Badge>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs flex items-center gap-1.5">
                        <Layout className="h-3 w-3" />
                        Cover Page Layout
                      </Label>
                      <Textarea
                        defaultValue={bundle.cover_layout || ''}
                        placeholder={`Paste cover layout template here, e.g.:\n\n<center>\n\n:::title size="44px"\n{{projectTitle}}\n:::\n\n# Proposal for {{clientCompany}}\n\n:::spacer height="160px"\n:::\n\n**Prepared for**\n{{clientFirstName}} {{clientLastName}}\n\n**Prepared by**\n{{senderFirstName}} {{senderLastName}}\n\n</center>`}
                        className="mt-1 text-xs font-mono min-h-[120px]"
                        onBlur={(e) => {
                          const val = e.target.value.trim();
                          if (val !== (bundle.cover_layout || '')) {
                            updateBundle(bundle.id, { cover_layout: val || null } as any);
                          }
                        }}
                      />
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Uses same syntax as layout gallery. Available: :::title, :::spacer, {'{{variables}}'}, #/## headings, **bold**, :::columns
                      </p>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-6 gap-3">
                  {ASSET_SLOTS.map(slot => renderAssetSlot(slot, bundle.id, bundle.background_bundle_assets))}
                </div>
              </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Create Bundle Dialog — with immediate image upload slots */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Background Bundle</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-2">
            {/* Basic info */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Name</Label>
                <Input value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))} placeholder="e.g., Warm Orange — Agency" />
              </div>
              <div>
                <Label>Description</Label>
                <Input value={form.description} onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))} placeholder="Brief description" />
              </div>
            </div>

            {/* Color + Style */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Color</Label>
                <div className="flex gap-1.5 flex-wrap mt-1.5 p-2 border rounded-md max-h-[120px] overflow-y-auto">
                  {COLOR_PRESETS.map(color => (
                    <button
                      key={color.name}
                      type="button"
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-all ${
                        form.secondary_color === color.hex
                          ? 'bg-primary/10 ring-2 ring-primary font-medium'
                          : 'hover:bg-muted'
                      }`}
                      onClick={() => setForm(prev => ({
                        ...prev,
                        secondary_color: color.hex,
                        color_family: color.family
                      }))}
                    >
                      <div className="w-3.5 h-3.5 rounded-full border shadow-sm shrink-0" style={{ backgroundColor: color.hex }} />
                      {color.name}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label>Vibes</Label>
                <div className="flex gap-1.5 flex-wrap mt-1.5">
                  {VIBES.map(v => (
                    <Badge
                      key={v.value}
                      variant={form.vibe.includes(v.value) ? 'default' : 'outline'}
                      className="cursor-pointer text-xs"
                      title={v.desc}
                      onClick={() => setForm(prev => ({
                        ...prev,
                        vibe: prev.vibe.includes(v.value)
                          ? prev.vibe.filter(x => x !== v.value)
                          : [...prev.vibe, v.value]
                      }))}
                    >
                      {v.label}
                    </Badge>
                  ))}
                </div>
              </div>
              <div>
                <Label>Theme</Label>
                <div className="flex gap-1.5 flex-wrap mt-1.5">
                  {THEMES.map(t => (
                    <Badge
                      key={t}
                      variant={form.theme === t ? 'default' : 'outline'}
                      className="cursor-pointer text-xs"
                      onClick={() => setForm(prev => ({ ...prev, theme: t }))}
                    >
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>

            {/* Industry tags */}
            <div>
              <Label>Industry Tags</Label>
              <div className="flex gap-1.5 flex-wrap mt-1.5">
                {INDUSTRIES.map(tag => (
                  <Badge
                    key={tag}
                    variant={form.industry_tags.includes(tag) ? 'default' : 'outline'}
                    className="cursor-pointer text-xs"
                    onClick={() => toggleIndustryTag(tag)}
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Cover Layout */}
            <div>
              <Label className="flex items-center gap-1.5"><Layout className="h-3.5 w-3.5" /> Cover Page Layout</Label>
              <Textarea
                value={form.cover_layout}
                onChange={(e) => setForm(prev => ({ ...prev, cover_layout: e.target.value }))}
                placeholder={`Optional — define cover page structure:\n\n<center>\n:::title size="44px"\n{{projectTitle}}\n:::\n# Proposal for {{clientCompany}}\n:::spacer height="160px"\n:::\n**Prepared for**\n{{clientFirstName}} {{clientLastName}}\n</center>`}
                className="mt-1 text-xs font-mono min-h-[100px]"
              />
              <p className="text-[10px] text-muted-foreground mt-1">Leave empty to use default cover layouts. Uses layout gallery syntax.</p>
            </div>

            {/* Image upload slots */}
            <div>
              <Label className="mb-2 block">Background Images</Label>
              <div className="grid grid-cols-6 gap-3">
                {ASSET_SLOTS.map(slot => renderAssetSlot(slot))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">Click each slot to upload. Cover is required, inner pages recommended. You can add more after creation.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
            <Button onClick={createBundle} disabled={!form.name || saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Create Bundle {Object.keys(pendingFiles).length > 0 && `(${Object.keys(pendingFiles).length} images)`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Inspiration Picker Dialog */}
      <Dialog open={showInspirationPicker} onOpenChange={setShowInspirationPicker}>
        <DialogContent className="max-w-5xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Select from Inspirations ({inspirations.length} images)</DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto max-h-[70vh] grid grid-cols-3 gap-4 p-2">
            {inspirations.length === 0 ? (
              <p className="col-span-3 text-center text-muted-foreground py-8">No inspiration images available</p>
            ) : (
              inspirations.map(insp => (
                <div
                  key={insp.id}
                  className="cursor-pointer rounded-xl overflow-hidden border-2 border-transparent hover:border-primary hover:shadow-lg transition-all"
                  onClick={() => selectInspirationForSlot(insp.image_url)}
                  style={{
                    height: '240px',
                    backgroundImage: `url(${insp.image_url})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    backgroundColor: '#e5e7eb',
                    position: 'relative'
                  }}
                >
                  <div style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    padding: '24px 12px 10px',
                    background: 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.3) 60%, transparent 100%)'
                  }}>
                    <div style={{ fontSize: '12px', color: 'white', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {insp.title || insp.background_type || 'Untitled'}
                    </div>
                    <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', marginTop: '2px' }}>
                      {insp.page_type} &middot; {insp.style || 'any'}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Bundle</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete this bundle and all its assets.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteTarget && deleteBundle(deleteTarget)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
