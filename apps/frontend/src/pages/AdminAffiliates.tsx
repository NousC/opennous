import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Search,
  Loader2,
  Users,
  DollarSign,
  CheckCircle2,
  Clock,
  Copy,
  MoreVertical,
  Handshake,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/components/ui/sonner";
import { formatDistanceToNow } from "date-fns";

interface AffiliateRecord {
  id: string;
  user_id: string;
  referral_code: string;
  commission_rate: string;
  status: string;
  payout_email: string | null;
  payout_method: string;
  total_referrals: number;
  total_earnings_cents: number;
  paid_out_cents: number;
  created_at: string;
  updated_at: string;
  user: {
    email: string;
    name: string | null;
  } | null;
}

interface PayoutRecord {
  id: string;
  affiliate_id: string;
  commission_amount_cents: number;
  status: string;
  paid_at: string | null;
  payout_batch_id: string | null;
  notes: string | null;
  created_at: string;
}

export default function AdminAffiliates() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [affiliates, setAffiliates] = useState<AffiliateRecord[]>([]);
  const [payouts, setPayouts] = useState<PayoutRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [activeTab, setActiveTab] = useState<string>("affiliates");
  const [approving, setApproving] = useState<string | null>(null);
  const [payDialog, setPayDialog] = useState<AffiliateRecord | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    if (session) loadAffiliates();
  }, [session]);

  const loadAffiliates = async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/affiliates?limit=200`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error("Failed to load affiliates");
      const data = await res.json();
      setAffiliates(data.affiliates || []);
      setPayouts(data.payouts || []);
    } catch (err) {
      console.error("[AdminAffiliates]", err);
      toast.error("Failed to load affiliates");
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (affiliate: AffiliateRecord) => {
    if (!session?.access_token) return;
    setApproving(affiliate.id);
    try {
      const res = await fetch(`/api/admin/affiliates/${affiliate.id}/approve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ commissionRate: 0.25 }),
      });
      if (!res.ok) throw new Error("Failed to approve");
      toast.success(`Approved ${affiliate.user?.email || affiliate.referral_code}`);
      loadAffiliates();
    } catch (err) {
      toast.error("Failed to approve affiliate");
    } finally {
      setApproving(null);
    }
  };

  const handleDelete = async (affiliate: AffiliateRecord) => {
    if (!session?.access_token) return;
    if (!confirm(`Delete affiliate ${affiliate.user?.email || affiliate.referral_code}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/admin/affiliates/${affiliate.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error("Failed to delete");
      toast.success("Affiliate deleted");
      loadAffiliates();
    } catch (err) {
      toast.error("Failed to delete affiliate");
    }
  };

  const handleMarkPaid = async () => {
    if (!session?.access_token || !payDialog || !payAmount) return;
    setPaying(true);
    try {
      const res = await fetch(`/api/admin/affiliates/${payDialog.id}/mark-paid`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: parseFloat(payAmount),
          notes: payNotes || `PayPal payout to ${payDialog.payout_email || payDialog.user?.email}`,
        }),
      });
      if (!res.ok) throw new Error("Failed to mark paid");
      toast.success(`Marked $${payAmount} as paid to ${payDialog.payout_email || payDialog.user?.email}`);
      setPayDialog(null);
      setPayAmount("");
      setPayNotes("");
      loadAffiliates();
    } catch (err) {
      toast.error("Failed to mark as paid");
    } finally {
      setPaying(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  };

  // Stats
  const stats = useMemo(() => {
    const active = affiliates.filter((a) => a.status === "active").length;
    const pending = affiliates.filter((a) => a.status === "pending").length;
    const totalReferrals = affiliates.reduce((s, a) => s + a.total_referrals, 0);
    const totalEarnings = affiliates.reduce((s, a) => s + a.total_earnings_cents, 0) / 100;
    const totalPaid = affiliates.reduce((s, a) => s + a.paid_out_cents, 0) / 100;
    const unpaid = totalEarnings - totalPaid;
    return { active, pending, totalReferrals, totalEarnings, totalPaid, unpaid };
  }, [affiliates]);

  // Filter affiliates
  const filtered = useMemo(() => {
    let list = affiliates;
    if (filterStatus !== "all") {
      list = list.filter((a) => a.status === filterStatus);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (a) =>
          (a.user?.email || "").toLowerCase().includes(q) ||
          (a.user?.name || "").toLowerCase().includes(q) ||
          a.referral_code.toLowerCase().includes(q) ||
          (a.payout_email || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [affiliates, filterStatus, searchQuery]);

  const statusBadge = (status: string) => {
    switch (status) {
      case "active":
        return <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">Active</Badge>;
      case "pending":
        return <Badge className="bg-amber-100 text-amber-700 border-amber-200">Pending</Badge>;
      case "paused":
        return <Badge className="bg-gray-100 text-gray-600 border-gray-200">Paused</Badge>;
      case "terminated":
        return <Badge className="bg-red-100 text-red-700 border-red-200">Terminated</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  // Helper to find affiliate name by id for payout history
  const getAffiliateName = (affiliateId: string) => {
    const a = affiliates.find((af) => af.id === affiliateId);
    return a?.user?.name || a?.user?.email || a?.referral_code || "Unknown";
  };
  const getAffiliatePaypalEmail = (affiliateId: string) => {
    const a = affiliates.find((af) => af.id === affiliateId);
    return a?.payout_email || a?.user?.email || "—";
  };

  return (
    <div className="min-h-screen bg-gray-50/50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <div>
                <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
                  <Handshake className="h-5 w-5 text-gray-500" />
                  Affiliate Program
                </h1>
                <p className="text-sm text-muted-foreground">Manage affiliates, track referrals, and process payouts</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={loadAffiliates} className="gap-2">
              <Loader2 className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Stats cards */}
        <div className="grid grid-cols-5 gap-4">
          <Card className="border-gray-200">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Handshake className="h-4 w-4 text-emerald-500" />
                <span className="text-xs text-muted-foreground font-medium">Active</span>
              </div>
              <p className="text-2xl font-bold text-gray-900">{stats.active}</p>
              <p className="text-xs text-muted-foreground">{stats.pending} pending</p>
            </CardContent>
          </Card>
          <Card className="border-gray-200">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Users className="h-4 w-4 text-blue-500" />
                <span className="text-xs text-muted-foreground font-medium">Referrals</span>
              </div>
              <p className="text-2xl font-bold text-gray-900">{stats.totalReferrals}</p>
              <p className="text-xs text-muted-foreground">Total sign-ups</p>
            </CardContent>
          </Card>
          <Card className="border-gray-200">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <DollarSign className="h-4 w-4 text-emerald-500" />
                <span className="text-xs text-muted-foreground font-medium">Total Earned</span>
              </div>
              <p className="text-2xl font-bold text-gray-900">${stats.totalEarnings.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">All affiliates</p>
            </CardContent>
          </Card>
          <Card className="border-gray-200">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-xs text-muted-foreground font-medium">Paid Out</span>
              </div>
              <p className="text-2xl font-bold text-gray-900">${stats.totalPaid.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">Processed</p>
            </CardContent>
          </Card>
          <Card className="border-gray-200">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Clock className="h-4 w-4 text-amber-500" />
                <span className="text-xs text-muted-foreground font-medium">Unpaid</span>
              </div>
              <p className="text-2xl font-bold text-gray-900 text-amber-600">${stats.unpaid.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">Pending payout</p>
            </CardContent>
          </Card>
        </div>

        {/* Main tabs: Affiliates vs Payout History */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="flex items-center justify-between">
            <TabsList className="h-9">
              <TabsTrigger value="affiliates" className="text-xs">Affiliates ({affiliates.length})</TabsTrigger>
              <TabsTrigger value="payouts" className="text-xs">Payout History ({payouts.length})</TabsTrigger>
            </TabsList>

            {activeTab === "affiliates" && (
              <div className="flex items-center gap-3">
                <div className="relative max-w-sm">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search name, email, code..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 h-9 w-64"
                  />
                </div>
                <Tabs value={filterStatus} onValueChange={setFilterStatus}>
                  <TabsList className="h-9">
                    <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
                    <TabsTrigger value="active" className="text-xs">Active</TabsTrigger>
                    <TabsTrigger value="pending" className="text-xs">Pending</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            )}
          </div>
        </Tabs>

        {/* Affiliates Table */}
        {activeTab === "affiliates" && (
          <Card className="border-gray-200">
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50/50">
                  <TableHead className="font-medium">Affiliate</TableHead>
                  <TableHead className="font-medium">Code</TableHead>
                  <TableHead className="font-medium">Status</TableHead>
                  <TableHead className="font-medium">PayPal Email</TableHead>
                  <TableHead className="font-medium text-center">Referrals</TableHead>
                  <TableHead className="font-medium text-right">Earned</TableHead>
                  <TableHead className="font-medium text-right">Paid</TableHead>
                  <TableHead className="font-medium text-right">Unpaid</TableHead>
                  <TableHead className="font-medium">Joined</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-12">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                      {searchQuery || filterStatus !== "all"
                        ? "No affiliates match your filters"
                        : "No affiliates yet"}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((a) => {
                    const earned = a.total_earnings_cents / 100;
                    const paid = a.paid_out_cents / 100;
                    const unpaid = earned - paid;
                    const paypalEmail = a.payout_email || a.user?.email || "";

                    return (
                      <TableRow key={a.id} className="group">
                        <TableCell>
                          <div>
                            <p className="font-medium text-gray-900 text-sm">
                              {a.user?.name || "—"}
                            </p>
                            <p className="text-xs text-muted-foreground">{a.user?.email || "—"}</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <button
                            onClick={() => copyToClipboard(`https://opennous.cloud/signup?ref=${a.referral_code}`, "Referral link")}
                            className="inline-flex items-center gap-1 font-mono text-xs bg-gray-100 px-2 py-1 rounded hover:bg-gray-200 transition-colors"
                            title="Click to copy referral link"
                          >
                            {a.referral_code}
                            <Copy className="h-3 w-3 text-gray-400" />
                          </button>
                        </TableCell>
                        <TableCell>{statusBadge(a.status)}</TableCell>
                        <TableCell>
                          {paypalEmail ? (
                            <button
                              onClick={() => copyToClipboard(paypalEmail, "PayPal email")}
                              className="inline-flex items-center gap-1.5 text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded hover:bg-blue-100 transition-colors max-w-[180px]"
                              title="Click to copy PayPal email"
                            >
                              <span className="truncate">{paypalEmail}</span>
                              <Copy className="h-3 w-3 text-blue-400 shrink-0" />
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not set</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center text-sm font-medium">
                          {a.total_referrals}
                        </TableCell>
                        <TableCell className="text-right text-sm">${earned.toFixed(2)}</TableCell>
                        <TableCell className="text-right text-sm text-emerald-600">
                          ${paid.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {unpaid > 0 ? (
                            <span className="font-medium text-amber-600">${unpaid.toFixed(2)}</span>
                          ) : (
                            <span className="text-gray-400">$0.00</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              {a.status === "pending" && (
                                <DropdownMenuItem
                                  onClick={() => handleApprove(a)}
                                  disabled={approving === a.id}
                                >
                                  <CheckCircle2 className="h-4 w-4 mr-2 text-emerald-500" />
                                  {approving === a.id ? "Approving..." : "Approve (25% rate)"}
                                </DropdownMenuItem>
                              )}
                              {paypalEmail && (
                                <DropdownMenuItem onClick={() => copyToClipboard(paypalEmail, "PayPal email")}>
                                  <Copy className="h-4 w-4 mr-2" />
                                  Copy PayPal email
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => copyToClipboard(`https://opennous.cloud/signup?ref=${a.referral_code}`, "Referral link")}
                              >
                                <Copy className="h-4 w-4 mr-2" />
                                Copy referral link
                              </DropdownMenuItem>
                              {a.status === "active" && (
                                <DropdownMenuItem
                                  onClick={() => {
                                    const unpaidAmt = (a.total_earnings_cents - a.paid_out_cents) / 100;
                                    setPayAmount(unpaidAmt > 0 ? unpaidAmt.toFixed(2) : "");
                                    setPayNotes("");
                                    setPayDialog(a);
                                  }}
                                >
                                  <DollarSign className="h-4 w-4 mr-2 text-emerald-500" />
                                  Record payout
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => handleDelete(a)}
                                className="text-red-600 focus:text-red-600"
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete affiliate
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
        )}

        {/* Payout History Table */}
        {activeTab === "payouts" && (
          <Card className="border-gray-200">
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50/50">
                  <TableHead className="font-medium">Affiliate</TableHead>
                  <TableHead className="font-medium">PayPal Email</TableHead>
                  <TableHead className="font-medium text-right">Amount</TableHead>
                  <TableHead className="font-medium">Batch ID</TableHead>
                  <TableHead className="font-medium">Notes</TableHead>
                  <TableHead className="font-medium">Paid On</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : payouts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                      No payouts recorded yet
                    </TableCell>
                  </TableRow>
                ) : (
                  payouts.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <p className="text-sm font-medium text-gray-900">{getAffiliateName(p.affiliate_id)}</p>
                      </TableCell>
                      <TableCell>
                        <button
                          onClick={() => copyToClipboard(getAffiliatePaypalEmail(p.affiliate_id), "PayPal email")}
                          className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded hover:bg-blue-100 transition-colors"
                        >
                          {getAffiliatePaypalEmail(p.affiliate_id)}
                          <Copy className="h-3 w-3 text-blue-400" />
                        </button>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="text-sm font-semibold text-emerald-600">
                          ${(p.commission_amount_cents / 100).toFixed(2)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-muted-foreground">
                          {p.payout_batch_id || "—"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground truncate max-w-[200px] block">
                          {p.notes || "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.paid_at
                          ? formatDistanceToNow(new Date(p.paid_at), { addSuffix: true })
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>

      {/* Pay Dialog */}
      <Dialog open={!!payDialog} onOpenChange={(o) => !o && setPayDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record PayPal Payout</DialogTitle>
            <DialogDescription>
              Record a payout you've sent via PayPal to this affiliate.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Affiliate info */}
            <div className="bg-gray-50 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-500">Affiliate</span>
                <span className="text-sm font-medium text-gray-900">
                  {payDialog?.user?.name || payDialog?.user?.email || "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-500">Send PayPal to</span>
                <button
                  onClick={() => {
                    const email = payDialog?.payout_email || payDialog?.user?.email || "";
                    if (email) copyToClipboard(email, "PayPal email");
                  }}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 bg-blue-50 px-2.5 py-1 rounded-md hover:bg-blue-100 transition-colors"
                >
                  {payDialog?.payout_email || payDialog?.user?.email || "Not set"}
                  <Copy className="h-3.5 w-3.5 text-blue-400" />
                </button>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-500">Unpaid balance</span>
                <span className="text-sm font-semibold text-amber-600">
                  ${payDialog ? ((payDialog.total_earnings_cents - payDialog.paid_out_cents) / 100).toFixed(2) : "0.00"}
                </span>
              </div>
            </div>

            {/* Amount */}
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1.5 block">Amount you sent ($)</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
                className="h-10"
                autoFocus
              />
            </div>

            {/* Notes */}
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1.5 block">Notes (optional)</label>
              <Input
                type="text"
                placeholder="e.g. PayPal transaction ID, date sent..."
                value={payNotes}
                onChange={(e) => setPayNotes(e.target.value)}
                className="h-10"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleMarkPaid}
              disabled={paying || !payAmount || parseFloat(payAmount) <= 0}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {paying ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                `Record $${payAmount || "0"} payout`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
