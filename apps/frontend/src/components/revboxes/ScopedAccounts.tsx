import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X, Search } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { revboxesRequest, SCOPE_LABELS, type Account, type Scope } from '@/lib/revboxes';
import { DataTable, type Column } from '@/components/ui/data-table';
import { AccountTile } from '@/components/pipeline/DealBits';
import { when } from '@/lib/format';

export function ScopedAccounts({ revboxId }: { revboxId: string }) {
  const { session, userData } = useAuth();
  const ws = userData?.workspace?.id ?? '';
  const token = session?.access_token ?? '';
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['revbox-accounts', ws, revboxId], enabled: !!token && !!ws, queryFn: () => revboxesRequest<{ accounts: Account[]; box: { id: string; name: string; scope: Scope } }>(ws, token, `/${revboxId}/accounts`) });
  const columns: Column<Account>[] = [
    { key: 'company', header: 'Company', cell: a => <span className="flex items-center gap-2.5"><AccountTile name={a.name} domain={a.domain} /><span>{a.name}</span></span> },
    { key: 'contacts', header: 'Contacts', cell: a => a.people_count },
    { key: 'deals', header: 'Deals', cell: a => a.deal_count },
    { key: 'signal', header: 'Latest Signal', cell: a => <span className="block max-w-[240px] truncate" title={a.latest_signal?.title}>{a.latest_signal?.title ?? '—'}</span> },
    { key: 'activity', header: 'Last Activity', cell: a => a.last_activity_at ? when(a.last_activity_at) : '—' },
    { key: 'icp', header: 'ICP', cell: a => a.icp_score ?? '—' },
  ];
  return <div className="flex h-full flex-col overflow-hidden">
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
      <Link to={`/revboxes/${revboxId}`} className="rounded-md bg-muted px-2.5 py-1 text-[12px]">{query.data?.box.name ?? 'RevBox'}</Link>
      <span className="text-[12px] text-muted-foreground">{query.data ? SCOPE_LABELS[query.data.box.scope.mode] : 'Loading scope…'}</span>
      <Link to="/accounts" aria-label="Clear RevBox filter" className="rounded p-1 text-muted-foreground hover:bg-muted"><X className="h-3.5 w-3.5" /></Link>
      <label className="ml-auto flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"><Search className="h-3.5 w-3.5 text-muted-foreground" /><input aria-label="Search scoped accounts" className="w-40 bg-transparent text-[12px] outline-none" placeholder="Search accounts" value={search} onChange={e => setSearch(e.target.value)} /></label>
    </div>
    {query.error ? <p role="alert" className="p-6 text-[13px] text-risk">{query.error.message}</p> : <div className="flex-1 overflow-auto"><DataTable aria-label="RevBox accounts" columns={columns} rows={(query.data?.accounts ?? []).filter(a => `${a.name} ${a.domain ?? ''}`.toLowerCase().includes(search.toLowerCase()))} rowKey={a => a.id} loading={query.isLoading} onRowClick={a => navigate(`/accounts/${a.id}`)} empty={<p className="p-10 text-center text-[13px] text-muted-foreground">No accounts match this RevBox's filter.</p>} /></div>}
  </div>;
}
