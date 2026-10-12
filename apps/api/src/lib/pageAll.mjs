// Read every row a query matches, not the first thousand.
//
// ⚠️ THE BUG THIS EXISTS FOR: **PostgREST caps every response at 1000 rows, and it does it
// SILENTLY.** `.limit(100000)` and `.range(0, 99999)` both come back with exactly 1000 rows,
// no error, no warning, no truncation flag. Verified against production: a workspace holding
// about five thousand `pipeline_stage` claims returned 1,000 of them.
//
// That is the worst possible failure shape for analytics. Nothing throws, nothing logs, and
// the output is not empty — it is PLAUSIBLE. A funnel built from a fifth of the history still
// has sensible-looking stages and believable counts, so there is no moment where anybody
// notices. The revenue report counted about a fifth of the open opportunities that were really
// there, and it looked completely fine.
//
// So: any query that could match more than a thousand rows goes through this. Claims,
// observations and relationships all cross that line on a real workspace, and `.limit(50000)`
// is not a fix — it is the bug wearing a bigger number.

/**
 * Every row `build()` matches, fetched in concurrent pages.
 *
 * `build` MUST return a FRESH query builder on each call. A PostgREST builder cannot be
 * re-ranged once it has been awaited, so passing the same instance twice returns the same
 * page twice — which looks like duplicate data rather than an error.
 *
 * Order your query. Paging an unordered query is undefined: Postgres may return rows in a
 * different sequence per page, so a row can be seen twice and another never.
 *
 * @param {() => any} build           returns a new Supabase query builder
 * @param {object}    [opts]
 * @param {number}    [opts.cap]         hard ceiling on rows read (default 200k)
 * @param {number}    [opts.size]        page size; 1000 is PostgREST's own maximum
 * @param {number}    [opts.concurrency] pages in flight per batch
 * @returns {Promise<any[]>}
 */
export async function pageAll(build, { cap = 200000, size = 1000, concurrency = 8 } = {}) {
  // The first page also answers "is there a second one?" — and for most workspaces, which
  // never reach a thousand rows of anything, it is the only request made.
  const first = await build().range(0, size - 1);
  if (first.error) throw first.error;
  const head = first.data ?? [];
  if (head.length < size) return head;

  const out = [...head];
  // Fetch ahead in batches rather than one page at a time. Sequential paging over tens of
  // thousands of observations took many seconds against production — dozens of round-trips that
  // were almost entirely latency — which is far too slow for something an agent calls
  // mid-conversation. Batched, the same read takes a fraction of the time.
  //
  // Over-fetching one batch past the end is cheaper than asking for an exact count first,
  // because counting these tables is itself a scan.
  for (let from = size; from < cap; from += size * concurrency) {
    const batch = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => {
        const start = from + i * size;
        return start < cap ? build().range(start, start + size - 1) : Promise.resolve({ data: [] });
      }),
    );
    let got = 0;
    for (const r of batch) {
      if (r.error) throw r.error;
      const rows = r.data ?? [];
      out.push(...rows);
      got += rows.length;
    }
    // A short batch means the end of the data.
    if (got < size * concurrency) break;
  }
  return out;
}
