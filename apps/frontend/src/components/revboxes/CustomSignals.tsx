// A RevBox's view of the workspace signals (GET-862). Signals belong to the workspace and live in
// Settings > Signals; from a box, a new one only records the box it was proposed in.
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { YourSignals } from '@/components/settings/SignalsSettings';
export type { WorkspaceSignal as CustomSignal } from '@/lib/revboxes';

export function CustomSignals({ ws, token, boxId, userId }: { ws: string; token: string; boxId: string; userId: string }) {
  return <div className="mt-8 border-t border-border pt-6">
    <YourSignals ws={ws} token={token} userId={userId} boxId={boxId} />
    <Link to="/settings?section=signals" className="mt-3 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground">All signals in Settings<ArrowUpRight className="h-3 w-3" /></Link>
  </div>;
}
