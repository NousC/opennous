import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Search,
  Loader2,
  ExternalLink,
  User,
  Users,
  Mail,
  Calendar,
  Trash2,
  AlertTriangle,
  Clock,
  CheckCircle2,
  XCircle,
  CreditCard,
  Building2,
  MoreVertical,
  RefreshCw,
  Copy,
  Link,
  Crown,
  Sparkles,
  BarChart3
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/components/ui/sonner";
import { format, formatDistanceToNow } from "date-fns";
import { FeedbackAnalytics } from "@/components/admin/FeedbackAnalytics";

interface UserSubscription {
  plan_name: string;
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  stripe_subscription_id: string | null;
}

interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  profile_picture_url: string | null;
  created_at: string;
  is_admin: boolean;
  team_id: string | null;
  team_name: string | null;
  subscription: UserSubscription | null;
}

export default function AdminSupportDashboard() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [generatingLink, setGeneratingLink] = useState<string | null>(null);
  const [deleteConfirmUser, setDeleteConfirmUser] = useState<UserRecord | null>(null);
  const [deleteStep, setDeleteStep] = useState<1 | 2>(1);
  const [deleting, setDeleting] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [magicLinkData, setMagicLinkData] = useState<{ link: string; user: UserRecord } | null>(null);

  // Plan assignment state
  const [assignPlanUser, setAssignPlanUser] = useState<UserRecord | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<string>("scale");
  const [assigningPlan, setAssigningPlan] = useState(false);

  useEffect(() => {
    if (session) {
      loadUsers();
    }
  }, [session]);

  const loadUsers = async () => {
    if (!session?.access_token) {
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/admin/users', {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[AdminUsers] Error response:', errorText);
        throw new Error('Failed to load users');
      }

      const data = await response.json();
      setUsers(data || []);
    } catch (error) {
      console.error('[AdminUsers] Failed to load users:', error);
      toast.error('Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  const handleImpersonate = async (user: UserRecord) => {
    if (!session?.access_token) return;

    setGeneratingLink(user.id);
    try {
      const response = await fetch(`/api/admin/impersonate/${user.id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to generate login link');
      }

      const data = await response.json();
      setMagicLinkData({ link: data.magic_link, user });
      toast.success('Login link generated!');
    } catch (error: any) {
      console.error('Failed to generate login link:', error);
      toast.error(error.message || 'Failed to generate login link');
    } finally {
      setGeneratingLink(null);
    }
  };

  const copyMagicLink = async () => {
    if (!magicLinkData) return;
    try {
      await navigator.clipboard.writeText(magicLinkData.link);
      toast.success('Link copied to clipboard!');
    } catch (err) {
      toast.error('Failed to copy link');
    }
  };

  const handleDeleteClick = (user: UserRecord) => {
    setDeleteConfirmUser(user);
    setDeleteStep(1);
  };

  const handleDeleteConfirm = async () => {
    if (deleteStep === 1) {
      setDeleteStep(2);
      return;
    }

    if (!deleteConfirmUser || !session?.access_token) return;

    setDeleting(true);
    try {
      const response = await fetch(`/api/admin/users/${deleteConfirmUser.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to delete user');
      }

      toast.success(`User ${deleteConfirmUser.email} deleted successfully`);
      setDeleteConfirmUser(null);
      setDeleteStep(1);
      loadUsers();
    } catch (error: any) {
      console.error('Failed to delete user:', error);
      toast.error(error.message || 'Failed to delete user');
    } finally {
      setDeleting(false);
    }
  };

  const handleAssignPlan = async () => {
    if (!assignPlanUser || !session?.access_token) return;

    setAssigningPlan(true);
    try {
      const response = await fetch(`/api/admin/users/${assignPlanUser.id}/assign-plan`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ planName: selectedPlan }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to assign plan');
      }

      toast.success(`${selectedPlan.charAt(0).toUpperCase() + selectedPlan.slice(1)} plan assigned to ${assignPlanUser.email}`);
      setAssignPlanUser(null);
      loadUsers();
    } catch (error: any) {
      console.error('Failed to assign plan:', error);
      toast.error(error.message || 'Failed to assign plan');
    } finally {
      setAssigningPlan(false);
    }
  };

  const getSubscriptionBadge = (subscription: UserSubscription | null) => {
    if (!subscription) {
      return (
        <Badge variant="outline" className="bg-gray-50 text-gray-600 border-gray-200">
          No Subscription
        </Badge>
      );
    }

    const { status, plan_name } = subscription;

    if (status === 'trial') {
      const trialEnds = subscription.trial_ends_at ? new Date(subscription.trial_ends_at) : null;
      const isExpired = trialEnds && trialEnds < new Date();
      return (
        <div className="flex items-center gap-2">
          <Badge className={isExpired ? "bg-red-100 text-red-700 border-red-200" : "bg-amber-100 text-amber-700 border-amber-200"}>
            <Clock className="h-3 w-3 mr-1" />
            {isExpired ? 'Trial Expired' : 'Trial'}
          </Badge>
          {trialEnds && !isExpired && (
            <span className="text-xs text-muted-foreground">
              {formatDistanceToNow(trialEnds, { addSuffix: true })}
            </span>
          )}
        </div>
      );
    }

    if (status === 'active') {
      const planColors: Record<string, string> = {
        'free': 'bg-gray-100 text-gray-700 border-gray-200',
        'starter': 'bg-emerald-100 text-emerald-700 border-emerald-200',
        'pro': 'bg-blue-100 text-blue-700 border-blue-200',
        'growth': 'bg-indigo-100 text-indigo-700 border-indigo-200',
        'scale': 'bg-purple-100 text-purple-700 border-purple-200',
      };
      const PlanIcon = plan_name === 'scale' ? Crown : CheckCircle2;
      return (
        <Badge className={planColors[plan_name] || 'bg-green-100 text-green-700 border-green-200'}>
          <PlanIcon className="h-3 w-3 mr-1" />
          {plan_name?.charAt(0).toUpperCase() + plan_name?.slice(1) || 'Active'}
        </Badge>
      );
    }

    if (status === 'canceled') {
      return (
        <Badge className="bg-red-100 text-red-700 border-red-200">
          <XCircle className="h-3 w-3 mr-1" />
          Canceled
        </Badge>
      );
    }

    if (status === 'past_due') {
      return (
        <Badge className="bg-orange-100 text-orange-700 border-orange-200">
          <AlertTriangle className="h-3 w-3 mr-1" />
          Past Due
        </Badge>
      );
    }

    return (
      <Badge variant="outline" className="bg-gray-50 text-gray-600">
        {status}
      </Badge>
    );
  };

  const filteredUsers = users.filter(user => {
    // Text search
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesSearch =
        user.email?.toLowerCase().includes(query) ||
        user.name?.toLowerCase().includes(query) ||
        user.team_name?.toLowerCase().includes(query);
      if (!matchesSearch) return false;
    }

    // Status filter
    if (filterStatus !== "all") {
      const status = user.subscription?.status || "none";
      if (filterStatus === "none" && status !== "none" && user.subscription) return false;
      if (filterStatus !== "none" && status !== filterStatus) return false;
    }

    return true;
  });

  // Stats
  const totalUsers = users.length;
  const activeUsers = users.filter(u => u.subscription?.status === 'active').length;
  const trialUsers = users.filter(u => u.subscription?.status === 'trial').length;
  const canceledUsers = users.filter(u => u.subscription?.status === 'canceled').length;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate('/')}
                className="h-9 w-9"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="text-xl font-semibold">Admin Dashboard</h1>
                <p className="text-sm text-muted-foreground">Manage users and view AI feedback analytics</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        <Tabs defaultValue="users" className="w-full">
          <TabsList className="mb-6">
            <TabsTrigger value="users" className="gap-2">
              <Users className="h-4 w-4" />
              Users
            </TabsTrigger>
            <TabsTrigger value="feedback" className="gap-2">
              <BarChart3 className="h-4 w-4" />
              AI Feedback
            </TabsTrigger>
          </TabsList>

          <TabsContent value="users">
            {/* Users Tab Header */}
            <div className="flex items-center justify-end mb-6">
              <Button onClick={loadUsers} disabled={loading} variant="outline" className="gap-2">
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Users className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-2xl font-semibold">{totalUsers}</p>
                  <p className="text-sm text-muted-foreground">Total Users</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <p className="text-2xl font-semibold">{activeUsers}</p>
                  <p className="text-sm text-muted-foreground">Active Subscriptions</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-100 rounded-lg">
                  <Clock className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <p className="text-2xl font-semibold">{trialUsers}</p>
                  <p className="text-sm text-muted-foreground">On Trial</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-100 rounded-lg">
                  <XCircle className="h-5 w-5 text-red-600" />
                </div>
                <div>
                  <p className="text-2xl font-semibold">{canceledUsers}</p>
                  <p className="text-sm text-muted-foreground">Canceled</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name, email, or team..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant={filterStatus === "all" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilterStatus("all")}
                >
                  All
                </Button>
                <Button
                  variant={filterStatus === "active" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilterStatus("active")}
                >
                  Active
                </Button>
                <Button
                  variant={filterStatus === "trial" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilterStatus("trial")}
                >
                  Trial
                </Button>
                <Button
                  variant={filterStatus === "canceled" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilterStatus("canceled")}
                >
                  Canceled
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* User Table */}
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <User className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium">No users found</p>
                <p className="text-sm">Try adjusting your search or filters</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-gray-50">
                    <TableHead className="w-[300px]">User</TableHead>
                    <TableHead>Subscription</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUsers.map((user) => (
                    <TableRow key={user.id} className="hover:bg-gray-50">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-10 w-10">
                            <AvatarImage src={user.profile_picture_url || undefined} />
                            <AvatarFallback className="bg-primary/10 text-primary">
                              {user.name?.[0] || user.email?.[0] || 'U'}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">{user.name || 'No name'}</span>
                              {user.is_admin && (
                                <Badge variant="outline" className="text-xs bg-red-50 text-red-700 border-red-200">
                                  Admin
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Mail className="h-3 w-3 flex-shrink-0" />
                              <span className="truncate">{user.email}</span>
                            </div>
                            {user.team_name && (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                                <Building2 className="h-3 w-3 flex-shrink-0" />
                                <span className="truncate">{user.team_name}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          {getSubscriptionBadge(user.subscription)}
                          {user.subscription?.current_period_end && user.subscription.status === 'active' && (
                            <p className="text-xs text-muted-foreground">
                              Renews {format(new Date(user.subscription.current_period_end), 'MMM d, yyyy')}
                            </p>
                          )}
                          {user.subscription?.canceled_at && (
                            <p className="text-xs text-red-600">
                              Canceled {format(new Date(user.subscription.canceled_at), 'MMM d, yyyy')}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <p>{format(new Date(user.created_at), 'MMM d, yyyy')}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(user.created_at), { addSuffix: true })}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem
                              onClick={() => handleImpersonate(user)}
                              disabled={generatingLink === user.id}
                            >
                              {generatingLink === user.id ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              ) : (
                                <Link className="h-4 w-4 mr-2" />
                              )}
                              Get Login Link
                            </DropdownMenuItem>
                            {user.subscription?.stripe_subscription_id && (
                              <DropdownMenuItem
                                onClick={() => window.open(`https://dashboard.stripe.com/subscriptions/${user.subscription?.stripe_subscription_id}`, '_blank')}
                              >
                                <CreditCard className="h-4 w-4 mr-2" />
                                View in Stripe
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => {
                                setAssignPlanUser(user);
                                setSelectedPlan("scale");
                              }}
                            >
                              <Crown className="h-4 w-4 mr-2" />
                              Assign Plan
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleDeleteClick(user)}
                              className="text-red-600 focus:text-red-600"
                              disabled={user.is_admin}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete User
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
          </TabsContent>

          <TabsContent value="feedback">
            <Card>
              <CardHeader>
                <CardTitle>AI Writer Feedback Analytics</CardTitle>
              </CardHeader>
              <CardContent>
                <FeedbackAnalytics />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirmUser} onOpenChange={(open) => {
        if (!open) {
          setDeleteConfirmUser(null);
          setDeleteStep(1);
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              {deleteStep === 1 ? 'Delete User' : 'Final Confirmation'}
            </DialogTitle>
            <DialogDescription>
              {deleteStep === 1 ? (
                <>
                  Are you sure you want to delete <strong>{deleteConfirmUser?.email}</strong>?
                  <br /><br />
                  This will permanently delete:
                  <ul className="list-disc list-inside mt-2 space-y-1 text-sm">
                    <li>The user account</li>
                    <li>Their team and subscriptions</li>
                    <li>All workspaces they own</li>
                    <li>All related data</li>
                  </ul>
                </>
              ) : (
                <>
                  <strong className="text-red-600">This action cannot be undone.</strong>
                  <br /><br />
                  Please confirm you want to permanently delete <strong>{deleteConfirmUser?.email}</strong> and all associated data.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setDeleteConfirmUser(null);
                setDeleteStep(1);
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleting}
              className="gap-2"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              {deleteStep === 1 ? 'Continue' : 'Delete Permanently'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Magic Link Dialog */}
      <Dialog open={!!magicLinkData} onOpenChange={(open) => {
        if (!open) setMagicLinkData(null);
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link className="h-5 w-5" />
              Login Link Generated
            </DialogTitle>
            <DialogDescription>
              Use this link to log in as <strong>{magicLinkData?.user.email}</strong>.
              Open it in a different browser or incognito window to keep your admin session.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <div className="flex-1 p-3 bg-muted rounded-md text-sm font-mono break-all max-h-24 overflow-y-auto">
                {magicLinkData?.link}
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={copyMagicLink} className="flex-1 gap-2">
                <Copy className="h-4 w-4" />
                Copy Link
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  window.open(magicLinkData?.link, '_blank');
                }}
                className="flex-1 gap-2"
              >
                <ExternalLink className="h-4 w-4" />
                Open in New Tab
              </Button>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              This link expires in 24 hours and can only be used once.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Assign Plan Dialog */}
      <Dialog open={!!assignPlanUser} onOpenChange={(open) => {
        if (!open) setAssignPlanUser(null);
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Crown className="h-5 w-5 text-amber-500" />
              Assign Plan
            </DialogTitle>
            <DialogDescription>
              Assign a subscription plan to <strong>{assignPlanUser?.email}</strong>.
              This will override any existing subscription.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-3">
              <label className="text-sm font-medium">Select Plan</label>
              <div className="grid grid-cols-1 gap-2">
                <button
                  onClick={() => setSelectedPlan("free")}
                  className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left ${
                    selectedPlan === "free"
                      ? "border-gray-500 bg-gray-50"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <CheckCircle2 className={`h-5 w-5 ${selectedPlan === "free" ? "text-gray-500" : "text-gray-400"}`} />
                  <div>
                    <p className="font-medium">Free</p>
                    <p className="text-xs text-muted-foreground">1,000 ops/mo · 1 workspace</p>
                  </div>
                </button>
                <button
                  onClick={() => setSelectedPlan("starter")}
                  className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left ${
                    selectedPlan === "starter"
                      ? "border-emerald-500 bg-emerald-50"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <CheckCircle2 className={`h-5 w-5 ${selectedPlan === "starter" ? "text-emerald-500" : "text-gray-400"}`} />
                  <div>
                    <p className="font-medium">Start</p>
                    <p className="text-xs text-muted-foreground">10,000 ops/mo · 1 workspace</p>
                  </div>
                </button>
                <button
                  onClick={() => setSelectedPlan("pro")}
                  className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left ${
                    selectedPlan === "pro"
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <Sparkles className={`h-5 w-5 ${selectedPlan === "pro" ? "text-blue-500" : "text-gray-400"}`} />
                  <div>
                    <p className="font-medium">Pro</p>
                    <p className="text-xs text-muted-foreground">25,000 ops/mo · 1 workspace · lead database · LinkedIn engagement</p>
                  </div>
                </button>
                <button
                  onClick={() => setSelectedPlan("growth")}
                  className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left ${
                    selectedPlan === "growth"
                      ? "border-indigo-500 bg-indigo-50"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <Sparkles className={`h-5 w-5 ${selectedPlan === "growth" ? "text-indigo-500" : "text-gray-400"}`} />
                  <div>
                    <p className="font-medium">Growth</p>
                    <p className="text-xs text-muted-foreground">100,000 ops/mo · 3 workspaces · CRM synchronization</p>
                  </div>
                </button>
                <button
                  onClick={() => setSelectedPlan("scale")}
                  className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left ${
                    selectedPlan === "scale"
                      ? "border-purple-500 bg-purple-50"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <Crown className={`h-5 w-5 ${selectedPlan === "scale" ? "text-purple-500" : "text-gray-400"}`} />
                  <div>
                    <p className="font-medium">Partner</p>
                    <p className="text-xs text-muted-foreground">$100/client · 5 included (500k ops) · multi-client dashboard</p>
                  </div>
                </button>
              </div>
            </div>
            {assignPlanUser?.subscription?.plan_name && (
              <div className="p-3 bg-muted rounded-md text-sm">
                <span className="text-muted-foreground">Current plan: </span>
                <span className="font-medium capitalize">{assignPlanUser.subscription.plan_name}</span>
              </div>
            )}
          </div>
          <DialogFooter className="flex gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setAssignPlanUser(null)}
              disabled={assigningPlan}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAssignPlan}
              disabled={assigningPlan}
              className="gap-2"
            >
              {assigningPlan && <Loader2 className="h-4 w-4 animate-spin" />}
              Assign {selectedPlan.charAt(0).toUpperCase() + selectedPlan.slice(1)} Plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
