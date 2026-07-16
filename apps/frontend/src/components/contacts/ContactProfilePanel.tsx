import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, Check } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

interface Contact {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  company?: string;
  job_title?: string;
  notes?: string;
  tags?: string[];
  total_documents_count: number;
  incoming_contacts_count: number;
  total_income?: number;
  total_income_source?: string;
  last_activity_at?: string;
  last_document_at?: string;
  stripe_customer_id?: string;
  source?: string;
  created_at: string;
  deal_value?: number;
  deal_closed_at?: string;
  deal_sent_at?: string;
  status?: string;
  industry?: string;
  lead_source?: string;
  company_size?: string;
  keywords?: string;
}

interface ContactProfilePanelProps {
  contact: Contact;
  onEdit: () => void;
  onDelete?: () => void;
  onIncomeUpdate?: (income: number) => void;
  onContactUpdate?: (contact: Contact) => void;
}

type EditableField = "first_name" | "last_name" | "email" | "phone" | "company" | "job_title" | "notes" | "total_income" | "deal_value" | "industry" | "lead_source" | "company_size" | "keywords";

export function ContactProfilePanel({ contact, onEdit, onDelete, onIncomeUpdate, onContactUpdate }: ContactProfilePanelProps) {
  const { session } = useAuth();
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Unknown";

  useEffect(() => {
    if (editingField && inputRef.current) {
      inputRef.current.focus();
      if (inputRef.current instanceof HTMLInputElement) {
        inputRef.current.select();
      }
    }
  }, [editingField]);

  const formatCurrency = (value?: number) => {
    if (value === undefined || value === null) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value);
  };

  const getLastActivityLabel = () => {
    const activityDate = contact.last_activity_at || contact.last_document_at;
    if (!activityDate) return "—";
    try {
      return formatDistanceToNow(new Date(activityDate), { addSuffix: true });
    } catch {
      return "—";
    }
  };

  const startEditing = (field: EditableField) => {
    const value = field === "total_income"
      ? (contact.total_income?.toString() || "")
      : field === "deal_value"
      ? (contact.deal_value?.toString() || "")
      : (contact[field] || "");
    setEditValue(value);
    setEditingField(field);
  };

  const cancelEditing = () => {
    setEditingField(null);
    setEditValue("");
  };

  const saveField = async () => {
    if (!session?.access_token || !editingField) return;

    // Special handling for income
    if (editingField === "total_income") {
      const numValue = parseFloat(editValue);
      if (!isNaN(numValue) && numValue >= 0 && onIncomeUpdate) {
        onIncomeUpdate(numValue);
      }
      setEditingField(null);
      return;
    }

    // Special handling for deal_value - save directly
    if (editingField === "deal_value") {
      const numValue = parseFloat(editValue);
      setSaving(true);
      try {
        const apiUrl = import.meta.env.VITE_API_URL ?? "";
        const response = await fetch(`${apiUrl}/api/contacts/${contact.id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            deal_value: !isNaN(numValue) && numValue >= 0 ? numValue : null,
            deal_closed_at: !isNaN(numValue) && numValue > 0 ? new Date().toISOString() : null
          })
        });

        if (response.ok) {
          const data = await response.json();
          if (onContactUpdate && data.contact) {
            onContactUpdate(data.contact);
          }
          toast.success("Updated");
        } else {
          toast.error("Failed to update");
        }
      } catch (error) {
        console.error("Error updating contact:", error);
        toast.error("Failed to update");
      } finally {
        setSaving(false);
        setEditingField(null);
      }
      return;
    }

    setSaving(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(`${apiUrl}/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ [editingField]: editValue || null })
      });

      if (response.ok) {
        const data = await response.json();
        if (onContactUpdate && data.contact) {
          onContactUpdate(data.contact);
        }
        toast.success("Updated");
      } else {
        toast.error("Failed to update");
      }
    } catch (error) {
      console.error("Error updating contact:", error);
      toast.error("Failed to update");
    } finally {
      setSaving(false);
      setEditingField(null);
    }
  };

  const updateStatus = async (newStatus: string) => {
    if (!session?.access_token) return;
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(`${apiUrl}/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ status: newStatus })
      });
      if (response.ok) {
        const data = await response.json();
        if (onContactUpdate && data.contact) onContactUpdate(data.contact);
        toast.success(`Marked as ${newStatus === "client" ? "Client" : "Prospect"}`);
      } else {
        toast.error("Failed to update status");
      }
    } catch {
      toast.error("Failed to update status");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && editingField !== "notes" && editingField !== "keywords") {
      e.preventDefault();
      saveField();
    } else if (e.key === "Escape") {
      cancelEditing();
    }
  };

  const renderEditableField = (
    field: EditableField,
    value: string,
    placeholder: string,
    isTextarea = false
  ) => {
    const isEditing = editingField === field;

    if (isEditing) {
      return (
        <div className="flex items-center gap-1">
          {isTextarea ? (
            <Textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => setTimeout(saveField, 150)}
              className="text-[13px] min-h-[60px] resize-none border-gray-200 focus:border-gray-300 rounded-lg"
              placeholder={placeholder}
              disabled={saving}
            />
          ) : (
            <Input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => setTimeout(saveField, 150)}
              className="h-7 text-[13px] border-gray-200 focus:border-gray-300 rounded-lg"
              placeholder={placeholder}
              disabled={saving}
            />
          )}
        </div>
      );
    }

    return (
      <div
        className="text-[13px] text-gray-900 cursor-pointer hover:bg-gray-50 rounded-lg px-2 -mx-2 py-1 transition-colors"
        onClick={() => startEditing(field)}
      >
        {value || <span className="text-gray-400">{placeholder}</span>}
      </div>
    );
  };

  return (
    <div className="bg-white border-0 rounded-2xl shadow-sm p-4 h-full overflow-hidden flex flex-col">
      {/* Name + Job Title */}
      <div className="mb-2">
        {editingField === "first_name" || editingField === "last_name" ? (
          <Input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(saveField, 150)}
            className="h-8 text-[16px] font-semibold border-gray-200 rounded-lg"
            placeholder={editingField === "first_name" ? "First name" : "Last name"}
            disabled={saving}
          />
        ) : (
          <h2
            className="text-[16px] font-semibold text-gray-900 cursor-pointer hover:bg-gray-50 rounded-lg px-2 -mx-2 py-0.5 transition-colors"
            onClick={() => startEditing("first_name")}
          >
            {fullName}
          </h2>
        )}
        <div className="mt-0.5 px-2 -mx-2">
          {renderEditableField("job_title", contact.job_title || "", "Add job title")}
        </div>
        <div className="mt-2 px-2 -mx-2">
          <button
            onClick={() => updateStatus(contact.status === "client" ? "prospect" : "client")}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all hover:opacity-80 cursor-pointer ${
              contact.status === "client"
                ? "bg-teal-50 text-teal-700 hover:bg-teal-100"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
            title={contact.status === "client" ? "Click to mark as Prospect" : "Click to mark as Client"}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${contact.status === "client" ? "bg-teal-500" : "bg-gray-400"}`} />
            {contact.status === "client" ? "Client" : "Prospect"}
          </button>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div
          className="bg-gray-50 border-0 rounded-xl px-3 py-2.5 cursor-pointer hover:bg-gray-100 transition-all"
          onClick={() => startEditing("deal_value")}
        >
          {editingField === "deal_value" ? (
            <Input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="number"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => setTimeout(saveField, 150)}
              className="h-6 text-sm font-semibold border-gray-200 rounded-lg"
              placeholder="0"
              disabled={saving}
            />
          ) : (
            <>
              <div className="text-[15px] font-semibold text-emerald-600">{formatCurrency(contact.deal_value)}</div>
              <div className="text-[10px] text-gray-400 uppercase tracking-wide mt-0.5">Deal Value</div>
            </>
          )}
        </div>
        <div className="bg-gray-50 border-0 rounded-xl px-3 py-2.5">
          <div className="text-[15px] font-semibold text-gray-900 truncate" title={getLastActivityLabel()}>
            {getLastActivityLabel().replace(" ago", "").replace("less than a minute", "now").replace("about ", "")}
          </div>
          <div className="text-[10px] text-gray-400 uppercase tracking-wide mt-0.5">Last Active</div>
        </div>
      </div>

      {/* Contact Details */}
      <div className="space-y-1">
        {[
          { field: "email" as EditableField, label: "Email", value: contact.email, placeholder: "Add email" },
          { field: "phone" as EditableField, label: "Phone", value: contact.phone || "", placeholder: "Add phone" },
          { field: "company" as EditableField, label: "Company", value: contact.company || "", placeholder: "Add company" },
          { field: "industry" as EditableField, label: "Industry", value: contact.industry || "", placeholder: "Add industry" },
          { field: "company_size" as EditableField, label: "Company Size", value: contact.company_size || "", placeholder: "e.g. 1-10, 11-50, 51-200" },
        ].map(({ field, label, value, placeholder }) => (
          <div key={field}>
            <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-0.5 px-2">{label}</div>
            {editingField === field ? (
              <Input
                ref={inputRef as React.RefObject<HTMLInputElement>}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={() => setTimeout(saveField, 150)}
                className="h-7 text-[13px] border-gray-200 rounded-lg"
                placeholder={placeholder}
                disabled={saving}
              />
            ) : (
              <div
                className="text-[13px] text-gray-900 cursor-pointer hover:bg-gray-50 rounded-lg px-2 -mx-0 py-1 transition-colors truncate"
                onClick={() => startEditing(field)}
              >
                {value || <span className="text-gray-300">{placeholder}</span>}
              </div>
            )}
          </div>
        ))}

        {/* Notes */}
        <div>
          <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-0.5 px-2">Notes</div>
          {editingField === "notes" ? (
            <div className="px-2 -mx-0">
              <Textarea
                ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") cancelEditing(); }}
                className="text-[13px] min-h-[50px] resize-none mb-1.5 border-gray-200 rounded-lg"
                placeholder="Add notes about this contact..."
                disabled={saving}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={saveField} disabled={saving} className="h-7 text-xs rounded-lg">
                  <Check className="h-3 w-3 mr-1" />Save
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEditing} className="h-7 text-xs rounded-lg">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div
              className="text-[13px] text-gray-700 cursor-pointer hover:bg-gray-50 rounded-lg px-2 -mx-0 py-1 transition-colors"
              onClick={() => startEditing("notes")}
            >
              {contact.notes ? (
                <p className="whitespace-pre-wrap leading-relaxed text-[12px] line-clamp-3">{contact.notes}</p>
              ) : (
                <span className="text-gray-300 italic text-[12px]">Click to add notes...</span>
              )}
            </div>
          )}
        </div>

        {/* Deal Closed */}
        {contact.deal_closed_at && (
          <div>
            <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-0.5 px-2">Deal Closed</div>
            <div className="text-[13px] text-emerald-600 px-2 font-medium">
              {format(new Date(contact.deal_closed_at), "MMM d, yyyy")}
            </div>
          </div>
        )}

        {/* Added */}
        <div>
          <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-0.5 px-2">Added</div>
          <div className="text-[13px] text-gray-900 px-2">
            {contact.created_at ? format(new Date(contact.created_at), "MMM d, yyyy") : "—"}
          </div>
        </div>
      </div>

      {/* Delete */}
      {onDelete && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="text-gray-400 hover:text-red-600 hover:bg-red-50 h-7 text-xs w-full justify-center gap-1.5 rounded-lg flex-shrink-0 mt-4"
        >
          <Trash2 className="h-3 w-3" />
          Delete Contact
        </Button>
      )}
    </div>
  );
}
