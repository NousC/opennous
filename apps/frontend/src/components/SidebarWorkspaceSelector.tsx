import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Plus, Check, Folder, Trash2, ChevronsUpDown, Pencil, Lock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { workspaceIcons, getWorkspaceIcon } from '@/utils/workspaceIcons';
import { activeTeam } from '@/lib/activeTeam';

interface BillingInfo {
  monthlyPrice: number;
  planName: string;
  currentWorkspaces: number;
}

interface SidebarWorkspaceSelectorProps {
  collapsed?: boolean;
}

export function SidebarWorkspaceSelector({ collapsed = false }: SidebarWorkspaceSelectorProps) {
  const { userData, session, refreshUserData } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceIcon, setNewWorkspaceIcon] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [hoveredWorkspaceId, setHoveredWorkspaceId] = useState<string | null>(null);
  const [usageData, setUsageData] = useState<any>(null);

  // Billing confirmation state
  const [billingDialogOpen, setBillingDialogOpen] = useState(false);
  const [pendingWorkspace, setPendingWorkspace] = useState<{ name: string; icon: string | null } | null>(null);
  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);

  // Delete workspace with billing info
  const [deleteWorkspaceData, setDeleteWorkspaceData] = useState<any>(null);

  // Rename workspace
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  const currentWorkspace = userData?.workspace;
  // The rail names the WORKSPACE (teams.name — "theo's Team"), not the company.
  // workspaces.name is the COMPANY ("OpenNous"), which the Spaces row below already
  // carries; showing it twice made the rail say the same word in both places and left
  // the workspace you're actually in unnamed anywhere.
  const railName = activeTeam(userData)?.name || currentWorkspace?.name || 'Workspace';
  // Self-host is single-workspace: no switcher, no "New workspace" — just the name.
  const selfHosted = (userData as { self_hosted?: boolean })?.self_hosted === true;

  // Check if workspace limit is reached
  const isWorkspaceLimitReached = usageData?.usage?.workspaces
    ? (usageData.usage.workspaces.current >= usageData.usage.workspaces.limit)
    : false;

  // Use refs to prevent duplicate requests
  const fetchingRef = useRef(false);
  const lastFetchRef = useRef<number>(0);
  const CACHE_DURATION = 30 * 1000; // 30 seconds cache

  useEffect(() => {
    // Wait for both a valid session AND userData from /me so we use the correct workspace ID.
    if (!session?.access_token || !userData) return;
    const now = Date.now();
    if (!fetchingRef.current && (now - lastFetchRef.current) > CACHE_DURATION) {
      fetchingRef.current = true;
      lastFetchRef.current = now;
      Promise.all([fetchWorkspaces(), fetchUsageData(currentWorkspace?.id)]).finally(() => {
        fetchingRef.current = false;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token, userData]);

  const fetchUsageData = async (wsId?: string) => {
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const workspaceIdParam = wsId || currentWorkspace?.id || localStorage.getItem('selectedWorkspaceId');
      const url = workspaceIdParam
        ? `${apiUrl}/api/usage?workspaceId=${workspaceIdParam}`
        : `${apiUrl}/api/usage`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${session?.access_token}`,
        },
      });

      if (!response.ok) {
        if (response.status === 429) {
          console.warn('Rate limit hit for usage endpoint, will retry later');
          return;
        }
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const errorData = await response.json();
          console.error('Error fetching usage data:', errorData);
        }
        return;
      }

      const data = await response.json();
      setUsageData(data);
    } catch (error) {
      console.error('Error fetching usage data:', error);
    }
  };

  const fetchWorkspaces = async () => {
    try {
      setLoading(true);
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const response = await fetch(`${apiUrl}/api/workspaces`, {
        headers: {
          'Authorization': `Bearer ${session?.access_token}`,
        },
      });

      if (!response.ok) {
        if (response.status === 429) {
          console.warn('Rate limit hit for workspaces endpoint, will retry later');
          return;
        }
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const errorData = await response.json();
          console.error('Error fetching workspaces:', errorData);
        }
        return;
      }

      const data = await response.json();
      setWorkspaces(data.workspaces || []);
    } catch (error) {
      console.error('Error fetching workspaces:', error);
    } finally {
      setLoading(false);
    }
  };

  const switchWorkspace = (workspaceId: string) => {
    if (currentWorkspace?.id === workspaceId) return;
    // A workspace switch is a HARD context boundary — different accounts, graph, plan and
    // home. Persist the choice and reload into it SYNCHRONOUSLY on the first click. The
    // old path pre-fetched /me behind a `loading` guard before reloading, so a slow or
    // failed fetch left `loading` stuck and swallowed the next clicks (which is why it
    // took 3-4). The reload re-fetches everything for the new workspace on boot and
    // validates access there, so none of that pre-work is needed here.
    try {
      localStorage.setItem('selectedWorkspaceId', workspaceId);
      localStorage.removeItem('nous.tabs.v1');   // open tabs belong to the old workspace
    } catch { /* ignore */ }
    window.location.href = '/';                    // HomeRoute → the plan-appropriate home
  };

  const createWorkspace = async (confirmBilling = false) => {
    const workspaceName = pendingWorkspace?.name || newWorkspaceName;
    const workspaceIcon = pendingWorkspace?.icon || newWorkspaceIcon;

    if (!workspaceName.trim()) {
      toast({
        title: 'Error',
        description: 'Workspace name is required',
        variant: 'destructive',
      });
      return;
    }

    try {
      setCreating(true);
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const response = await fetch(`${apiUrl}/api/workspaces`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: workspaceName.trim(),
          icon: workspaceIcon || null,
          confirmBilling,
        }),
      });

      if (response.status === 402) {
        const data = await response.json();
        // Partner: at the client limit, adding a workspace adds a client (+$/mo).
        // Open the confirm dialog; on confirm we bump the Stripe quantity then create.
        if (data.error === 'add_client_required' && !selfHosted) {
          setPendingWorkspace({ name: workspaceName.trim(), icon: workspaceIcon });
          setBillingInfo({
            monthlyPrice: data.per_workspace_usd ?? 100,
            planName: data.current_plan === 'scale' ? 'Partner' : (data.current_plan ?? 'Partner'),
            currentWorkspaces: data.limit ?? 0,
          });
          setCreateDialogOpen(false);
          setBillingDialogOpen(true);
          return;
        }
        if (data.error === 'billing_confirmation_required' && !selfHosted) {
          setPendingWorkspace({ name: workspaceName.trim(), icon: workspaceIcon });
          setBillingInfo(data.pricing);
          setCreateDialogOpen(false);
          setBillingDialogOpen(true);
          return;
        }
        // Flat-plan workspace cap hit — show the plan's friendly message and point at
        // Billing, not the raw error code. Growth includes more workspaces than Starter.
        if (data.error === 'workspace_limit_reached') {
          setCreateDialogOpen(false);
          const limit = data.limit ?? 1;
          toast({
            title: 'Workspace limit reached',
            description: data.message
              || `Your plan includes ${limit} workspace${limit === 1 ? '' : 's'}. Upgrade for more in Settings → Billing.`,
            variant: 'destructive',
          });
          return;
        }
      }

      if (response.ok) {
        const data = await response.json();
        const newWorkspace = data.workspace;
        setWorkspaces([...workspaces, newWorkspace]);
        localStorage.setItem('selectedWorkspaceId', newWorkspace.id);
        setCreateDialogOpen(false);
        setBillingDialogOpen(false);
        setNewWorkspaceName('');
        setNewWorkspaceIcon(null);
        setPendingWorkspace(null);
        setBillingInfo(null);
        refreshUserData();
        fetchUsageData();

        if (data.billing?.added) {
          toast({
            title: 'Workspace created',
            description: `${newWorkspace.name} has been created. Billing has been added to your subscription.`,
          });
        } else {
          toast({
            title: 'Workspace created',
            description: `${newWorkspace.name} has been created and selected`,
          });
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.message || 'Failed to create workspace');
      }
    } catch (error: any) {
      console.error('Error creating workspace:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to create workspace',
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  };

  const handleBillingConfirm = async () => {
    // Partner add-client: bump the Stripe subscription quantity first (this lifts
    // the workspace limit), then create the workspace.
    try {
      setCreating(true);
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const r = await fetch(`${apiUrl}/api/billing/add-clients`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 1 }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.detail || e.error || 'Could not add a client to your subscription');
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'Could not add a client', variant: 'destructive' });
      setCreating(false);
      return;
    }
    await createWorkspace();
  };

  const handleBillingCancel = () => {
    setBillingDialogOpen(false);
    setPendingWorkspace(null);
    setBillingInfo(null);
    if (pendingWorkspace) {
      setNewWorkspaceName(pendingWorkspace.name);
      setNewWorkspaceIcon(pendingWorkspace.icon);
    }
  };

  const handleRenameClick = (e: React.MouseEvent, workspace: any) => {
    e.stopPropagation();
    setRenameWorkspaceId(workspace.id);
    setRenameValue(workspace.name);
    setDropdownOpen(false);
    setRenameDialogOpen(true);
  };

  const renameWorkspace = async () => {
    if (!renameWorkspaceId || !renameValue.trim()) return;
    try {
      setRenaming(true);
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${apiUrl}/api/workspaces/${renameWorkspaceId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      if (!res.ok) throw new Error('Failed to rename');
      setWorkspaces(ws => ws.map(w => w.id === renameWorkspaceId ? { ...w, name: renameValue.trim() } : w));
      setRenameDialogOpen(false);
      setRenameWorkspaceId(null);
      await refreshUserData();
      toast({ title: 'Workspace renamed', description: `Renamed to "${renameValue.trim()}"` });
    } catch {
      toast({ title: 'Error', description: 'Failed to rename workspace', variant: 'destructive' });
    } finally {
      setRenaming(false);
    }
  };

  const handleDeleteClick = (e: React.MouseEvent, workspaceId: string) => {
    e.stopPropagation();
    const workspace = workspaces.find(w => w.id === workspaceId);
    setDeleteWorkspaceData(workspace);
    setWorkspaceToDelete(workspaceId);
    setDeleteDialogOpen(true);
  };

  const deleteWorkspace = async () => {
    if (!workspaceToDelete) return;

    try {
      setDeleting(true);
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const url = `${apiUrl}/api/workspaces/${workspaceToDelete}`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        const deletedWorkspace = workspaces.find(w => w.id === workspaceToDelete);
        const wasCurrentWorkspace = currentWorkspace?.id === workspaceToDelete;
        setWorkspaces(workspaces.filter(w => w.id !== workspaceToDelete));
        setDeleteDialogOpen(false);
        setWorkspaceToDelete(null);
        setDeleteWorkspaceData(null);
        refreshUserData();
        fetchUsageData();

        if (wasCurrentWorkspace) {
          const remainingWorkspaces = workspaces.filter(w => w.id !== workspaceToDelete);
          if (remainingWorkspaces.length > 0) {
            await switchWorkspace(remainingWorkspaces[0].id);
          }
        }

        if (data.billingRemoved) {
          toast({
            title: 'Workspace deleted',
            description: `${deletedWorkspace?.name || 'Workspace'} has been deleted. Your subscription has been adjusted.`,
          });
        } else {
          toast({
            title: 'Workspace deleted',
            description: `${deletedWorkspace?.name || 'Workspace'} has been deleted`,
          });
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.detail || errorData.error || `Failed to delete workspace (${response.status})`;
        console.error('[DELETE_WORKSPACE] Error response:', errorData);
        throw new Error(errorMessage);
      }
    } catch (error: any) {
      console.error('Error deleting workspace:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to delete workspace',
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
    }
  };

  const popoverRef = useRef<HTMLDivElement>(null);
  // When collapsed the rail clips its own overflow, so the menu is rendered with fixed
  // positioning anchored to the trigger — that's the only way it escapes the rail and
  // sits on top of it instead of behind it.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const toggleDropdown = () => {
    if (!dropdownOpen && collapsed && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setMenuPos({ top: r.top, left: r.right + 8 });
    }
    setDropdownOpen(o => !o);
  };

  // Close dropdown when dialog opens
  useEffect(() => {
    if (createDialogOpen) {
      setDropdownOpen(false);
    }
  }, [createDialogOpen]);

  // Close on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [dropdownOpen]);

  if (!userData) {
    return null;
  }

  const WorkspaceIcon = currentWorkspace?.icon ? getWorkspaceIcon(currentWorkspace.icon) : null;

  return (
    <>
      <div ref={popoverRef} className="relative w-full">
        {/* Trigger */}
        {selfHosted ? (
          // Self-host: single workspace, static (no switcher / no "New workspace")
          collapsed ? (
            <div className="mx-auto flex items-center justify-center w-8 h-8 rounded-lg">
              {WorkspaceIcon ? (
                <WorkspaceIcon className="h-4 w-4 text-gray-500 dark:text-white/50" />
              ) : (
                <Folder className="h-4 w-4 text-gray-500 dark:text-white/50" />
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 w-full px-2 py-1.5 min-w-0">
              <span className="flex-1 text-[13px] font-semibold text-gray-800 dark:text-foreground truncate text-left leading-tight">
                {railName}
              </span>
            </div>
          )
        ) : collapsed ? (
          <button
            ref={triggerRef}
            onClick={toggleDropdown}
            className="mx-auto flex items-center justify-center w-8 h-8 rounded-lg hover:bg-gray-100/70 dark:hover:bg-white/[0.05] transition-all duration-150"
            disabled={loading}
          >
            {WorkspaceIcon ? (
              <WorkspaceIcon className="h-4 w-4 text-gray-500 dark:text-white/50" />
            ) : (
              <Folder className="h-4 w-4 text-gray-500 dark:text-white/50" />
            )}
          </button>
        ) : (
          <button
            onClick={() => setDropdownOpen(o => !o)}
            className="flex items-center gap-2 w-full px-1.5 py-1 rounded-lg hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors duration-fast min-w-0"
            disabled={loading}
          >
            {/* The workspace's letter in a 20px tile, the way the palette leads a row (round 2). */}
            <span aria-hidden className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-brand text-[10.5px] font-medium text-white">
              {(railName || "N").trim().charAt(0).toUpperCase()}
            </span>
            <span className="flex-1 text-[13px] font-medium text-foreground truncate text-left leading-tight">
              {railName}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground/50 flex-shrink-0" />
          </button>
        )}

        {/* Popover. Collapsed: fixed + anchored to the trigger so it sits ON TOP of the
            rail (the rail clips its own overflow, which would otherwise hide it).
            Expanded: a normal inline dropdown below the trigger. */}
        {!selfHosted && dropdownOpen && (
          <div
            className={`z-[60] overflow-hidden rounded-xl border border-border/70 bg-popover p-1 text-popover-foreground shadow-pop ${collapsed ? "fixed w-56" : "absolute left-0 top-full mt-1 w-full"}`}
            style={collapsed ? { top: menuPos.top, left: menuPos.left } : undefined}
          >
            {workspaces.map((workspace) => {
              const isCurrent = currentWorkspace?.id === workspace.id;
              return (
                <div
                  key={workspace.id}
                  className="group flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 transition-colors duration-fast hover:bg-hover"
                  onMouseEnter={() => setHoveredWorkspaceId(workspace.id)}
                  onMouseLeave={() => setHoveredWorkspaceId(null)}
                  onClick={() => {
                    setDropdownOpen(false);
                    switchWorkspace(workspace.id);
                  }}
                >
                  <span className={`flex-1 truncate text-[13px] ${isCurrent ? 'font-medium text-foreground' : 'text-ink-2'}`}>
                    {workspace.name}
                  </span>
                  {hoveredWorkspaceId === workspace.id && (
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <button
                        onClick={(e) => handleRenameClick(e, workspace)}
                        className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                        title="Rename"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      {!isCurrent && (
                        <button
                          onClick={(e) => handleDeleteClick(e, workspace.id)}
                          className="rounded p-0.5 text-muted-foreground transition-colors hover:text-risk"
                          title="Delete"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )}
                  {!hoveredWorkspaceId || hoveredWorkspaceId !== workspace.id ? (
                    isCurrent ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-foreground" strokeWidth={2} /> : null
                  ) : null}
                </div>
              );
            })}
            <div className="-mx-1 my-1 h-px bg-border/70" />
            {isWorkspaceLimitReached ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDropdownOpen(false);
                  navigate('/settings?section=billing');
                }}
                className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-[13px] text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground"
                title={`Workspace limit reached (${usageData?.usage?.workspaces?.limit ?? 1} on ${usageData?.plan?.name ?? 'Trial ended'})`}
              >
                <span className="flex items-center gap-2">
                  <Lock className="h-3.5 w-3.5" />
                  New workspace
                </span>
                <span className="text-[11.5px] text-muted-foreground">Upgrade</span>
              </button>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setCreateDialogOpen(true); }}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                New workspace
              </button>
            )}
          </div>
        )}
      </div>

      {/* Create Workspace Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="workspace-name">Name</Label>
              <Input
                id="workspace-name"
                placeholder="Workspace name"
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !creating) {
                    createWorkspace();
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>Icon <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <div className="grid grid-cols-6 gap-2">
                {workspaceIcons.map((iconItem) => {
                  const IconComponent = iconItem.icon;
                  const iconValue = iconItem.name;
                  return (
                    <Card
                      key={iconValue}
                      className={`flex aspect-square cursor-pointer items-center justify-center rounded-lg shadow-none transition-colors duration-fast ${
                        newWorkspaceIcon === iconValue
                          ? "border-foreground/60 bg-hover"
                          : "border-border hover:bg-hover"
                      }`}
                      onClick={() => setNewWorkspaceIcon(newWorkspaceIcon === iconValue ? null : iconValue)}
                    >
                      <IconComponent className="h-4 w-4 text-ink-2" strokeWidth={1.6} />
                    </Card>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              onClick={() => createWorkspace()}
              disabled={creating}
            >
              {creating ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Billing Confirmation Dialog */}
      <Dialog open={billingDialogOpen} onOpenChange={setBillingDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a workspace</DialogTitle>
            <DialogDescription>
              Additional workspaces require a monthly subscription.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {billingInfo && (
              <>
                <div className="space-y-2 rounded-lg border border-border px-4 py-3 text-[13px]">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Workspace</span>
                    <span className="font-medium">{pendingWorkspace?.name}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Additional cost</span>
                    <span className="font-medium tabular-nums">${billingInfo.monthlyPrice}/month</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Your plan</span>
                    <span className="capitalize">{billingInfo.planName}</span>
                  </div>
                </div>
                <p className="text-[12.5px] text-muted-foreground">
                  You'll be charged a prorated amount today, then ${billingInfo.monthlyPrice}/month on your regular billing date.
                </p>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleBillingCancel}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleBillingConfirm}
              disabled={creating}
            >
              {creating ? 'Creating…' : 'Create and add to plan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Workspace Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteWorkspaceData?.name ?? "workspace"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the workspace and everything in it. It can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={deleteWorkspace}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Rename Workspace Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="Workspace name"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !renaming) renameWorkspace(); }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)} disabled={renaming}>Cancel</Button>
            <Button onClick={renameWorkspace} disabled={renaming || !renameValue.trim()}>
              {renaming ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
