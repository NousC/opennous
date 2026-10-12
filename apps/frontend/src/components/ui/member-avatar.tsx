// One of OUR people, with their photo (GET-792). Owner chips and deal owners arrive as names only,
// and drew initials ("AS", "B") for teammates whose photo is on their seat. This looks the name up
// in the workspace's members (one cached read per workspace) and shows the photo when it finds
// one, by full name first, then by a unique first name; anything else keeps the initials.
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { fetchMembers, type Member } from "@/components/tasks/NewTaskDialog";
import { PersonAvatar } from "@/components/ui/owner-filter";

export function useWorkspaceMembers(): Member[] {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const wsId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  const q = useQuery({
    queryKey: ["workspace-members", wsId],
    queryFn: () => fetchMembers(token, wsId),
    enabled: !!token && !!wsId,
    staleTime: 10 * 60_000,
  });
  return q.data ?? [];
}

/** The member a name means: the full name, else a first name only one member has. */
export function memberByName(members: Member[], name: string | null | undefined): Member | null {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return null;
  const full = members.find(m => m.name.trim().toLowerCase() === n);
  if (full) return full;
  const first = n.split(/\s+/)[0];
  const byFirst = members.filter(m => m.name.trim().toLowerCase().split(/\s+/)[0] === first);
  return byFirst.length === 1 ? byFirst[0] : null;
}

export function MemberAvatar({ name, size = 18 }: { name: string; size?: number }) {
  const m = memberByName(useWorkspaceMembers(), name);
  if (m?.avatar) {
    return <img src={m.avatar} alt="" aria-hidden style={{ width: size, height: size }} className="shrink-0 rounded-full object-cover" />;
  }
  return <PersonAvatar person={{ id: m?.id ?? name, name }} size={size} />;
}
