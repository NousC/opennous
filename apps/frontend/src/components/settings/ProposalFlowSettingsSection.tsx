import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileText,
  Plus,
  Trash2,
  Loader2,
  PenLine,
  Save,
} from "lucide-react";

interface LegalDocConfig {
  id: string;
  name: string;
  template_id: string;
}

interface ProposalFlowConfig {
  landing_page: {
    enabled: boolean;
    message: string;
    video_url: string;
    button_text: string;
  };
  post_signature: {
    enabled: boolean;
    message: string;
    video_url: string;
    meeting_url: string;
    meeting_label: string;
  };
  invoice: {
    enabled: boolean;
  };
  legal_documents: LegalDocConfig[];
  auto_sign: {
    enabled: boolean;
  };
}

const DEFAULT_CONFIG: ProposalFlowConfig = {
  landing_page: {
    enabled: false,
    message: "Hey {{clientName}}, we've put together a proposal just for you. We're excited to share it — take a look and don't hesitate to reach out if you have any questions.",
    video_url: "",
    button_text: "Open Proposal",
  },
  post_signature: {
    enabled: true,
    message: "Welcome aboard, {{clientName}}! We're thrilled to get started with you. Below you'll find everything you need — your invoice, any documents to review, and a link to book a call if you'd like to run through the next steps together.",
    video_url: "",
    meeting_url: "",
    meeting_label: "Book a Call",
  },
  invoice: { enabled: false },
  legal_documents: [],
  auto_sign: { enabled: false },
};

interface WorkspaceTemplate {
  id: string;
  name: string;
  type: string;
}

