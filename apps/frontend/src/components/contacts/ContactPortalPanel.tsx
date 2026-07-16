import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/useAuth";
import {
  Globe,
  Copy,
  Check,
  Plus,
  Trash2,
  ExternalLink,
  Loader2,
  GripVertical,
  Calendar,
  CheckCircle2,
  Circle,
  Link2,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ContactPortalPanelProps {
  contactId: string;
  workspaceId: string;
}

interface Portal {
  id: string;
  portal_token: string;
  is_active: boolean;
  meeting_url: string | null;
  welcome_message: string | null;
  custom_slug: string | null;
  last_accessed_at: string | null;
  created_at: string;
}

interface TimelineStep {
  id?: string;
  label: string;
  description?: string | null;
  status: "completed" | "current" | "upcoming";
  completed_at?: string | null;
}

interface OnboardingItem {
  id?: string;
  label: string;
  item_type: "checkbox" | "link" | "file";
  url?: string | null;
  is_completed: boolean;
}

const fadeInUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
};

export function ContactPortalPanel({ contactId, workspaceId }: ContactPortalPanelProps) {
  const { session } = useAuth();
  const { toast } = useToast();

  const [portal, setPortal] = useState<Portal | null>(null);
  const [timelineSteps, setTimelineSteps] = useState<TimelineStep[]>([]);
  const [onboardingItems, setOnboardingItems] = useState<OnboardingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [meetingUrl, setMeetingUrl] = useState("");
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [customSlug, setCustomSlug] = useState("");
  const [slugError, setSlugError] = useState("");

  // New step/item inputs
  const [newStepLabel, setNewStepLabel] = useState("");
  const [newItemLabel, setNewItemLabel] = useState("");
  const [newItemType, setNewItemType] = useState<"checkbox" | "link">("checkbox");
  const [newItemUrl, setNewItemUrl] = useState("");

  useEffect(() => {
    loadPortal();
  }, [contactId]);

  const apiUrl = import.meta.env.VITE_API_URL ?? "";
  const headers = {
    Authorization: `Bearer ${session?.access_token}`,
    "Content-Type": "application/json",
  };

  const loadPortal = async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const response = await fetch(`${apiUrl}/api/contacts/${contactId}/portal`, { headers });
      if (response.ok) {
        const data = await response.json();
        setPortal(data.portal);
        setTimelineSteps(data.timeline_steps || []);
        setOnboardingItems(data.onboarding_items || []);
        if (data.portal) {
          setMeetingUrl(data.portal.meeting_url || "");
          setWelcomeMessage(data.portal.welcome_message || "");
          setCustomSlug(data.portal.custom_slug || "");
        }
      }
    } catch (error) {
      console.error("Error loading portal:", error);
    } finally {
      setLoading(false);
    }
  };

  const createPortal = async () => {
    setCreating(true);
    try {
      const response = await fetch(`${apiUrl}/api/contacts/${contactId}/portal`, {
        method: "POST",
        headers,
        body: JSON.stringify({ meeting_url: meetingUrl || null, welcome_message: welcomeMessage || null }),
      });
      if (response.ok) {
        const data = await response.json();
        setPortal(data.portal);
        setTimelineSteps(data.timeline_steps || []);
        setOnboardingItems(data.onboarding_items || []);
        setMeetingUrl(data.portal.meeting_url || "");
        setWelcomeMessage(data.portal.welcome_message || "");
        toast({ title: "Portal created", description: "Client portal is ready to share" });
      }
    } catch (error) {
      console.error("Error creating portal:", error);
      toast({ title: "Error", description: "Failed to create portal", variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    setSlugError("");
    try {
      const response = await fetch(`${apiUrl}/api/contacts/${contactId}/portal`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          meeting_url: meetingUrl || null,
          welcome_message: welcomeMessage || null,
          custom_slug: customSlug || null,
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (err.error === "slug_taken") {
          setSlugError("This link is already taken");
          setSaving(false);
          return;
        }
        if (err.error === "invalid_slug") {
          setSlugError("Only lowercase letters, numbers, and hyphens");
          setSaving(false);
          return;
        }
        if (err.error === "plan_upgrade_required") {
          setSlugError("Custom links require the Professional plan");
          setSaving(false);
          return;
        }
        throw new Error(err.message || "Failed to save");
      }
      const data = await response.json();
      if (data.portal) setPortal(data.portal);
      toast({ title: "Settings saved" });
    } catch {
      toast({ title: "Error", description: "Failed to save", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const saveTimeline = async (steps: TimelineStep[]) => {
    try {
      const response = await fetch(`${apiUrl}/api/contacts/${contactId}/portal/timeline`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ steps }),
      });
      if (response.ok) {
        const data = await response.json();
        setTimelineSteps(data.timeline_steps);
      }
    } catch {
      toast({ title: "Error", description: "Failed to save timeline", variant: "destructive" });
    }
  };

  const saveOnboarding = async (items: OnboardingItem[]) => {
    try {
      const response = await fetch(`${apiUrl}/api/contacts/${contactId}/portal/onboarding`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ items }),
      });
      if (response.ok) {
        const data = await response.json();
        setOnboardingItems(data.onboarding_items);
      }
    } catch {
      toast({ title: "Error", description: "Failed to save onboarding", variant: "destructive" });
    }
  };

  const portalPath = portal?.custom_slug || portal?.portal_token || "";

  const copyPortalLink = () => {
    if (!portal) return;
    const link = `${window.location.origin}/portal/${portalPath}`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const addTimelineStep = () => {
    if (!newStepLabel.trim()) return;
    const updated = [...timelineSteps, { label: newStepLabel.trim(), status: "upcoming" as const }];
    setTimelineSteps(updated);
    setNewStepLabel("");
    saveTimeline(updated);
  };

  const removeTimelineStep = (index: number) => {
    const updated = timelineSteps.filter((_, i) => i !== index);
    setTimelineSteps(updated);
    saveTimeline(updated);
  };

  const cycleStepStatus = (index: number) => {
    const statusOrder: Array<"upcoming" | "current" | "completed"> = ["upcoming", "current", "completed"];
    const step = timelineSteps[index];
    const currentIdx = statusOrder.indexOf(step.status);
    const nextStatus = statusOrder[(currentIdx + 1) % statusOrder.length];
    const updated = timelineSteps.map((s, i) => (i === index ? { ...s, status: nextStatus } : s));
    setTimelineSteps(updated);
    saveTimeline(updated);
  };

  const addOnboardingItem = () => {
    if (!newItemLabel.trim()) return;
    const updated = [
      ...onboardingItems,
      {
        label: newItemLabel.trim(),
        item_type: newItemType,
        url: newItemType === "link" ? newItemUrl || null : null,
        is_completed: false,
      },
    ];
    setOnboardingItems(updated);
    setNewItemLabel("");
    setNewItemUrl("");
    saveOnboarding(updated);
  };

  const removeOnboardingItem = (index: number) => {
    const updated = onboardingItems.filter((_, i) => i !== index);
    setOnboardingItems(updated);
    saveOnboarding(updated);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
      </div>
    );
  }

  // No portal yet — show create button
  if (!portal) {
    return (
      <motion.div
        className="bg-white border-0 rounded-2xl shadow-sm p-6 text-center"
        variants={fadeInUp}
        initial="initial"
        animate="animate"
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <Globe className="w-8 h-8 text-gray-300 mx-auto mb-3" />
        <h3 className="text-[14px] font-semibold text-gray-900 mb-1">Client Portal</h3>
        <p className="text-[12px] text-gray-500 mb-4 max-w-xs mx-auto">
          Create a portal for this contact to view documents, track progress, and complete onboarding.
        </p>
        <button
          onClick={createPortal}
          disabled={creating}
          className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 text-white text-[13px] font-medium rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50"
        >
          {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Create Portal
        </button>
      </motion.div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Portal Link */}
      <motion.div
        className="bg-white border-0 rounded-2xl shadow-sm p-4"
        variants={fadeInUp}
        initial="initial"
        animate="animate"
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-gray-400" />
            <h3 className="text-[13px] font-semibold text-gray-900">Portal Link</h3>
          </div>
          <div className="flex items-center gap-1.5">
            <a
              href={`/portal/${portalPath}`}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 hover:bg-gray-100 rounded-md transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5 text-gray-400" />
            </a>
            <button
              onClick={copyPortalLink}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-[12px] font-medium rounded-md transition-colors"
            >
              {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>

        <div className="bg-gray-50 rounded-lg px-3 py-2 text-[12px] text-gray-500 font-mono truncate">
          {window.location.origin}/portal/{portalPath}
        </div>

        {portal.last_accessed_at && (
          <p className="text-[11px] text-gray-400 mt-2">
            Last viewed {new Date(portal.last_accessed_at).toLocaleDateString("en-US", {
              month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
            })}
          </p>
        )}
      </motion.div>

      {/* Settings */}
      <motion.div
        className="bg-white border-0 rounded-2xl shadow-sm p-4"
        variants={fadeInUp}
        initial="initial"
        animate="animate"
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
      >
        <h3 className="text-[13px] font-semibold text-gray-900 mb-3">Settings</h3>
        <div className="space-y-3">
          <div>
            <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
              Custom Link
            </label>
            <div className="mt-1 flex items-center gap-0">
              <span className="px-2.5 py-2 text-[12px] text-gray-400 bg-gray-50 border border-r-0 border-gray-200 rounded-l-lg whitespace-nowrap">
                /portal/
              </span>
              <input
                type="text"
                value={customSlug}
                onChange={e => {
                  setCustomSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                  setSlugError("");
                }}
                placeholder="sarah-chen"
                className={`flex-1 px-3 py-2 text-[13px] border border-gray-200 rounded-r-lg focus:outline-none focus:ring-1 focus:ring-gray-300 bg-white ${slugError ? "border-red-300" : ""}`}
              />
            </div>
            {slugError && <p className="text-[11px] text-red-500 mt-1">{slugError}</p>}
          </div>
          <div>
            <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
              Meeting URL
            </label>
            <input
              type="url"
              value={meetingUrl}
              onChange={e => setMeetingUrl(e.target.value)}
              placeholder="https://cal.com/your-link"
              className="mt-1 w-full px-3 py-2 text-[13px] border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300 bg-white"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
              Welcome Message
            </label>
            <input
              type="text"
              value={welcomeMessage}
              onChange={e => setWelcomeMessage(e.target.value)}
              placeholder="Here's what needs your attention today"
              className="mt-1 w-full px-3 py-2 text-[13px] border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300 bg-white"
            />
          </div>
          <button
            onClick={saveSettings}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-900 text-white text-[12px] font-medium rounded-md hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            Save
          </button>
        </div>
      </motion.div>

      {/* Timeline Steps */}
      <motion.div
        className="bg-white border-0 rounded-2xl shadow-sm p-4"
        variants={fadeInUp}
        initial="initial"
        animate="animate"
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
      >
        <h3 className="text-[13px] font-semibold text-gray-900 mb-3">Timeline Steps</h3>
        <div className="space-y-1.5 mb-3">
          {timelineSteps.map((step, i) => (
            <div key={step.id || i} className="flex items-center gap-2 group">
              <button
                onClick={() => cycleStepStatus(i)}
                className="flex-shrink-0"
                title={`Status: ${step.status} (click to cycle)`}
              >
                {step.status === "completed" ? (
                  <CheckCircle2 className="w-4 h-4 text-gray-900" />
                ) : step.status === "current" ? (
                  <div className="w-4 h-4 rounded-full border-2 border-gray-900" />
                ) : (
                  <Circle className="w-4 h-4 text-gray-300" />
                )}
              </button>
              <span className={`text-[13px] flex-1 ${step.status === "completed" ? "text-gray-400" : "text-gray-900"}`}>
                {step.label}
              </span>
              <span className="text-[10px] text-gray-400 capitalize">{step.status}</span>
              <button
                onClick={() => removeTimelineStep(i)}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-gray-100 rounded transition-all"
              >
                <X className="w-3 h-3 text-gray-400" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={newStepLabel}
            onChange={e => setNewStepLabel(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addTimelineStep()}
            placeholder="Add step..."
            className="flex-1 px-3 py-1.5 text-[12px] border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300"
          />
          <button
            onClick={addTimelineStep}
            disabled={!newStepLabel.trim()}
            className="p-1.5 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-30"
          >
            <Plus className="w-3.5 h-3.5 text-gray-600" />
          </button>
        </div>
      </motion.div>

      {/* Onboarding Items */}
      <motion.div
        className="bg-white border-0 rounded-2xl shadow-sm p-4"
        variants={fadeInUp}
        initial="initial"
        animate="animate"
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
      >
        <h3 className="text-[13px] font-semibold text-gray-900 mb-3">Onboarding Checklist</h3>
        <div className="space-y-1.5 mb-3">
          {onboardingItems.map((item, i) => (
            <div key={item.id || i} className="flex items-center gap-2 group">
              <div className="flex-shrink-0">
                {item.is_completed ? (
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                ) : (
                  <Circle className="w-4 h-4 text-gray-300" />
                )}
              </div>
              <span className={`text-[13px] flex-1 ${item.is_completed ? "text-gray-400 line-through" : "text-gray-900"}`}>
                {item.label}
              </span>
              {item.item_type === "link" && (
                <Link2 className="w-3 h-3 text-gray-300" />
              )}
              <button
                onClick={() => removeOnboardingItem(i)}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-gray-100 rounded transition-all"
              >
                <X className="w-3 h-3 text-gray-400" />
              </button>
            </div>
          ))}
          {onboardingItems.length === 0 && (
            <p className="text-[12px] text-gray-400">No items yet. Add tasks for your client to complete.</p>
          )}
        </div>
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={newItemLabel}
              onChange={e => setNewItemLabel(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addOnboardingItem()}
              placeholder="Add task..."
              className="flex-1 px-3 py-1.5 text-[12px] border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300"
            />
            <select
              value={newItemType}
              onChange={e => setNewItemType(e.target.value as "checkbox" | "link")}
              className="px-2 py-1.5 text-[11px] border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-gray-300"
            >
              <option value="checkbox">Task</option>
              <option value="link">Link</option>
            </select>
            <button
              onClick={addOnboardingItem}
              disabled={!newItemLabel.trim()}
              className="p-1.5 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-30"
            >
              <Plus className="w-3.5 h-3.5 text-gray-600" />
            </button>
          </div>
          {newItemType === "link" && (
            <input
              type="url"
              value={newItemUrl}
              onChange={e => setNewItemUrl(e.target.value)}
              placeholder="https://..."
              className="w-full px-3 py-1.5 text-[12px] border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300"
            />
          )}
        </div>
      </motion.div>
    </div>
  );
}
