import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/contexts/AuthContext";
import type { AccountSecurityProps } from "@/contexts/auth/slotTypes";
import { getSupabaseAuthClient } from "./client";

// Self-host account security: change password and sign out. Nothing else —
// Supabase Auth has no hosted profile UI to embed.
export default function SupabaseAccountSecurity(_props: AccountSecurityProps) {
  const { signOut, user } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { toast.error("The passwords don't match."); return; }
    setBusy(true);
    const { error } = await getSupabaseAuthClient().auth.updateUser({ password });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setPassword("");
    setConfirm("");
    toast.success("Password updated.");
  };

  return (
    <div className="max-w-md space-y-6">
      <form onSubmit={save} className="space-y-3">
        <div className="text-[12px] font-medium text-muted-foreground">Change password{user?.email ? ` for ${user.email}` : ""}</div>
        <Input type="password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} disabled={busy} />
        <Input type="password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} disabled={busy} />
        <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Update password"}</Button>
      </form>
      <div>
        <Button type="button" size="sm" variant="outline" onClick={() => { signOut(); }}>Sign out</Button>
      </div>
    </div>
  );
}
