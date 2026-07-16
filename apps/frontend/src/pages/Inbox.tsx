import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Inbox as InboxIcon,
  Archive,
  FileSignature,
  CheckCircle2,
  Eye,
  FileCheck,
  BotMessageSquare,
  BarChart3,
  Send,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";

interface Notification {
  id: string;
  workspace_id: string;
  user_id: string;
  type: "signature_required" | "document_signed" | "document_viewed" | "document_completed" | "follow_up_reminder" | "document_sent" | "weekly_report";
  document_id: string | null;
  document_name: string | null;
  share_token: string | null;
  from_contact_id: string | null;
  from_contact_name: string | null;
  from_contact_email: string | null;
  status: string;
  is_read: boolean;
  is_archived: boolean;
  created_at: string;
  read_at: string | null;
  archived_at: string | null;
  metadata: {
    follow_up_hours?: number;
    prospect_name?: string;
    prospect_email?: string;
    pre_filled_prompt?: string;
    signature_id?: string;
  } | null;
}

const TYPE_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  signature_required: {
    label: "Signature Required",
    icon: <FileSignature className="h-4 w-4" />,
    color: "bg-amber-50 text-amber-700 border-amber-200",
  },
  document_signed: {
    label: "Document Signed",
    icon: <CheckCircle2 className="h-4 w-4" />,
    color: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  document_viewed: {
    label: "Document Viewed",
    icon: <Eye className="h-4 w-4" />,
    color: "bg-blue-50 text-blue-700 border-blue-200",
  },
  document_sent: {
    label: "Proposal Sent",
    icon: <Send className="h-4 w-4" />,
    color: "bg-sky-50 text-sky-700 border-sky-200",
  },
  document_completed: {
    label: "Document Completed",
    icon: <FileCheck className="h-4 w-4" />,
    color: "bg-purple-50 text-purple-700 border-purple-200",
  },
  follow_up_reminder: {
    label: "Follow Up",
    icon: <BotMessageSquare className="h-4 w-4" />,
    color: "bg-orange-50 text-orange-700 border-orange-200",
  },
  follow_up_actioned: {
    label: "Followed Up",
    icon: <CheckCircle2 className="h-4 w-4" />,
    color: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  weekly_report: {
    label: "Weekly Report",
    icon: <BarChart3 className="h-4 w-4" />,
    color: "bg-indigo-50 text-indigo-700 border-indigo-200",
  },
};

const fadeInUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -10 },
};

