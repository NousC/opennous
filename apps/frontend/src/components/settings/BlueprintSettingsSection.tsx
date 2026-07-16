import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Lock, Loader2, Star, ChevronDown, X, RefreshCw, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// All valid page types with display labels — must stay in sync with server/config/pageTypeDisplay.js
const PAGE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'cover',             label: 'Cover Page' },
  { value: 'foreword',          label: 'Foreword' },
  { value: 'introduction',      label: 'Introduction' },
  { value: 'executive_summary', label: 'Executive Summary' },
  { value: 'problem',           label: 'Problem / Challenge' },
  { value: 'solution',          label: 'Solution' },
  { value: 'scope_of_work',     label: 'Scope of Services' },
  { value: 'timeline',          label: 'Timeline' },
  { value: 'pricing',           label: 'Investment / Pricing' },
  { value: 'testimonials',      label: 'Client Success Stories' },
  { value: 'about',             label: 'About Us' },
  { value: 'team',              label: 'Our Team' },
  { value: 'terms_conditions',  label: 'Terms & Conditions' },
  { value: 'agreement_terms',   label: 'Agreement / Contract' },
  { value: 'signing',           label: 'Signing' },
  { value: 'next_steps',        label: 'Next Steps' },
  { value: 'contact',           label: 'Contact' },
  { value: 'case_study',        label: 'Case Study' },
  { value: 'insights',          label: 'Insights' },
  { value: 'recommendations',   label: 'Recommendations' },
  { value: 'analysis',          label: 'Analysis' },
  { value: 'performance',       label: 'Performance' },
  { value: 'opportunities',     label: 'Opportunities' },
  { value: 'how_it_works',      label: 'How It Works' },
  { value: 'methodology',       label: 'Methodology' },
  { value: 'roadmap',           label: 'Roadmap' },
  { value: 'project_overview',  label: 'Project Overview' },
  { value: 'summary',           label: 'Summary' },
  { value: 'conclusion',        label: 'Conclusion' },
  { value: 'main_content',      label: 'Content (generic)' },
];

interface AgencyTemplate {
  id: string;
  name: string;
  page_count: number;
}

interface PageInfo {
  title: string;
  type: string;
  blockId: string | null;
}

