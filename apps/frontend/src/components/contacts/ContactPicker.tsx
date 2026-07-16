import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ChevronsUpDown, Check, UserPlus, User } from "lucide-react";
import { cn } from "@/lib/utils";

interface Contact {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
}

interface ContactPickerProps {
  workspaceId: string;
  selectedContactId?: string | null;
  onSelect: (contact: Contact | null) => void;
  onCreateNew: () => void;
  placeholder?: string;
  className?: string;
}

export function ContactPicker({
  workspaceId,
  selectedContactId,
  onSelect,
  onCreateNew,
  placeholder = "Select contact...",
  className,
}: ContactPickerProps) {
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (open && workspaceId) {
      loadContacts();
    }
  }, [open, workspaceId]);

  const loadContacts = async () => {
    if (!session?.access_token) return;

    setLoading(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const params = new URLSearchParams({
        workspaceId,
        limit: "50",
      });
      if (search) {
        params.append("search", search);
      }

      const response = await fetch(`${apiUrl}/api/contacts?${params.toString()}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.ok) {
        const data = await response.json();
        setContacts(data.contacts || []);
      }
    } catch (error) {
      console.error("Error loading contacts:", error);
    } finally {
      setLoading(false);
    }
  };

  const selectedContact = contacts.find((c) => c.id === selectedContactId);

  const getDisplayName = (contact: Contact) => {
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
    return name || contact.email;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between font-normal", className)}
        >
          {selectedContact ? (
            <div className="flex items-center gap-2 truncate">
              <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="truncate">{getDisplayName(selectedContact)}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search contacts..."
            value={search}
            onValueChange={(value) => {
              setSearch(value);
              // Debounced search
              setTimeout(() => loadContacts(), 300);
            }}
          />
          <CommandList>
            <CommandEmpty>
              {loading ? "Loading..." : "No contacts found."}
            </CommandEmpty>
            <CommandGroup>
              {contacts.map((contact) => (
                <CommandItem
                  key={contact.id}
                  value={contact.id}
                  onSelect={() => {
                    onSelect(contact.id === selectedContactId ? null : contact);
                    setOpen(false);
                  }}
                  className="flex items-center gap-2"
                >
                  <Check
                    className={cn(
                      "h-4 w-4",
                      selectedContactId === contact.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{getDisplayName(contact)}</div>
                    {contact.company && (
                      <div className="text-xs text-muted-foreground truncate">
                        {contact.company}
                      </div>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  onCreateNew();
                }}
                className="flex items-center gap-2 text-primary"
              >
                <UserPlus className="h-4 w-4" />
                Add new contact
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
