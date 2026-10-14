// A RevBox dataset as a table (GET-874): the rows a box's jobs added (e.g. one per deal won or lost),
// newest first. Calm by design: hairline rows, a sticky header, values formatted by column type
// (numbers right-aligned and tabular, dates as "12 Oct 2026", Yes/No for booleans, a quiet pill for a
// choice), a search box (server-side, every word must appear), "Load more" paging, and Export CSV.
// Each row ends in a link to the run that added it, which opens that run in the run list.
import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, Download, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { revboxesRequest, downloadDatasetCsv, type DatasetColumn, type DatasetRow, type DatasetRowsPage, type RevBoxDataset } from '@/lib/revboxes';
import { cn } from '@/lib/utils';

const PAGE = 50;
const DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const NUM = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const WON_LOST: Record<string, string> = { won: 'text-emerald-700 bg-emerald-500/10 dark:text-emerald-400', lost: 'text-risk bg-risk/10' };

function Cell({ col, value }: { col: DatasetColumn; value: DatasetRow['data'][string] | undefined }) {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground/50">—</span>;
  switch (col.type) {
    case 'number': return <>{typeof value === 'number' ? NUM.format(value) : String(value)}</>;
    case 'date': { const t = Date.parse(`${String(value)}T00:00:00Z`); return <>{Number.isNaN(t) ? String(value) : DATE.format(t)}</>; }
    case 'boolean': return <span className={value === true ? 'text-foreground' : 'text-muted-foreground'}>{value === true ? 'Yes' : value === false ? 'No' : String(value)}</span>;
    case 'enum': return <span className={cn('inline-flex rounded px-1.5 py-px text-[11.5px] font-medium', WON_LOST[String(value).toLowerCase()] ?? 'bg-muted text-foreground/80')}>{String(value)}</span>;
    default: return <span title={String(value).length > 60 ? String(value) : undefined}>{String(value)}</span>;
  }
}

export function DatasetTable({ ws, token, boxId, dataset, onBack, onOpenRun }: {
  ws: string; token: string; boxId: string; dataset: RevBoxDataset; onBack: () => void; onOpenRun: (runId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  // The search runs on the server, a moment after typing stops.
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 250); return () => clearTimeout(t); }, [search]);
  const query = useInfiniteQuery({
    queryKey: ['revbox-dataset-rows', ws, boxId, dataset.key, q],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE), ...(pageParam ? { cursor: pageParam } : {}), ...(q ? { q } : {}) });
      return revboxesRequest<DatasetRowsPage>(ws, token, `/${boxId}/datasets/${encodeURIComponent(dataset.key)}/rows?${params}`);
    },
    getNextPageParam: (last: DatasetRowsPage) => last.next_cursor ?? undefined,
  });
  const columns = query.data?.pages[0]?.dataset.columns ?? dataset.columns;
  const rows = query.data?.pages.flatMap(p => p.rows) ?? [];
  const exportCsv = async () => {
    setExporting(true); setError('');
    try { await downloadDatasetCsv(ws, token, boxId, dataset.key, q); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not export.'); }
    finally { setExporting(false); }
  };
  return <div className="flex min-h-0 flex-col">
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <button type="button" onClick={onBack} aria-label="Back to datasets" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"><ArrowLeft className="h-4 w-4" /></button>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[14px] font-medium text-foreground">{dataset.name}</h3>
        {dataset.description && <p className="truncate text-[12px] text-muted-foreground">{dataset.description}</p>}
      </div>
      <label className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search rows" aria-label={`Search ${dataset.name}`} maxLength={200}
          className="h-7 w-48 rounded-md border border-border/70 bg-background pl-7 pr-2 text-[12px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-foreground/30" />
      </label>
      <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[12px]" disabled={exporting} onClick={() => void exportCsv()}><Download className="h-3.5 w-3.5" />{exporting ? 'Exporting…' : 'Export CSV'}</Button>
    </div>
    {error && <p role="alert" className="mb-2 text-[12px] text-risk">{error}</p>}
    {query.error
      ? <p role="alert" className="text-[12px] text-risk">{query.error.message}</p>
      : <div className="max-h-[65vh] overflow-auto rounded-lg border border-hairline">
        <table className="w-full border-collapse text-left text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <tr className="border-b border-hairline">
              {columns.map(c => <th key={c.key} scope="col" title={c.description} className={cn('whitespace-nowrap px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground', c.type === 'number' && 'text-right')}>{c.label}</th>)}
              <th scope="col" className="whitespace-nowrap px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Added</th>
              <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">Source run</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => <tr key={r.id} className="border-b border-hairline/70 transition-colors last:border-0 hover:bg-hover/50">
              {columns.map(c => <td key={c.key} className={cn('max-w-[280px] truncate px-3 py-2 text-foreground/90', c.type === 'number' && 'text-right tabular-nums', c.type === 'date' && 'whitespace-nowrap tabular-nums')}><Cell col={c} value={r.data[c.key]} /></td>)}
              <td className="whitespace-nowrap px-3 py-2 text-right text-[11.5px] tabular-nums text-muted-foreground">{DATE.format(Date.parse(r.created_at))}</td>
              <td className="px-2 py-2 text-right">{r.source_run_id && <button type="button" onClick={() => onOpenRun(r.source_run_id!)} title="Open the run that added this row" aria-label="Open the run that added this row"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"><ArrowUpRight className="h-3.5 w-3.5" /></button>}</td>
            </tr>)}
          </tbody>
        </table>
        {query.isLoading && <p className="px-3 py-4 text-[12px] text-muted-foreground">Loading rows…</p>}
        {!query.isLoading && !rows.length && <p className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">{q ? 'No rows match that search.' : 'No rows yet. The jobs that fill this table add a row each time they run.'}</p>}
      </div>}
    <div className="mt-2 flex items-center justify-between text-[11.5px] text-muted-foreground">
      <span className="tabular-nums">{rows.length ? `${rows.length}${query.hasNextPage ? '+' : ''} row${rows.length === 1 ? '' : 's'}` : ''}</span>
      {query.hasNextPage && <button type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} className="font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-60">{query.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>}
    </div>
  </div>;
}