export function BlueprintSettingsSection() {
  const { session, userData } = useAuth();
  const [loading, setLoading] = useState(true);
  const [template, setTemplate] = useState<AgencyTemplate | null>(null);
  const [frozenPageTypes, setFrozenPageTypes] = useState<string[]>([]);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [editingPageIndex, setEditingPageIndex] = useState<number | null>(null);
  const [savingType, setSavingType] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const workspaceId = userData?.workspace?.id;
  const apiUrl = import.meta.env.VITE_API_URL ?? "";

  const loadAgencyTemplate = async () => {
    if (!session?.access_token || !workspaceId) return;
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/workspaces/${workspaceId}/agency-template`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setTemplate(data.template || null);
        setFrozenPageTypes(data.frozen_page_types || []);
        setPages(data.page_types || []);
      }
    } catch (err) {
      console.error("Failed to load agency template:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAgencyTemplate();
  }, [session?.access_token, workspaceId]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setEditingPageIndex(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleToggleFreeze = async (key: string) => {
    if (!session?.access_token || !template) return;
    const newFrozen = frozenPageTypes.includes(key)
      ? frozenPageTypes.filter(t => t !== key)
      : [...frozenPageTypes, key];
    setFrozenPageTypes(newFrozen);
    try {
      await fetch(`${apiUrl}/api/workspaces/${workspaceId}/agency-template/${template.id}/freeze`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ frozen_page_types: newFrozen }),
      });
    } catch {
      toast.error("Failed to update freeze settings");
      setFrozenPageTypes(frozenPageTypes);
    }
  };

  const handleUnstar = async () => {
    if (!session?.access_token || !template || !workspaceId) return;
    try {
      const res = await fetch(`${apiUrl}/api/workspaces/${workspaceId}/agency-template/${template.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        setTemplate(null);
        setFrozenPageTypes([]);
        setPages([]);
        toast.success("Agency template removed");
      }
    } catch {
      toast.error("Failed to remove agency template");
    }
  };

  const handleRepairPageTypes = async () => {
    if (!session?.access_token || !template || !workspaceId) return;
    setRepairing(true);
    try {
      const res = await fetch(
        `${apiUrl}/api/workspaces/${workspaceId}/agency-template/${template.id}/repair-page-types-from-layouts`,
        { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` } }
      );
      const data = await res.json();
      if (res.ok) {
        toast.success(`Fixed ${data.repaired} of ${data.total} page types`);
        await loadAgencyTemplate();
      } else {
        toast.error(data.message || "Failed to repair page types");
      }
    } catch {
      toast.error("Failed to repair page types");
    } finally {
      setRepairing(false);
    }
  };

  const handleSetPageType = async (pageIndex: number, newType: string) => {
    if (!session?.access_token || !template || !workspaceId) return;
    const page = pages[pageIndex];
    if (!page?.blockId) {
      toast.error("Cannot update this page — no block ID found");
      return;
    }
    setSavingType(true);
    try {
      const res = await fetch(
        `${apiUrl}/api/workspaces/${workspaceId}/agency-template/${template.id}/set-page-type`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ blockId: page.blockId, pageType: newType }),
        }
      );
      if (res.ok) {
        toast.success("Page type updated");
        setEditingPageIndex(null);
        await loadAgencyTemplate();
      } else {
        toast.error("Failed to update page type");
      }
    } catch {
      toast.error("Failed to update page type");
    } finally {
      setSavingType(false);
    }
  };

  const frozenCount = pages.filter(p => frozenPageTypes.includes(p.title || p.type || '')).length;

  return (
    <Card className="p-5">
      <h2 className="font-medium mb-1">Agency Template</h2>
      <p className="text-xs text-muted-foreground mb-4">
        Star a template from My Templates to use as the base for Proposal Writer. Frozen pages stay the same across all proposals.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : template ? (
        <div>
          {/* Template info row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <Star className="h-4 w-4 text-amber-500 fill-amber-500 flex-shrink-0" />
              <span className="font-medium text-sm truncate">{template.name}</span>
              <span className="text-xs text-muted-foreground flex-shrink-0">
                {template.page_count || pages.length} pages
              </span>
              {frozenCount > 0 && (
                <span className="text-xs text-muted-foreground flex-shrink-0 flex items-center gap-0.5">
                  · <Lock className="h-2.5 w-2.5" />{frozenCount} frozen
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 ml-2">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setExpanded(!expanded)}>
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
              </Button>
              <Button
                variant="ghost" size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={handleUnstar}
                title="Remove as agency template"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Expandable page list */}
          {expanded && pages.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border" ref={dropdownRef}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Page</span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost" size="sm"
                    className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground gap-1"
                    onClick={handleRepairPageTypes}
                    disabled={repairing}
                    title="Auto-fix page types using layout data"
                  >
                    <RefreshCw className={cn("h-3 w-3", repairing && "animate-spin")} />
                    {repairing ? "Fixing..." : "Fix types"}
                  </Button>
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                    <Lock className="h-2.5 w-2.5" /> Freeze
                  </span>
                </div>
              </div>

              <div className="space-y-0.5">
                {pages.map((page, i) => {
                  const label = page.title || page.type?.replace(/_/g, ' ') || `Page ${i + 1}`;
                  const key = page.title || page.type || `page_${i}`;
                  const isEditing = editingPageIndex === i;

                  return (
                    <div key={key} className="relative">
                      <div className="flex items-center justify-between py-1.5">
                        {/* Clickable page label — opens type picker */}
                        <button
                          className="flex items-center gap-1 text-sm text-left hover:text-primary transition-colors group"
                          onClick={() => setEditingPageIndex(isEditing ? null : i)}
                          title="Click to change page type"
                        >
                          <span>{label}</span>
                          <ChevronRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                        <Switch
                          checked={frozenPageTypes.includes(key)}
                          onCheckedChange={() => handleToggleFreeze(key)}
                          className="scale-75"
                        />
                      </div>

                      {/* Inline type picker dropdown */}
                      {isEditing && (
                        <div className="absolute left-0 top-full z-50 w-56 bg-popover border border-border rounded-md shadow-lg py-1 max-h-64 overflow-y-auto">
                          {PAGE_TYPE_OPTIONS.map(opt => (
                            <button
                              key={opt.value}
                              disabled={savingType}
                              className={cn(
                                "w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors",
                                page.type === opt.value && "font-medium text-primary bg-accent/50"
                              )}
                              onClick={() => handleSetPageType(i, opt.value)}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground py-2">
          No agency template selected. Star a template from <strong>My Templates</strong> to use it as the base for Proposal Writer.
        </p>
      )}
    </Card>
  );
}
