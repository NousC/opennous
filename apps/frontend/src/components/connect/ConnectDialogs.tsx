// The Connect agent menu's two dialogs (GET-626, GET-627), one open at a time.
import { ConnectMcpDialog } from "./ConnectMcpDialog";
import { ConnectApiDialog } from "./ConnectApiDialog";
import type { ConnectKind } from "@/components/shell/apiTopBarContext";

export function ConnectDialogs({ open, onClose }: { open: ConnectKind | null; onClose: () => void }) {
  return (
    <>
      <ConnectMcpDialog open={open === "mcp"} onOpenChange={(o) => { if (!o) onClose(); }} />
      <ConnectApiDialog open={open === "api"} onOpenChange={(o) => { if (!o) onClose(); }} />
    </>
  );
}