export function ProposalFlowSettingsSection() {
  const { userData, session } = useAuth();
  const [config, setConfig] = useState<ProposalFlowConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<WorkspaceTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [signatureText, setSignatureText] = useState("");
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const [savingSignature, setSavingSignature] = useState(false);

  const workspaceId = userData?.workspace?.id || localStorage.getItem("selectedWorkspaceId");
  const apiUrl = import.meta.env.VITE_API_URL ?? "";

  useEffect(() => {
    if (workspaceId && session?.access_token) {
      fetchConfig();
      fetchTemplates();
      fetchDefaultSignature();
    }
  }, [workspaceId, session?.access_token]);

  const fetchDefaultSignature = async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch(`${apiUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.user?.default_signature) {
          setSavedSignature(data.user.default_signature);
          if (data.user.default_signature_type === "type") {
            setSignatureText(data.user.default_signature);
          }
        }
      }
    } catch { /* non-critical */ }
  };

  const saveSignature = async () => {
    if (!session?.access_token || !signatureText.trim()) return;
    setSavingSignature(true);
    try {
      const svgSignature = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="60"><text x="10" y="40" font-family="cursive, serif" font-size="28" fill="#1a1a1a">${signatureText.trim().replace(/[<>&"']/g, '')}</text></svg>`;
      const signatureData = `data:image/svg+xml;base64,${btoa(svgSignature)}`;
      const res = await fetch(`${apiUrl}/api/users/me/default-signature`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ default_signature: signatureData, default_signature_type: "type" }),
      });
      if (!res.ok) throw new Error("Failed");
      setSavedSignature(signatureData);
      toast.success("Signature saved");
    } catch {
      toast.error("Failed to save signature");
    } finally {
      setSavingSignature(false);
    }
  };

  const fetchConfig = async () => {
    if (!workspaceId || !session?.access_token) return;
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/workspaces/${workspaceId}/settings/proposal-flow`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.proposal_flow_config && Object.keys(data.proposal_flow_config).length > 0) {
          const saved = data.proposal_flow_config;
          setConfig({
            ...DEFAULT_CONFIG,
            ...saved,
            landing_page: {
              ...DEFAULT_CONFIG.landing_page,
              ...saved.landing_page,
              message: saved.landing_page?.message || DEFAULT_CONFIG.landing_page.message,
            },
            post_signature: {
              ...DEFAULT_CONFIG.post_signature,
              ...saved.post_signature,
              message: saved.post_signature?.message || DEFAULT_CONFIG.post_signature.message,
            },
          });
        }
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  };

  const fetchTemplates = async () => {
    if (!workspaceId || !session?.access_token) return;
    setLoadingTemplates(true);
    try {
      const res = await fetch(`${apiUrl}/api/templates?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        // Only show contract/agreement templates — not proposals, whitepapers, assets or audits
        const LEGAL_TYPES = ["contract", "agreement"];
        const legal = (data.templates || []).filter(
          (t: WorkspaceTemplate) => LEGAL_TYPES.includes(t.type)
        );
        setTemplates(legal);
      }
    } catch {
      // silently fail
    } finally {
      setLoadingTemplates(false);
    }
  };

  const save = async () => {
    if (!workspaceId || !session?.access_token) return;
    setSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/workspaces/${workspaceId}/settings/proposal-flow`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ proposal_flow_config: config }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success("Proposal flow saved");
    } catch {
      toast.error("Failed to save proposal flow");
    } finally {
      setSaving(false);
    }
  };

  const addLegalDoc = () => {
    const newDoc: LegalDocConfig = {
      id: `legal-${Date.now()}`,
      name: "",
      template_id: "",
    };
    setConfig((c) => ({ ...c, legal_documents: [...c.legal_documents, newDoc] }));
  };

  const updateLegalDoc = (id: string, templateId: string) => {
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) return;
    setConfig((c) => ({
      ...c,
      legal_documents: c.legal_documents.map((d) =>
        d.id === id ? { ...d, template_id: templateId, name: tpl.name } : d
      ),
    }));
  };

  const removeLegalDoc = (id: string) => {
    setConfig((c) => ({
      ...c,
      legal_documents: c.legal_documents.filter((d) => d.id !== id),
    }));
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold">Digital Sales Room</h1>
          <p className="text-sm text-muted-foreground">Customise what your prospect sees before and after signing.</p>
        </div>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading proposal flow settings...
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-lg font-semibold">Digital Sales Room</h1>
        <p className="text-sm text-muted-foreground">Customise what your prospect sees before and after signing.</p>
      </div>

      {/* ===== Card A: Landing Page ===== */}
      <Card className="p-5">
        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="font-medium">Welcome Screen</h2>
            <p className="text-xs text-muted-foreground mt-0.5">First thing your prospect sees before the proposal opens</p>
          </div>
          <Switch
            checked={config.landing_page.enabled}
            onCheckedChange={(v) =>
              setConfig((c) => ({ ...c, landing_page: { ...c.landing_page, enabled: v } }))
            }
          />
        </div>

        {config.landing_page.enabled && (
          <div className="space-y-4 mt-5 pt-5 border-t">
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Message</Label>
              <Textarea
                value={config.landing_page.message}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, landing_page: { ...c.landing_page, message: e.target.value } }))
                }
                className="text-sm resize-none"
                rows={3}
              />
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Use <code className="bg-muted px-1 rounded text-[10px]">{"{{clientName}}"}</code> and <code className="bg-muted px-1 rounded text-[10px]">{"{{documentName}}"}</code> as variables
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">
                  Video URL <span className="text-muted-foreground/50">(optional)</span>
                </Label>
                <Input
                  placeholder="YouTube, Vimeo or Loom URL"
                  value={config.landing_page.video_url}
                  onChange={(e) =>
                    setConfig((c) => ({ ...c, landing_page: { ...c.landing_page, video_url: e.target.value } }))
                  }
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Button Text</Label>
                <Input
                  placeholder="Open Proposal"
                  value={config.landing_page.button_text}
                  onChange={(e) =>
                    setConfig((c) => ({ ...c, landing_page: { ...c.landing_page, button_text: e.target.value } }))
                  }
                  className="h-9 text-sm"
                />
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* ===== Card C: Post-Signature Page ===== */}
      <Card className="p-5">
        <div className="mb-5">
          <h2 className="font-medium">Next Steps</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Shown to your prospect right after they sign</p>
        </div>

        <div className="space-y-5">
          {/* Welcome message */}
          <div>
            <Label className="text-xs text-muted-foreground mb-1.5 block">Welcome message</Label>
            <Textarea
              value={config.post_signature.message}
              onChange={(e) =>
                setConfig((c) => ({ ...c, post_signature: { ...c.post_signature, message: e.target.value } }))
              }
              className="text-sm resize-none"
              rows={3}
            />
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Use <code className="bg-muted px-1 rounded text-[10px]">{"{{clientName}}"}</code> as a variable
            </p>
          </div>

          {/* Booking link */}
          <div className="pt-4 border-t">
            <div className="mb-3">
              <p className="text-sm font-medium">Booking Link <span className="text-xs font-normal text-muted-foreground">(optional)</span></p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Scheduling URL</Label>
                <Input
                  placeholder="Calendly, Cal.com, Acuity..."
                  value={config.post_signature.meeting_url}
                  onChange={(e) =>
                    setConfig((c) => ({ ...c, post_signature: { ...c.post_signature, meeting_url: e.target.value } }))
                  }
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Button Label</Label>
                <Input
                  placeholder="Book a Call"
                  value={config.post_signature.meeting_label}
                  onChange={(e) =>
                    setConfig((c) => ({ ...c, post_signature: { ...c.post_signature, meeting_label: e.target.value } }))
                  }
                  className="h-9 text-sm"
                />
              </div>
            </div>
          </div>

          {/* Invoice */}
          <div className="pt-4 border-t">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {/* Stripe logo */}
                <svg viewBox="0 0 60 25" xmlns="http://www.w3.org/2000/svg" className="h-5 w-auto flex-shrink-0" aria-label="Stripe">
                  <path d="M59.64 14.28h-8.06c.19 1.93 1.6 2.55 3.2 2.55 1.64 0 2.96-.37 4.05-.95v3.32a8.33 8.33 0 0 1-4.56 1.1c-4.01 0-6.83-2.5-6.83-7.48 0-4.19 2.39-7.52 6.3-7.52 3.92 0 5.96 3.28 5.96 7.5 0 .4-.04 1.26-.06 1.48zm-5.92-5.62c-1.03 0-2.17.73-2.17 2.58h4.25c0-1.85-1.07-2.58-2.08-2.58zM40.95 20.3c-1.44 0-2.32-.6-2.9-1.04l-.02 4.63-4.12.87V5.57h3.76l.08 1.02a4.7 4.7 0 0 1 3.23-1.29c2.9 0 5.62 2.6 5.62 7.4 0 5.23-2.7 7.6-5.65 7.6zM40 8.95c-.95 0-1.54.34-1.97.81l.02 6.12c.4.44.98.78 1.95.78 1.52 0 2.54-1.65 2.54-3.87 0-2.15-1.04-3.84-2.54-3.84zM28.24 5.57h4.13v14.44h-4.13V5.57zm0-4.7L32.37 0v3.36l-4.13.88V.87zm-4.32 9.35v9.79H19.8V5.57h3.7l.12 1.22c1-1.77 3.07-1.41 3.62-1.22v3.79c-.52-.17-2.29-.43-3.32.86zm-8.55 4.72c0 2.43 2.6 1.68 3.12 1.46v3.36c-.55.3-1.54.54-2.89.54a4.15 4.15 0 0 1-4.27-4.24l.01-13.17 4.02-.86v3.54h3.14V9.1h-3.13v5.85zm-4.91.7c0 2.97-2.31 4.66-5.73 4.66a11.2 11.2 0 0 1-4.46-.93v-3.93c1.38.75 3.1 1.31 4.46 1.31.92 0 1.53-.24 1.53-1C6.26 13.77 0 14.51 0 9.95 0 7.04 2.28 5.3 5.62 5.3c1.36 0 2.72.2 4.09.75v3.88a9.23 9.23 0 0 0-4.1-1.06c-.86 0-1.44.25-1.44.9 0 1.85 6.29.97 6.29 5.88z" fill="#635BFF"/>
                </svg>
                <div>
                  <p className="text-sm font-medium">Invoice</p>
                  <p className="text-xs text-muted-foreground">Auto-generated from the pricing table via Stripe</p>
                </div>
              </div>
              <Switch
                checked={config.invoice.enabled}
                onCheckedChange={(v) =>
                  setConfig((c) => ({ ...c, invoice: { enabled: v } }))
                }
              />
            </div>
          </div>

          {/* Legal Documents */}
          <div className="pt-4 border-t">
            <div className="mb-3">
              <p className="text-sm font-medium">Legal Documents</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Contracts, NDAs or any agreement — auto-generated from a template at send time
              </p>
            </div>

            {config.legal_documents.length === 0 ? (
              <button
                type="button"
                onClick={addLegalDoc}
                disabled={templates.length === 0 || loadingTemplates}
                className="w-full flex items-center justify-center gap-2 border border-dashed border-border rounded-lg py-4 text-xs text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus className="h-3.5 w-3.5" />
                {loadingTemplates
                  ? "Loading templates…"
                  : templates.length === 0
                  ? "No contract or agreement templates found — create one first"
                  : "Add a legal document"}
              </button>
            ) : (
              <div className="space-y-2">
                {config.legal_documents.map((doc, index) => {
                  const selectedTemplate = templates.find((t) => t.id === doc.template_id);
                  return (
                    <div key={doc.id} className="rounded-lg border border-border bg-muted/20 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Document {index + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeLegalDoc(doc.id)}
                          className="text-muted-foreground/50 hover:text-destructive transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {selectedTemplate ? (
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span className="text-sm font-medium truncate">{selectedTemplate.name}</span>
                            {selectedTemplate.type && selectedTemplate.type !== "proposal" && (
                              <span className="flex-shrink-0 text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded capitalize">
                                {selectedTemplate.type}
                              </span>
                            )}
                          </div>
                        </div>
                      ) : null}

                      <Select
                        value={doc.template_id}
                        onValueChange={(v) => updateLegalDoc(doc.id, v)}
                      >
                        <SelectTrigger className="h-8 text-xs w-full bg-background">
                          <SelectValue placeholder="Select a template…" />
                        </SelectTrigger>
                        <SelectContent>
                          {templates.map((t) => (
                            <SelectItem key={t.id} value={t.id} className="text-xs">
                              <span className="flex items-center gap-2">
                                {t.name}
                                {t.type && (
                                  <span className="text-[10px] text-muted-foreground capitalize">
                                    {t.type}
                                  </span>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={addLegalDoc}
                  disabled={templates.length === 0}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 px-1 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="h-3 w-3" />
                  Add another document
                </button>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* ===== Auto-Sign ===== */}
      <Card className="p-5">
        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="font-medium">Auto-Sign</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Automatically sign proposals and legal documents with your saved signature when sending
            </p>
          </div>
          <Switch
            checked={config.auto_sign?.enabled || false}
            onCheckedChange={(v) =>
              setConfig((c) => ({ ...c, auto_sign: { enabled: v } }))
            }
          />
        </div>

        {config.auto_sign?.enabled && (
          <div className="mt-5 pt-5 border-t space-y-3">
            <Label className="text-xs text-muted-foreground block">Your signature</Label>
            <div className="flex gap-2">
              <Input
                placeholder="Type your full name"
                value={signatureText}
                onChange={(e) => setSignatureText(e.target.value)}
                className="h-9 text-sm flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={saveSignature}
                disabled={savingSignature || !signatureText.trim()}
                className="h-9 px-3 flex-shrink-0"
              >
                {savingSignature ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              </Button>
            </div>
            {savedSignature && (
              <div className="border rounded-lg px-4 py-3 bg-muted/30">
                <p className="text-[11px] text-muted-foreground mb-1.5 flex items-center gap-1">
                  <PenLine className="h-3 w-3" /> Saved signature preview
                </p>
                <p style={{ fontFamily: "cursive, serif", fontSize: "22px", color: "#1a1a1a", lineHeight: 1.3 }}>
                  {signatureText || "Your name"}
                </p>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              This signature will be used to auto-sign your documents. Individual documents can override this in their signing settings.
            </p>
          </div>
        )}
      </Card>

      {/* Save */}
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving} size="sm">
          {saving ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Saving...
            </>
          ) : (
            "Save changes"
          )}
        </Button>
      </div>
    </div>
  );
}