const Inbox = () => {
  const navigate = useNavigate();
  const { userData, session } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"incoming" | "archived">("incoming");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [unreadCount, setUnreadCount] = useState(0);

  const workspaceId = userData?.selectedWorkspace?.id || userData?.workspace?.id;

  useEffect(() => {
    if (workspaceId) {
      loadNotifications();
    }
  }, [workspaceId, activeTab]);

  const loadNotifications = async () => {
    if (!workspaceId || !session?.access_token) return;

    setLoading(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const params = new URLSearchParams({
        workspaceId,
        archived: activeTab === "archived" ? "true" : "false",
      });

      const response = await fetch(`${apiUrl}/api/notifications?${params.toString()}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.ok) {
        const data = await response.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      }
    } catch (error) {
      console.error("Error loading notifications:", error);
      toast.error("Failed to load inbox");
    } finally {
      setLoading(false);
    }
  };

  const handleArchive = async (ids: string[]) => {
    if (!session?.access_token || ids.length === 0) return;

    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(`${apiUrl}/api/notifications`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ids,
          is_archived: activeTab === "incoming",
          is_read: true,
        }),
      });

      if (response.ok) {
        toast.success(
          activeTab === "incoming"
            ? `${ids.length} notification${ids.length > 1 ? "s" : ""} archived`
            : `${ids.length} notification${ids.length > 1 ? "s" : ""} restored`
        );
        setSelectedIds(new Set());
        loadNotifications();
      }
    } catch (error) {
      console.error("Error archiving notifications:", error);
      toast.error("Failed to update notifications");
    }
  };

  const handleNotificationClick = async (notification: Notification) => {
    // Mark as read
    if (!notification.is_read && session?.access_token) {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      await fetch(`${apiUrl}/api/notifications/${notification.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ is_read: true }),
      });
    }

    // Open appropriate link based on notification type
    if (notification.type === "weekly_report" && notification.metadata?.report_id) {
      navigate(`/reports/${notification.metadata.report_id}`);
    } else if (notification.type === "follow_up_reminder" && notification.metadata?.pre_filled_prompt) {
      // Navigate to homepage and start a chat with the pre-filled follow-up prompt
      const params = new URLSearchParams({
        followUp: "true",
        prompt: notification.metadata.pre_filled_prompt,
      });
      navigate(`/?${params.toString()}`);
    } else if (notification.share_token) {
      if (notification.type === "signature_required") {
        // Open signing page for signature requests
        window.open(`/sign/${notification.share_token}`, "_blank");
      } else if (notification.type === "document_signed" || notification.type === "document_completed") {
        // Open the signed document view via share link
        window.open(`/sign/${notification.share_token}`, "_blank");
      } else {
        // Open document editor for other notification types
        navigate(`/documents/${notification.document_id}/edit`);
      }
    } else if (notification.document_id) {
      navigate(`/documents/${notification.document_id}/edit`);
    }
  };

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === notifications.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(notifications.map((n) => n.id)));
    }
  };

  const getFromDisplay = (notification: Notification) => {
    if (notification.from_contact_name) {
      return notification.from_contact_name;
    }
    if (notification.from_contact_email) {
      return notification.from_contact_email;
    }
    return "Nous";
  };

  return (
    <div className="flex flex-col h-screen bg-gradient-to-b from-gray-50/50 to-white overflow-hidden">
      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-[800px] mx-auto px-6 py-8">
          {/* Header */}
          <motion.div
            className="mb-6"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <div className="flex items-center justify-between mb-6">
              <div>
                <h1 className="text-[24px] font-semibold text-gray-900 tracking-[-0.02em]">
                  Inbox
                </h1>
                {unreadCount > 0 && (
                  <p className="text-sm text-gray-500 mt-0.5">{unreadCount} unread notification{unreadCount !== 1 ? 's' : ''}</p>
                )}
              </div>

              {selectedIds.size > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleArchive(Array.from(selectedIds))}
                  className="gap-2"
                >
                  <Archive className="h-4 w-4" />
                  {activeTab === "incoming" ? "Archive" : "Restore"} ({selectedIds.size})
                </Button>
              )}
            </div>

            {/* Tabs with green underline */}
            <div className="flex gap-6 border-b border-gray-200">
              <button
                onClick={() => {
                  setActiveTab("incoming");
                  setSelectedIds(new Set());
                }}
                className={`pb-3 text-[14px] font-medium transition-all relative ${
                  activeTab === "incoming"
                    ? "text-emerald-600"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                Incoming
                {activeTab === "incoming" && (
                  <motion.div
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-full"
                    layoutId="activeTab"
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  />
                )}
              </button>
              <button
                onClick={() => {
                  setActiveTab("archived");
                  setSelectedIds(new Set());
                }}
                className={`pb-3 text-[14px] font-medium transition-all relative ${
                  activeTab === "archived"
                    ? "text-emerald-600"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                Archived
                {activeTab === "archived" && (
                  <motion.div
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-full"
                    layoutId="activeTab"
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  />
                )}
              </button>
            </div>
          </motion.div>
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : notifications.length === 0 ? (
            <motion.div
              className="flex flex-col items-center justify-center py-16"
              variants={fadeInUp}
              initial="initial"
              animate="animate"
            >
              {activeTab === "incoming" ? (
                <>
                  <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center mb-4">
                    <InboxIcon className="h-7 w-7 text-gray-400" />
                  </div>
                  <h2 className="text-[15px] font-medium text-gray-900 mb-1">
                    No new notifications
                  </h2>
                  <p className="text-[13px] text-gray-500">
                    Document signing updates will appear here
                  </p>
                </>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center mb-4">
                    <Archive className="h-7 w-7 text-gray-400" />
                  </div>
                  <h2 className="text-[15px] font-medium text-gray-900 mb-1">
                    No archived notifications
                  </h2>
                  <p className="text-[13px] text-gray-500">
                    Archived notifications will appear here
                  </p>
                </>
              )}
            </motion.div>
          ) : (
            <motion.div
              className="border border-gray-200 rounded-xl overflow-hidden bg-white"
              variants={fadeInUp}
              initial="initial"
              animate="animate"
            >
              {/* Notification Rows */}
              <AnimatePresence mode="popLayout">
                <div className="divide-y divide-gray-100">
                  {notifications.map((notification, index) => {
                    const isActioned = notification.type === "follow_up_reminder" && notification.status === "actioned";
                    const typeConfig = isActioned
                      ? TYPE_CONFIG.follow_up_actioned
                      : (TYPE_CONFIG[notification.type] || TYPE_CONFIG.document_signed);
                    const isNew = !notification.is_read;

                    return (
                      <motion.div
                        key={notification.id}
                        className={`flex items-center gap-4 px-4 py-4 hover:bg-gray-50 transition-colors cursor-pointer ${
                          isNew ? "bg-emerald-50/40" : ""
                        }`}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        transition={{ delay: index * 0.03, duration: 0.3 }}
                        onClick={() => handleNotificationClick(notification)}
                      >
                        {/* Checkbox */}
                        <div
                          className="flex-shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            checked={selectedIds.has(notification.id)}
                            onCheckedChange={() => toggleSelect(notification.id)}
                            className="border-gray-300"
                          />
                        </div>

                        {/* Main Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={`text-[14px] truncate ${
                                isNew ? "font-semibold text-gray-900" : "font-medium text-gray-700"
                              }`}
                            >
                              {notification.type === "follow_up_reminder" && notification.metadata?.prospect_name
                                ? `${notification.metadata.prospect_name} hasn't responded — ${notification.document_name || "Untitled"}`
                                : notification.document_name || "Untitled Document"}
                            </span>
                            {isNew && (
                              <Badge className="bg-emerald-500 text-white text-[10px] px-1.5 py-0 rounded font-medium">
                                NEW
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[13px] text-gray-500">
                            <span>From {getFromDisplay(notification)}</span>
                            <span className="text-gray-300">·</span>
                            <span>{formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}</span>
                          </div>
                        </div>

                        {/* Status Badge */}
                        <div className="flex-shrink-0">
                          <Badge
                            variant="outline"
                            className={`text-[11px] px-2 py-1 rounded-md font-medium ${typeConfig.color}`}
                          >
                            {typeConfig.label}
                          </Badge>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </AnimatePresence>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Inbox;
