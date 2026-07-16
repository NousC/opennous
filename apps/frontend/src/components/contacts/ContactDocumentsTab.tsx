import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { FileText, Loader2 } from "lucide-react";
import { format } from "date-fns";

interface Document {
  id: string;
  name: string;
  status: string;
  signing_status?: string;
  created_at: string;
  role?: string;
  template?: {
    name: string;
    type: string;
  };
}

interface ContactDocumentsTabProps {
  contactId: string;
}

const STATUS_COLORS: Record<string, string> = {
  created: "bg-gray-50 text-gray-600 border-gray-200",
  sent: "bg-blue-50 text-blue-700 border-blue-200",
  viewed: "bg-amber-50 text-amber-700 border-amber-200",
  signed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  // Legacy
  draft: "bg-gray-50 text-gray-600 border-gray-200",
  finalized: "bg-blue-50 text-blue-700 border-blue-200",
  pending: "bg-blue-50 text-blue-700 border-blue-200",
  configured: "bg-gray-50 text-gray-600 border-gray-200",
  partially_signed: "bg-amber-50 text-amber-700 border-amber-200",
  fully_signed: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

export function ContactDocumentsTab({ contactId }: ContactDocumentsTabProps) {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDocuments();
  }, [contactId]);

  const loadDocuments = async () => {
    if (!session?.access_token) return;

    setLoading(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(`${apiUrl}/api/contacts/${contactId}/documents`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.ok) {
        const data = await response.json();
        setDocuments(data.documents || []);
      }
    } catch (error) {
      console.error("Error loading contact documents:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDocumentClick = (documentId: string) => {
    navigate(`/documents/${documentId}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <motion.div
        className="flex flex-col items-center justify-center h-full text-center py-8"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
      >
        <FileText className="h-8 w-8 text-gray-200 mb-3" />
        <p className="text-[11px] text-gray-400">No documents linked</p>
      </motion.div>
    );
  }

  return (
    <div className="h-full overflow-hidden flex flex-col">
      {/* Table Header */}
      <div className="grid grid-cols-[1fr_1fr_70px_80px] gap-3 px-5 py-2.5 border-b border-gray-100 bg-gray-50/50 flex-shrink-0">
        <span className="text-[13px] font-medium text-gray-600">Name</span>
        <span className="text-[13px] font-medium text-gray-600">Template</span>
        <span className="text-[13px] font-medium text-gray-600">Status</span>
        <span className="text-[13px] font-medium text-gray-600">Created</span>
      </div>

      {/* Document Rows - Scrollable (hidden scrollbar) */}
      <div className="flex-1 overflow-auto scrollbar-hide">
        {documents.map((doc, index) => (
          <motion.button
            key={doc.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.03, duration: 0.3 }}
            onClick={() => handleDocumentClick(doc.id)}
            className="w-full grid grid-cols-[1fr_1fr_70px_80px] gap-3 px-5 py-2.5 border-b border-gray-100 hover:bg-gray-50/50 transition-colors text-left"
          >
            {/* Document Name */}
            <div className="flex items-center min-w-0">
              <span className="font-medium text-[13px] text-gray-900 truncate">
                {doc.name}
              </span>
            </div>

            {/* Template */}
            <div className="flex items-center min-w-0">
              <div className="flex items-center gap-1.5 text-[13px] text-gray-500 truncate">
                <FileText className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
                <span className="truncate">{doc.template?.name || "—"}</span>
              </div>
            </div>

            {/* Status */}
            <div className="flex items-center">
              <Badge
                variant="outline"
                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  doc.signing_status
                    ? STATUS_COLORS[doc.signing_status] || STATUS_COLORS.draft
                    : STATUS_COLORS[doc.status] || STATUS_COLORS.draft
                }`}
              >
                {doc.signing_status === "signed" || doc.signing_status === "fully_signed"
                  ? "Signed"
                  : doc.signing_status === "viewed" || doc.signing_status === "partially_signed"
                  ? "Viewed"
                  : doc.signing_status === "sent" || doc.signing_status === "pending"
                  ? "Sent"
                  : doc.signing_status === "created"
                  ? "Created"
                  : doc.status === "finalized"
                  ? "Final"
                  : "Draft"}
              </Badge>
            </div>

            {/* Created Date */}
            <div className="flex items-center">
              <span className="text-[13px] text-gray-500">
                {format(new Date(doc.created_at), "MMM d")}
              </span>
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
