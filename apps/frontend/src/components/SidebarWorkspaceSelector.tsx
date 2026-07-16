import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Plus, Check, Folder, Trash2, CreditCard, ChevronsUpDown, Pencil, Lock } from 'lucide-react';
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

  const switchWorkspace = async (workspaceId: string) => {
    if (currentWorkspace?.id === workspaceId) {
      return;
    }

    if (loading) {
      return;
    }

    try {
      setLoading(true);

      localStorage.setItem('selectedWorkspaceId', workspaceId);
      window.dispatchEvent(new CustomEvent('nous:workspace-changed', { detail: { workspaceId } }));

      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const response = await fetch(`${apiUrl}/me?workspace_id=${workspaceId}`, {
        headers: {
          'Authorization': `Bearer ${session?.access_token}`,
        },
      });

      if (response.ok) {
        const selectedWorkspace = workspaces.find(w => w.id === workspaceId);

        await refreshUserData();

        lastFetchRef.current = 0;
        await fetchWorkspaces();

        await fetchUsageData(workspaceId);

        toast({
          title: 'Workspace switched',
          description: `Switched to ${selectedWorkspace?.name || 'workspace'}`,
        });
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.error('[WORKSPACE_SWITCH] Error:', response.status, errorData);
        if (currentWorkspace?.id) {
          localStorage.setItem('selectedWorkspaceId', currentWorkspace.id);
        }
        toast({
          title: 'Error',
          description: errorData.message || 'Failed to switch workspace',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('[WORKSPACE_SWITCH] Exception:', error);
      if (currentWorkspace?.id) {
        localStorage.setItem('selectedWorkspaceId', currentWorkspace.id);
      }
      toast({
        title: 'Error',
        description: 'Failed to switch workspace',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
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
            <div className="flex items-center justify-center w-8 h-8 rounded-lg">
              {WorkspaceIcon ? (
                <WorkspaceIcon className="h-4 w-4 text-gray-600 dark:text-foreground/80" />
              ) : (
                <Folder className="h-4 w-4 text-gray-600 dark:text-foreground/80" />
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 w-full px-2 py-1.5 min-w-0">
              <span className="flex-1 text-[13px] font-semibold text-gray-800 dark:text-foreground truncate text-left leading-tight">
                {currentWorkspace?.name || 'Workspace'}
              </span>
            </div>
          )
        ) : collapsed ? (
          <button
            onClick={() => setDropdownOpen(o => !o)}
            className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-gray-100/70 dark:hover:bg-white/[0.05] transition-all duration-150"
            disabled={loading}
          >
            {WorkspaceIcon ? (
              <WorkspaceIcon className="h-4 w-4 text-gray-600 dark:text-foreground/80" />
            ) : (
              <Folder className="h-4 w-4 text-gray-600 dark:text-foreground/80" />
            )}
          </button>
        ) : (
          <button
            onClick={() => setDropdownOpen(o => !o)}
            className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-lg hover:bg-gray-100/70 dark:hover:bg-white/[0.05] transition-all duration-150 min-w-0"
            disabled={loading}
          >
            <span className="flex-1 text-[13px] font-semibold text-gray-800 dark:text-foreground truncate text-left leading-tight">
              {currentWorkspace?.name || 'Workspace'}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 text-gray-400 dark:text-muted-foreground flex-shrink-0" />
          </button>
        )}

        {/* Inline popover — no external popup (hidden on self-host) */}
        {!selfHosted && dropdownOpen && (
          <div className="absolute left-0 top-full mt-1 w-full z-50 bg-popover text-popover-foreground rounded-xl border border-border shadow-lg dark:shadow-2xl dark:shadow-black/40 py-1 overflow-hidden">
            {workspaces.map((workspace) => {
              const isCurrent = currentWorkspace?.id === workspace.id;
              return (
                <div
                  key={workspace.id}
                  className="group flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-white/[0.05] transition-colors"
                  onMouseEnter={() => setHoveredWorkspaceId(workspace.id)}
                  onMouseLeave={() => setHoveredWorkspaceId(null)}
                  onClick={() => {
                    setDropdownOpen(false);
                    switchWorkspace(workspace.id);
                  }}
                >
                  <span className={`flex-1 text-[13px] truncate ${isCurrent ? 'font-semibold text-gray-900 dark:text-foreground' : 'text-gray-600 dark:text-muted-foreground'}`}>
                    {workspace.name}
                  </span>
                  {hoveredWorkspaceId === workspace.id && (
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <button
                        onClick={(e) => handleRenameClick(e, workspace)}
                        className="p-0.5 rounded text-gray-400 dark:text-muted-foreground hover:text-gray-700 dark:hover:text-foreground transition-colors"
                        title="Rename"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      {!isCurrent && (
                        <button
                          onClick={(e) => handleDeleteClick(e, workspace.id)}
                          className="p-0.5 rounded text-gray-400 dark:text-muted-foreground hover:text-red-500 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )}
                  {!hoveredWorkspaceId || hoveredWorkspaceId !== workspace.id ? (
                    isCurrent ? <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400 flex-shrink-0" /> : null
                  ) : null}
                </div>
              );
            })}
            <div className="mx-2 my-1 border-t border-gray-100 dark:border-border" />
            {isWorkspaceLimitReached ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDropdownOpen(false);
                  navigate('/settings?section=billing');
                }}
                className="flex items-center justify-between w-full px-3 py-2 text-[13px] text-gray-500 dark:text-muted-foreground hover:text-gray-900 dark:hover:text-foreground hover:bg-gray-50 dark:hover:bg-white/[0.05] transition-colors"
                title={`Workspace limit reached (${usageData?.usage?.workspaces?.limit ?? 1} on ${usageData?.plan?.name ?? 'Free'})`}
              >
                <span className="flex items-center gap-2">
                  <Lock className="h-3.5 w-3.5" />
                  New workspace
                </span>
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold">
                  Upgrade
                </span>
              </button>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setCreateDialogOpen(true); }}
                className="flex items-center gap-2 w-full px-3 py-2 text-[13px] text-gray-500 dark:text-muted-foreground hover:text-gray-900 dark:hover:text-foreground hover:bg-gray-50 dark:hover:bg-white/[0.05] transition-colors"
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
            <DialogTitle>Create Workspace</DialogTitle>
            <DialogDescription>
              Create a new workspace to organize your documents and templates.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="workspace-name">Workspace Name</Label>
              <Input
                id="workspace-name"
                placeholder="My Workspace"
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
              <Label>Workspace Icon (Optional)</Label>
              <div className="grid grid-cols-6 gap-2">
                {workspaceIcons.map((iconItem) => {
                  const IconComponent = iconItem.icon;
                  const iconValue = iconItem.name;
                  return (
                    <Card
                      key={iconValue}
                      className={`aspect-square flex items-center justify-center cursor-pointer transition-all hover:scale-110 ${
                        newWorkspaceIcon === iconValue
                          ? "border-2 border-[#2D2D2D] bg-gray-50"
                          : "border border-gray-200 hover:border-gray-300 bg-white"
                      }`}
                      onClick={() => setNewWorkspaceIcon(newWorkspaceIcon === iconValue ? null : iconValue)}
                    >
                      <IconComponent className="h-5 w-5 text-gray-500" />
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
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Billing Confirmation Dialog */}
      <Dialog open={billingDialogOpen} onOpenChange={setBillingDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              Add Workspace
            </DialogTitle>
            <DialogDescription>
              Additional workspaces require a monthly subscription.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {billingInfo && (
              <>
                <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Workspace name</span>
                    <span className="font-medium">{pendingWorkspace?.name}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Additional cost</span>
                    <span className="font-medium text-lg">${billingInfo.monthlyPrice}/month</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Your plan</span>
                    <span className="capitalize">{billingInfo.planName}</span>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
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
              {creating ? 'Creating...' : 'Create & Add to Subscription'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Workspace Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Workspace</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteWorkspaceData?.name}"? This action cannot be undone and will delete all associated data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={deleteWorkspace}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Rename Workspace Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Workspace</DialogTitle>
            <DialogDescription>Enter a new name for this workspace.</DialogDescription>
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
              {renaming ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
