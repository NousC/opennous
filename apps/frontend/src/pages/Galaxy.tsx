import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { ArrowLeft, Crown, AlertTriangle, ArrowUpRight, X } from "lucide-react";
import { GraphFilters, buildGroups, type Show, type Group, type GroupBy, type Display, type Forces, type Counts } from "@/components/GraphFilters";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// Full-page context graph — the war-room. Runs a self-contained canvas engine
// (force layout + render + interaction) against the live /api/graph snapshot.
// Deliberately NOT react-force-graph: we own the canvas so the encodings
// (committee, shared-claim bridges, patterns, dev rail, smooth zoom) match the
// design exactly. Mounted OUTSIDE the app sidebar as its own immersive surface.

/* eslint-disable @typescript-eslint/no-explicit-any */

// force-directed layout (Fruchterman-Reingold) — assigns x/y in place.
function layout(nodes: any[], edges: any[]) {
  const n = nodes.length; if (!n) return;
  const idx = new Map(nodes.map((nd, i) => [nd.i, i]));
  const P = nodes.map(() => [Math.random() * 2 - 1, Math.random() * 2 - 1]);
  const EI = edges.map(e => [idx.get(e.s), idx.get(e.t), e.k]).filter(a => a[0] != null && a[1] != null) as number[][];
  const grav = nodes.map(nd => nd.t === 1 ? (0.006 + (((nd.s || 30) / 100) + ((nd.a != null && nd.a <= 30) ? 0.4 : 0)) * 0.018) : nd.t === 3 ? 0.010 : 0.004);
  const k = Math.sqrt(1 / n) * 2.0; let t = 0.14;
  for (let it = 0; it < 170; it++) {
    const disp = nodes.map(() => [0, 0]);
    for (let i = 0; i < n; i++) {
      const xi = P[i][0], yi = P[i][1];
      for (let j = i + 1; j < n; j++) {
        let dx = xi - P[j][0], dy = yi - P[j][1]; let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) { dx = Math.random() * 1e-3; dy = Math.random() * 1e-3; d2 = dx * dx + dy * dy + 1e-6; }
        const dist = Math.sqrt(d2), f = k * k / dist, ux = dx / dist * f, uy = dy / dist * f;
        disp[i][0] += ux; disp[i][1] += uy; disp[j][0] -= ux; disp[j][1] -= uy;
      }
    }
    for (const [a, b, kk] of EI) {
      const w = kk === 0 ? 1.5 : 0.8;
      let dx = P[a][0] - P[b][0], dy = P[a][1] - P[b][1]; const dist = Math.sqrt(dx * dx + dy * dy) + 1e-4;
      const f = dist * dist / k * w, ux = dx / dist * f, uy = dy / dist * f;
      disp[a][0] -= ux; disp[a][1] -= uy; disp[b][0] += ux; disp[b][1] += uy;
    }
    for (let i = 0; i < n; i++) { disp[i][0] -= P[i][0] * grav[i] * n * 0.02; disp[i][1] -= P[i][1] * grav[i] * n * 0.02; }
    for (let i = 0; i < n; i++) {
      const dl = Math.sqrt(disp[i][0] ** 2 + disp[i][1] ** 2) + 1e-9, step = Math.min(dl, t);
      P[i][0] += disp[i][0] / dl * step; P[i][1] += disp[i][1] / dl * step;
    }
    t *= 0.978;
  }
  let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
  for (const p of P) { mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]); mny = Math.min(mny, p[1]); mxy = Math.max(mxy, p[1]); }
  const sc = Math.min(1350 / ((mxx - mnx) || 1), 1350 / ((mxy - mny) || 1));
  nodes.forEach((nd, i) => { nd.x = (P[i][0] - (mnx + mxx) / 2) * sc; nd.y = (P[i][1] - (mny + mxy) / 2) * sc; });
}

// the canvas engine — returns a disposer. Faithful port of the standalone.
// `view` decides what this engine IS.
//
//   graph  the context graph. People and companies, coloured by how alive the account
//          is. What is happening.
//   icp    the ICP MODEL, drawn. Same data, patterns layout: the claim clusters become
//          hubs and the companies orbit the claims they share, so the CLUSTERS ARE THE
//          PATTERNS. Companies are coloured by ICP SCORE rather than by activity, so
//          you are looking at where the fit is, not where the noise is.
//
//          This is the model. Not a table of weights — a table of weights is a
//          spreadsheet. This is the shape: where the good accounts cluster, which
//          shared claims made them cluster, and which high scorers sit alone (that is
//          the model guessing).
function runEngine(root: HTMLElement, D: any, view: "graph" | "icp" = "graph", embedded = false, onOpen?: (n: any) => void): any {
  const cv = root.querySelector('#gx-c') as HTMLCanvasElement;
  const tip = root.querySelector('#gx-tip') as HTMLElement | null;
  // Claim text is user data — escape before it touches innerHTML.
  const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c: string) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]));
  const ctx = cv.getContext('2d', { alpha: false })!;
  let W = 0, H = 0; const DPR = Math.min(1.6, window.devicePixelRatio || 1);
  const RAIL = 0;   // the filter panel is a sibling element now, not an overlay
  function size() { const r = root.getBoundingClientRect(); W = Math.max(320, Math.round(r.width)); H = Math.max(240, Math.round(r.height)); cv.width = W * DPR; cv.height = H * DPR; cv.style.width = W + 'px'; cv.style.height = H + 'px'; }
  size();
  // The war-room is dark: glow only reads on a dark field, and the graph is meant to
  // feel alive. The ICP model is LIGHT, because it lives inside the Vault next to
  // documents, and a black rectangle in the middle of a white page is a hole, not a
  // picture. Obsidian's graph is light for the same reason.
  const LIGHT = embedded;
  const GREEN   = LIGHT ? '#2fa36b' : '#3ddc84';
  const GREEN_D = LIGHT ? '#8ec9a9' : '#39946a';
  const GOLD    = LIGHT ? '#e0a03a' : '#f5c451';
  const SLATE   = LIGHT ? '#c2c7d0' : '#7f8798';
  const INK     = LIGHT ? '48,52,60'   : '226,231,240';
  const ACC     = LIGHT ? '#7c5cf0' : '#a892f7';
  const CLA     = LIGHT ? '#7c5cf0' : '#a78bfa';
  const BG      = LIGHT ? '#ffffff' : '#17191e';
  // Edge ink. On white, an edge at dark-mode opacity is a scribble; Obsidian's are
  // barely there and that is what makes a dense graph readable.
  const E_DIM   = LIGHT ? 'rgba(20,24,32,0.035)' : 'rgba(200,208,222,0.045)';
  const E_CLAIM = LIGHT ? 'rgba(124,92,240,0.28)' : 'rgba(168,146,247,0.32)';
  const E_LINK  = LIGHT ? 'rgba(20,24,32,0.10)'  : 'rgba(200,208,222,0.11)';
  const E_DM    = LIGHT ? 'rgba(224,160,58,0.55)' : 'rgba(245,196,81,0.4)';
  // Person↔person KNOWS/connection links — a distinct rose so a "who knows whom"
  // edge reads differently from employment (grey) and shared-claim (violet).
  const E_KNOWS = LIGHT ? 'rgba(224,90,140,0.48)' : 'rgba(240,130,170,0.42)';
  // Revenue types — the hub's colour is its ACTION (pain=wedge, objection=friction,
  // tool=stack, competitor=win/loss, play=timing, person=who-signs, connection=warm
  // path, channel=attribution, segment=lookalike). Legacy keys kept as fallbacks.
  const CATCOL: Record<string, string> = LIGHT
    ? { pain: '#d4574c', objection: '#c2410c', tool: '#7c5cf0', competitor: '#0891b2', play: '#2aa8a0',
        person: '#2fa36b', connection: '#4a7fd4', channel: '#dd9a3e', segment: '#9aa0ad',
        stack: '#7c5cf0', intent: '#2aa8a0', theme: '#9aa0ad' }
    : { pain: '#f0665c', objection: '#e0723c', tool: '#a78bfa', competitor: '#22c3d6', play: '#4fd1c5',
        person: '#4ade80', connection: '#6f9ff0', channel: '#f2b263', segment: '#8a8fa0',
        stack: '#a78bfa', intent: '#4fd1c5', theme: '#8a8fa0' };
  const nodes = D.nodes, byId = new Map(nodes.map((n: any) => [n.i, n]));
  // Node radius is set from DEGREE, below, once the adjacency is built — the way Obsidian
  // does it. See the note there.
  const fillP = (n: any) => n.a == null ? SLATE : (n.s != null && n.s >= 85 && n.a <= 30) ? GOLD : n.a <= 30 ? GREEN : n.a <= 75 ? GREEN_D : SLATE;
  const fillC = (n: any) => n.a == null ? SLATE : n.a <= 30 ? GREEN : n.a <= 75 ? GREEN_D : SLATE;
  // In the ICP view, a company's colour IS its score. Everything else about the
  // encoding stays, so the two views are legibly the same graph.
  const fillS = (n: any) => n.s == null ? SLATE : n.s >= 85 ? GOLD : n.s >= 70 ? GREEN : n.s >= 50 ? GREEN_D : SLATE;
  const COMPANY = (n: any) => (view === 'icp' ? fillS(n) : fillC(n));
  const edges = D.edges.map((e: any) => ({ a: byId.get(e.s), b: byId.get(e.t), k: e.k })).filter((e: any) => e.a && e.b);
  const adj = new Map(nodes.map((n: any) => [n.i, [] as string[]]));
  const memberOf = new Map<string, string[]>(); for (const n of nodes) if (n.t === 1) memberOf.set(n.i, []);
  for (const e of edges) { adj.get(e.a.i)!.push(e.b.i); adj.get(e.b.i)!.push(e.a.i); if (e.k === 0 && memberOf.has(e.b.i)) memberOf.get(e.b.i)!.push(e.a.i); }

  // ── Size by CONNECTEDNESS, not by type ───────────────────────────────────────
  //
  // This is the one encoding that makes Obsidian's graph readable, and we did not have
  // it. Every node there is the same shape and the same colour family; the only thing
  // that varies is how big it is, and it is big because a lot of things point at it. So
  // the hubs surface on their own — you can see, without reading a single label, which
  // notes the vault is actually organised around.
  //
  // We were sizing by type: every company the same, every person the same. So an account
  // with fifteen people at it and eight shared claims looked exactly like an orphan with
  // nothing attached, and the graph had no centre. It was confetti because we drew it as
  // confetti.
  //
  // sqrt(degree) because linear makes the biggest hub swallow the canvas, and the whole
  // point is that you can still see everything else.
  for (const n of nodes) {
    const deg = adj.get(n.i)!.length;
    const base = n.t === 3 ? 5 : n.t === 1 ? 4.6 : 3.4;
    const k    = n.t === 3 ? 2.4 : n.t === 1 ? 2.2 : 1.5;
    n.r = base + Math.sqrt(deg) * k;
  }

  // View + camera state. Declared BEFORE the simulation, which reads `mode` on its
  // very first tick during the warm start.
  let scale = 1, tx = 0, ty = 0, ts = 1, ttx = 0, tty = 0, anim = false, fast = false, hov: any = null, sel: any = null, hi: Set<string> | null = null, pending = false, mode = view === 'icp' ? 'patterns' : 'accounts', dead = false;
  // Category lens: null = the ICP overview (accounts, tier-coloured); a concept TYPE
  // ("objection", "pain", …) re-renders the graph toward that category — that type's
  // concept hubs plus the accounts on them, nothing else. `focusMembers` is the set of
  // account ids sitting on a hub of the active type (recomputed on each focus change).
  let focusCat: string | null = null, focusMembers: Set<string> | null = null;
  function computeFocus() {
    if (!focusCat) { focusMembers = null; return; }
    const mem = new Set<string>();
    for (const e of edges) if (e.k === 2 && e.b?.t === 3 && e.b.cat === focusCat) mem.add(e.a.i);
    focusMembers = mem;
  }
  const F = (v: any) => Number.isFinite(v);

  // ── What the panel drives ────────────────────────────────────────────────────
  //
  // The old rail was innerHTML strings that could only HIGHLIGHT a precomputed cluster.
  // It could not hide anything, could not colour by a condition, and could not answer a
  // question you had not thought of in advance. That is why it read as decoration.
  //
  // This is a filter: it decides what is ON the canvas (show), what is LIT (search), and
  // what COLOUR means (groups). A group is a query plus a colour, exactly like Obsidian's
  // — except ours run over typed entities, so they can say `icp>=85` and `quiet>30`
  // rather than matching a filename.
  // Orphans off by default: a company nobody works at is a dot with no story, and a few
  // hundred of them is the confetti. They can still come back, but you should not have to
  // turn them off to see the graph you actually have.
  let show = { people: true, companies: true, claims: true, orphans: false };
  let search = '';
  // FILTER and GROUP are different verbs, and conflating them is what made the panel
  // feel like it lied.
  //
  //   filter  REMOVES nodes from the canvas. "no budget-holder" is a filter: it is a
  //           condition you want to look at alone. It is not a group — a group of
  //           "accounts with no budget-holder" tells you nothing about the rest.
  //   group   COLOURS nodes and pulls them together. A grouping is a PARTITION: every
  //           account lands in exactly one bucket, and the buckets are the answer.
  //           ICP tier is a grouping. So is "which signal scored this account".
  //
  // The old panel called both of them groups, so switching one on dimmed most of the
  // graph and there was nothing to compare the highlighted part TO.
  let filter = '';
  let groups: { q: string; color: string }[] = [];
  let disp = { node: 1, label: 1, link: 1 };
  let forces = { repel: 1, dist: 1, center: 1 };

  // The query language. Deliberately tiny, and every operator answers a question a GTM
  // person actually asks:
  //
  //   icp>=85 icp<50      fit
  //   quiet>30            days since anything happened (a cold account)
  //   people>=3           multi-threaded
  //   single              one contact and no more (the 277-company problem)
  //   no-budget           nobody with budget authority
  //   dm                  is a decision maker
  //   company / person    the node type
  //   anything else       matched against the name and the job title
  function matches(n: any, raw: string): boolean {
    const q = (raw || '').trim().toLowerCase();
    if (!q) return false;
    for (const term of q.split(/\s+/)) {
      let ok = false;
      // A band, the way a human says it: icp:70-85
      const band = term.match(/^(icp|quiet|people):(\d+)-(\d+)$/);
      if (band) {
        const [, key, loS, hiS] = band;
        const v = key === 'icp' ? n.s : key === 'quiet' ? n.a : n.pc;
        if (v == null || !Number.isFinite(v)) return false;
        if (!(v >= Number(loS) && v <= Number(hiS))) return false;
        continue;
      }
      const m = term.match(/^(icp|quiet|people)(>=|<=|>|<|=)(\d+)$/);
      if (m) {
        const [, key, op, numS] = m;
        const num = Number(numS);
        const v = key === 'icp' ? n.s : key === 'quiet' ? n.a : n.pc;
        if (v == null || !Number.isFinite(v)) return false;
        ok = op === '>=' ? v >= num : op === '<=' ? v <= num : op === '>' ? v > num : op === '<' ? v < num : v === num;
      } else if (term === 'single')    ok = !!n.single;
      else if (term === 'no-budget')   ok = !!n.budget;
      else if (term === 'dm')          ok = !!n.dm;
      else if (term === 'company')     ok = n.t === 1;
      else if (term === 'person')      ok = n.t === 0;
      else if (term === 'claim')       ok = n.t === 3;
      else if (term === 'unscored')    ok = n.s == null;
      else if (term === 'dormant')     ok = n.a == null;   // nothing has EVER happened
      // A shared claim the account carries — a tool, a pain, an initiative, a segment.
      // Slugged because query terms split on whitespace and claims are phrases.
      else if (term.startsWith('pat:')) {
        const want = term.slice(4);
        ok = (n.pat || []).some((p: any) => String(p.label || '').toLowerCase().replace(/\s+/g, '_') === want);
      }
      // The tier is the model's own verdict, not a band I invented in the panel. Reading
      // it off the node rather than re-deriving it from the score means the graph, the
      // table and the record can never disagree about what Tier 1 is.
      else if (term.startsWith('tier:')) {
        const want = term.slice(5);
        ok = want === 'none' ? n.tier == null : n.tier === (want === 'not-icp' ? 'not_icp' : want.replace('t', 'tier_'));
      }
      // The signals that actually fired on this account. This is the grouping that makes
      // the model legible: Tier 1 is not one thing, it is however many different reasons
      // an account got there, and this is how you see them separate.
      else if (term.startsWith('sig:')) {
        const want = term.slice(4);
        ok = want === 'none' ? !(n.sig && n.sig.length) : !!(n.sig || []).some((k: string) => k.toLowerCase() === want);
      }
      else ok = `${n.l ?? ''} ${n.jt ?? ''}`.toLowerCase().includes(term);
      if (!ok) return false;   // terms AND together
    }
    return true;
  }

  // A node's colour comes from the first group whose query it matches — groups are
  // ordered, so the top one wins, same as Obsidian.
  //
  // Resolved ONCE per change and cached. `matches` parses its query with a regex, and
  // calling it per node, per group, every frame, plus again on every hit test, is exactly
  // how a 60fps graph becomes a 20fps one the moment you turn a grouping on.
  const gcMap = new Map<string, string>();
  // Which hubs each node belongs to — PLURAL, and that is the point.
  //
  // A tier is exclusive: you are Tier 1 or you are not. A PATTERN is not. An account runs
  // Clay and has a manual-research pain and is an agency, and it belongs to all three at
  // once. Forcing it into one bucket would throw away the only thing that makes patterns
  // worth graphing — the OVERLAP. An account pulled between three hubs sits in the middle
  // of them, and where it sits IS the finding: this is what these accounts have in
  // common, and here is where they still differ.
  const hubOf = new Map<string, number[]>();
  let hubs: any[] = [];
  function regroup() {
    gcMap.clear(); hubOf.clear();
    const live = groups.filter(g => g.q);
    // Seed the hubs on a ring so they start apart. Two hubs born at the origin take a
    // long time to decide which way to go, and you watch them argue about it.
    hubs = live.map((g, i) => ({
      color: g.color, label: g.label ?? g.q, q: g.q,
      x: Math.cos((i / Math.max(1, live.length)) * 6.283) * 420,
      y: Math.sin((i / Math.max(1, live.length)) * 6.283) * 420,
      n: 0, mx: 0, my: 0, r: 10, fx: null as number | null, fy: null as number | null, hub: true,
    }));
    // ONLY PEOPLE JOIN A HUB.
    //
    // We score people. A company does not have an ICP score of its own — it has whoever
    // works there. So the hub is a tier, the tier holds PEOPLE, and the company hangs off
    // the people through employment.
    //
    // That is what makes the picture worth looking at. A company with two stakeholders in
    // different tiers is physically stretched between two hubs — you can SEE that the
    // account is split, that your good thread and your weak thread are at the same
    // company. Colouring the company itself would have averaged that away into one dot of
    // one colour, and the most interesting thing on the canvas would have disappeared.
    //
    // Companies stay neutral on purpose. The tiers are the story; the company is where
    // the story lands.
    for (const n of nodes) {
      if (n.t !== 0) continue;
      const mine: number[] = [];
      for (let gi = 0; gi < live.length; gi++) if (matches(n, live[gi].q)) mine.push(gi);
      if (!mine.length) continue;
      hubOf.set(n.i, mine);
      // The fill is the FIRST hub it joined. A node cannot be two colours, and the spokes
      // already tell you about the others.
      gcMap.set(n.i, live[mine[0]].color);
    }
  }
  function groupColor(n: any): string | null { return gcMap.get(n.i) ?? null; }

  // ── The live simulation ──────────────────────────────────────────────────────
  //
  // This is what makes the graph feel alive rather than printed. The old engine ran a
  // one-shot Fruchterman-Reingold, froze the coordinates, and tweened between two
  // precomputed arrangements. Nothing you did to it changed anything: it was a picture
  // of a graph, not a graph.
  //
  // Now it runs continuously, the way Obsidian's does. Drag a node and its
  // neighbourhood answers. Switch mode and the whole thing flows into the new shape
  // instead of cutting to it. Then it settles and stops, because a graph that never
  // stops moving is a lava lamp.
  //
  // Forces, in the order they are applied each tick:
  //
  //   charge     every node repels every other. Barnes-Hut over a quadtree, so this is
  //              O(n log n) instead of O(n²) — the difference between smooth at 500
  //              accounts and a slideshow.
  //   link       a spring per edge. Employment pulls tight (a person belongs to their
  //              company). A shared claim pulls loosely (an account merely resembles
  //              the others in its cluster). High-degree nodes move less, so the hubs
  //              hold still and the leaves swing.
  //   gravity    a pull to the origin, stronger for the accounts that matter — high
  //              score, recent activity — so the graph has a centre of mass that means
  //              something instead of drifting off screen.
  //
  // alpha is the temperature. It decays to nothing so the layout comes to rest, and it
  // reheats when you touch something.
  const THETA2 = 0.81;          // Barnes-Hut accuracy (0.9²). Lower = more exact, slower.
  const V_DECAY = 0.62;         // velocity damping per tick. Too high and it wobbles.
  const A_DECAY = 0.0165;       // how fast the layout cools. Slower than d3 on purpose:
                                // the settle is the part that looks good.
  const A_MIN = 0.0012;
  let alpha = 0.55, alphaTarget = 0;

  for (const n of nodes) {
    n.vx = 0; n.vy = 0;
    n.fx = null; n.fy = null;
    n.deg = adj.get(n.i)!.length || 1;
    // Bigger things shove harder. A claim cluster shared by twenty accounts should
    // clear itself some room.
    n.q0 = -(26 + n.r * 7);
    // Gravity: the accounts that matter sit near the middle. A dormant company drifts.
    n.g = n.t === 1 ? (0.008 + (((n.s || 30) / 100) + (n.a != null && n.a <= 30 ? 0.35 : 0)) * 0.012)
        : n.t === 3 ? 0.011
        : 0.005;
  }

  // Only what is on screen takes part. Simulating people while you are looking at the
  // patterns view wastes the frame budget and, worse, lets invisible nodes shove the
  // visible ones around.
  // A filter on a bipartite graph has to keep the NEIGHBOURHOOD, or it destroys the very
  // thing you came to look at: filter to `dm` and you would be left with decision-makers
  // floating in a void, detached from the companies they decide for. So a node survives
  // if it matches, or if anything it is attached to matches.
  let keep: Set<string> | null = null;
  function refilter() {
    const f = filter.trim();
    if (!f) { keep = null; return; }
    const hit = new Set<string>();
    for (const n of nodes) if (n.t !== 3 && matches(n, f)) hit.add(n.i);
    const k = new Set(hit);
    for (const id of hit) for (const nb of adj.get(id)!) k.add(nb);
    keep = k;
  }

  const vis = (n: any) => {
    if (keep && !keep.has(n.i)) return false;
    // Category lens: only this type's concept hubs + the accounts on them.
    if (focusCat) {
      if (n.t === 3) return n.cat === focusCat && show.claims;
      if (n.t === 0) return show.people && !!focusMembers?.has(n.i);
      return false;
    }
    if (n.t === 0 && !show.people) return false;
    if (n.t === 1 && !show.companies) return false;
    if (n.t === 3 && !show.claims) return false;
    // An orphan is a company nobody works at. 97 of them, and they are the reason the
    // canvas reads as confetti — so they get their own switch.
    if (n.t === 1 && !show.orphans && !(n.pc > 0)) return false;
    return mode === 'patterns' ? n.t !== 0 : n.t !== 3;
  };
  const eOn = (e: any) => ((focusCat || mode === 'patterns') ? e.k === 2 : e.k !== 2);

  // Barnes-Hut quadtree. Built fresh each tick; at these node counts that is cheaper
  // than maintaining one.
  type Q = { x0: number; y0: number; s: number; m: number; cx: number; cy: number; n: any; kids: (Q | null)[] | null };
  function qnode(x0: number, y0: number, s: number): Q { return { x0, y0, s, m: 0, cx: 0, cy: 0, n: null, kids: null }; }
  function qinsert(q: Q, p: any, depth = 0) {
    if (q.kids) {
      const h = q.s / 2;
      const i = (p.y >= q.y0 + h ? 2 : 0) + (p.x >= q.x0 + h ? 1 : 0);
      let k = q.kids[i];
      if (!k) k = q.kids[i] = qnode(q.x0 + ((i & 1) ? h : 0), q.y0 + ((i & 2) ? h : 0), h);
      qinsert(k, p, depth + 1);
      return;
    }
    if (!q.n) { q.n = p; return; }
    // Two nodes at the same point would recurse forever. Nudge one and carry on.
    if (depth > 22 || q.s < 1e-3) { p.x += (Math.random() - 0.5) * 0.6; p.y += (Math.random() - 0.5) * 0.6; }
    const prev = q.n; q.n = null; q.kids = [null, null, null, null];
    qinsert(q, prev, depth + 1); qinsert(q, p, depth + 1);
  }
  function qmass(q: Q | null): void {
    if (!q) return;
    if (!q.kids) { if (q.n) { q.m = q.n.q0 * forces.repel * (focusCat ? 1.9 : 1); q.cx = q.n.x; q.cy = q.n.y; } return; }
    let m = 0, cx = 0, cy = 0;
    for (const k of q.kids) { if (!k) continue; qmass(k); if (!k.m) continue; m += k.m; cx += k.cx * k.m; cy += k.cy * k.m; }
    q.m = m; if (m) { q.cx = cx / m; q.cy = cy / m; }
  }
  function charge(q: Q | null, p: any, a: number) {
    if (!q || !q.m) return;
    let dx = q.cx - p.x, dy = q.cy - p.y, d2 = dx * dx + dy * dy;
    if (d2 < 1e-6) { dx = (Math.random() - 0.5) * 0.1; dy = (Math.random() - 0.5) * 0.1; d2 = dx * dx + dy * dy + 1e-6; }
    // Far enough away that the whole cell can be treated as one lump.
    if (!q.kids || (q.s * q.s) / d2 < THETA2) {
      if (q.n === p) return;
      const f = (q.m * a) / d2;
      p.vx += dx * f; p.vy += dy * f;
      return;
    }
    for (const k of q.kids) charge(k, p, a);
  }

  function tick() {
    const live = nodes.filter(vis);
    if (!live.length) return;

    // charge
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of live) { if (n.x < x0) x0 = n.x; if (n.y < y0) y0 = n.y; if (n.x > x1) x1 = n.x; if (n.y > y1) y1 = n.y; }
    const span = Math.max(x1 - x0, y1 - y0, 1) * 1.05;
    const tree = qnode(x0 - 1, y0 - 1, span + 2);
    for (const n of live) qinsert(tree, n);
    qmass(tree);
    for (const n of live) charge(tree, n, alpha);

    // link springs
    for (const e of edges) {
      if (!eOn(e)) continue;
      const a = e.a, b = e.b;
      const L = (e.k === 0 ? 34 : 96) * forces.dist;   // employment tight, shared-claim loose
      const K = e.k === 0 ? 0.62 : 0.28;
      let dx = (b.x + b.vx) - (a.x + a.vx), dy = (b.y + b.vy) - (a.y + a.vy);
      const d = Math.hypot(dx, dy) || 1e-6;
      const f = ((d - L) / d) * alpha * K;
      // The heavier end of the spring moves less, so hubs hold and leaves swing.
      const wa = b.deg / (a.deg + b.deg);
      a.vx += dx * f * wa;      a.vy += dy * f * wa;
      b.vx -= dx * f * (1 - wa); b.vy -= dy * f * (1 - wa);
    }

    // ── HUBS ─────────────────────────────────────────────────────────────────────
    //
    // Every grouping gets a real node at the centre of it, and its members orbit that
    // node. This is the thing that was missing, and the reason the tiers "weren't
    // grouped": colour alone does not group anything. You could see blue dots and red
    // dots scattered through each other and no amount of recolouring was going to turn
    // that into a shape. A group needs a CENTRE for the members to fall toward, and a
    // label on that centre saying what they have in common.
    //
    // It is the same move Obsidian makes: the big node in the middle with everything
    // pointing at it is what makes the picture mean something. Ours are synthetic — Tier
    // 1 is not an entity in the database — but that is exactly why we have to draw them.
    //
    // Three forces, and all three are needed:
    //   1. the hub tracks its members' centre of mass, so it sits where they are
    //   2. the hubs SHOVE EACH OTHER APART, so the tiers occupy different territory
    //      rather than four clouds sharing one blob
    //   3. the members are pulled to their hub, hard enough to beat the link springs
    if (hubs.length) {
      for (const h of hubs) { h.mx = 0; h.my = 0; h.n = 0; }
      for (const n of live) {
        for (const gi of hubOf.get(n.i) || []) { const h = hubs[gi]; h.mx += n.x; h.my += n.y; h.n++; }
      }
      // Size the bullet by how many it holds — same rule as every other node.
      for (const h of hubs) h.r = 10 + Math.sqrt(h.n || 1) * 2.2;
      // A pinned hub is one you are dragging. It does NOT chase its members; its members
      // chase IT. That inversion is the whole feel of grabbing a hub in Obsidian.
      for (const h of hubs) if (h.n && h.fx == null) { h.x += (h.mx / h.n - h.x) * 0.18; h.y += (h.my / h.n - h.y) * 0.18; }

      const SEP = 560;
      for (let i = 0; i < hubs.length; i++) {
        for (let j = i + 1; j < hubs.length; j++) {
          const a = hubs[i], b = hubs[j];
          if (!a.n || !b.n || a.fx != null || b.fx != null) continue;
          let dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1e-3;
          if (d >= SEP) continue;
          const f = ((SEP - d) / d) * 0.5;
          a.x -= dx * f; a.y -= dy * f; b.x += dx * f; b.y += dy * f;
        }
      }

      // Split the pull across every hub a node belongs to, so a node in three patterns
      // is not yanked three times as hard — it comes to rest between them.
      for (const n of live) {
        const mine = hubOf.get(n.i);
        if (!mine?.length) continue;
        const k = 0.10 / mine.length;
        for (const gi of mine) {
          const h = hubs[gi];
          n.vx += (h.x - n.x) * k * alpha;
          n.vy += (h.y - n.y) * k * alpha;
        }
      }
    }

    // gravity
    for (const n of live) { const g = n.g * forces.center * (focusCat ? 0.4 : 1); n.vx -= n.x * g * alpha; n.vy -= n.y * g * alpha; }

    // integrate
    for (const n of live) {
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; continue; }
      n.vx *= V_DECAY; n.vy *= V_DECAY;
      n.x += n.vx; n.y += n.vy;
    }

    alpha += (alphaTarget - alpha) * A_DECAY;
  }

  // Reheat. Every interaction that changes the shape calls this; without it the graph
  // would accept the change and refuse to move.
  function reheat(a = 0.45) { alpha = Math.max(alpha, a); kick(); }

  // Warm start: settle it headlessly before the first paint, so the graph arrives
  // composed instead of exploding outward while you watch.
  { const a0 = alpha; alpha = 0.9; for (let i = 0; i < 190; i++) tick(); alpha = a0; }
  function fit() { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const n of nodes) { a = Math.min(a, n.x); b = Math.min(b, n.y); c = Math.max(c, n.x); d = Math.max(d, n.y); } const gw = (c - a) || 1, gh = (d - b) || 1, s = Math.min((W - RAIL) / (gw * 1.16), H / (gh * 1.16)); ts = scale = s; ttx = tx = (W - RAIL) / 2 - (a + c) / 2 * s; tty = ty = H / 2 - (b + d) / 2 * s; }
  // Open closer in. Fitting the whole graph to the window is technically correct and
  // useless: 400 accounts fitted to a laptop is a page of dust. You want to land INSIDE
  // the structure, close enough to read a label, and pan out if you want the whole thing.
  fit(); ts = scale = scale * 1.7; ttx = tx = W / 2 - (W / 2 - tx) * 1.7; tty = ty = H / 2 - (H / 2 - ty) * 1.7;
  // Switching mode does not cut to a second precomputed layout any more. It changes
  // which nodes and edges are in the simulation and reheats, so the graph FLOWS into
  // the new shape. That transition is the most convincing thing in the whole view: it
  // is the moment you can see that these are the same accounts, rearranged.
  function toMode(m: string) { mode = m; sel = null; hi = null; clearActive(); reheat(0.85); }

  // The frame loop. It runs while the layout is still warm, while you are dragging, or
  // while the camera is easing — and then it stops. A graph that never stops moving is
  // a lava lamp.
  function animate() {
    if (dead) return;
    let busy = false;

    if (alpha > A_MIN || alphaTarget > 0) { tick(); busy = true; }

    scale += (ts - scale) * 0.45;
    if (Math.abs(ts - scale) > 0.0004) busy = true; else scale = ts;
    tx += (ttx - tx) * 0.45; ty += (tty - ty) * 0.45;
    if (Math.abs(ttx - tx) > 0.3 || Math.abs(tty - ty) > 0.3) busy = true; else { tx = ttx; ty = tty; }

    // `fast` drops the expensive flourishes (glow, committee halo) while things are
    // moving. Nobody can see a shadow on a node travelling at speed, and paying for it
    // is what turns 60fps into 30.
    fast = busy;
    draw();
    if (busy) requestAnimationFrame(animate);
    else { fast = false; draw(); anim = false; }
  }
  function kick() { if (!anim && !dead) { anim = true; requestAnimationFrame(animate); } }
  function req() { if (anim || dead) return; if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; if (!dead) draw(); }); } }
  function zoomAt(mx: number, my: number, factor: number) { const ns = Math.max(0.1, Math.min(9, ts * factor)), wx = (mx - tx) / scale, wy = (my - ty) / scale; ttx = mx - wx * ns; tty = my - wy * ns; ts = ns; kick(); }
  function expand(node: any) { const s = new Set<string>([node.i]); for (const nb of adj.get(node.i)!) { s.add(nb); const nn: any = byId.get(nb); if (nn && nn.t === 3) for (const nb2 of adj.get(nb)!) s.add(nb2); } if (node.t === 0) for (const c of adj.get(node.i)!) { const cc: any = byId.get(c); if (cc && cc.t === 1) for (const cl of adj.get(c)!) s.add(cl); } return s; }
  // What is LIT. Search, or a node you actually clicked. HOVER IS NOT IN HERE.
  //
  // A hover effect on a graph this dense is a strobe light: you cannot cross the canvas
  // to reach the panel without half the graph flashing at you. Obsidian gets away with a
  // hover state because its graphs are sparse. Ours is 400 accounts in a fist. So nothing
  // happens until you commit — you click, and then it stays.
  function fset(): Set<string> | null {
    if (search.trim()) {
      const s2 = new Set<string>();
      for (const n of nodes) if (vis(n) && matches(n, search)) s2.add(n.i);
      return s2;
    }
    if (hi) return hi;
    return sel ? expand(sel) : null;
  }
  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    { const gx = (W - RAIL) / 2, gy = H * 0.46, rr = Math.max(W, H) * 0.62, rg = ctx.createRadialGradient(gx, gy, 0, gx, gy, rr); rg.addColorStop(0, LIGHT ? 'rgba(0,0,0,0)' : 'rgba(98,108,150,0.06)'); rg.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H); }
    ctx.setTransform(DPR * scale, 0, 0, DPR * scale, DPR * tx, DPR * ty); const S = fset();
    // vis() decides what is on the canvas. The draw loop used to re-derive visibility
    // from `mode` alone and never consult it — which is why every Show toggle changed the
    // counts in the panel, changed the simulation, and changed nothing you could see.
    // The switches worked. The renderer was not listening.
    for (const e of edges) { if (!F(e.a.x) || !F(e.b.x)) continue; if (!vis(e.a) || !vis(e.b)) continue; if (!eOn(e)) continue; const on = !S || (S.has(e.a.i) && S.has(e.b.i)); let col, w; if (!on) { col = E_DIM; w = 0.5; } else if (e.k === 2) { col = E_CLAIM; w = 0.8; } else if (e.k === 3) { col = E_KNOWS; w = 0.9; } else { col = e.a.dm ? E_DM : E_LINK; w = e.a.dm ? 0.9 : 0.55; } ctx.strokeStyle = col; ctx.lineWidth = (w * disp.link) / scale; ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke(); }
    // ── HUB SPOKES ───────────────────────────────────────────────────────────
    //
    // The line from the hub to each member. This is the single thing that makes
    // Obsidian's graph read as a STRUCTURE rather than a scatter, and we were missing
    // it: a coloured tinted blob says "these are near each other", which is a hint. A
    // spoke says "this belongs to this", which is a fact. And once every membership is
    // drawn, dragging the hub drags the whole constellation with it, because there is
    // something physically holding them.
    //
    // No tinted background. A wash of colour behind a cluster is decoration, and it
    // fights every other colour on the canvas.
    ctx.lineWidth = (0.7 * disp.link) / scale;
    for (const n of nodes) {
      const mine = hubOf.get(n.i);
      if (!mine?.length || !F(n.x) || !vis(n)) continue;
      const dim = S && !S.has(n.i);
      for (const gi of mine) {
        const h = hubs[gi];
        if (!h || !F(h.x)) continue;
        ctx.globalAlpha = dim ? 0.06 : 0.22;
        ctx.strokeStyle = h.color;
        ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(n.x, n.y); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    for (const h of hubs) {
      if (!h.n || !F(h.x)) continue;
      const R = h.r;
      ctx.beginPath(); ctx.arc(h.x, h.y, R, 0, 6.283);
      ctx.fillStyle = h.color; ctx.fill();
      // A ring in the page colour, so the bullet never visually merges with a member
      // that drifts under it.
      ctx.lineWidth = 2.5 / scale; ctx.strokeStyle = BG; ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // Name only. The count belonged in the panel, where it already is — printing it on
      // the canvas turned a label into a readout, and you cannot look at a readout.
      ctx.font = '600 ' + (10.5 * disp.label) / scale + 'px ui-sans-serif,system-ui,sans-serif';
      ctx.lineWidth = 3.5 / scale; ctx.strokeStyle = BG;
      ctx.strokeText(h.label, h.x, h.y + R + 9 / scale);
      ctx.fillStyle = h.color;
      ctx.fillText(h.label, h.x, h.y + R + 9 / scale);
      ctx.textBaseline = 'top';
    }

    for (const n of nodes) {
      if (!F(n.x) || !vis(n)) continue;
      const gcPre = groupColor(n);
      // Grouped-out: a group is on and this node is not in one.
      // Grouping never dims. It COLOURS. The whole graph stays lit; the tiers are told
      // apart by hue and by where their hubs pull them, not by fading the others into the
      // background. The only thing that dims is a deliberate selection or search — a
      // click, not a passive state.
      const faded = !!(S && !S.has(n.i));
      ctx.globalAlpha = faded ? 0.14 : 1;
      if (n.t === 3) { const r = n.r * disp.node, cc = groupColor(n) ?? (CATCOL[n.cat] || CLA); ctx.save(); ctx.translate(n.x, n.y); ctx.rotate(0.785); if (!fast && !faded && !LIGHT) { ctx.shadowColor = cc; ctx.shadowBlur = 13; } ctx.fillStyle = cc; ctx.fillRect(-r, -r, 2 * r, 2 * r); ctx.shadowBlur = 0; ctx.restore(); ctx.globalAlpha = 1; continue; }
      // A category lens is about the pattern, not the ICP — so accounts drop their tier
      // colour and go neutral, letting the (type-coloured) hubs carry the meaning.
      const gc = focusCat ? null : gcPre;
      const col = focusCat ? SLATE : (gc ?? (n.t === 1 ? COMPANY(n) : fillP(n)));
      const lit = !faded && !focusCat && (col === GREEN || col === GOLD || (n.t === 1 && n.look));
      if (!fast && lit && !LIGHT) { ctx.shadowColor = (n.t === 1 && n.look) ? GOLD : col; ctx.shadowBlur = n.t === 1 ? 12 : 9; } else ctx.shadowBlur = 0;
      // A node in a group is drawn larger and ringed. Colour alone is not enough at this
      // scale, and the whole point of a group is that you can find it without hunting.
      const R = n.r * disp.node * (gc ? 1.35 : 1) * (n === sel ? 1.25 : 1);
      ctx.beginPath(); ctx.arc(n.x, n.y, R, 0, 6.283); ctx.fillStyle = col; ctx.fill(); ctx.shadowBlur = 0;
      // Only the decision-maker mark survives as a stroke. A group no longer needs a halo:
      // it has its own colour AND the whole graph is partitioned, so there is nothing to
      // pick it out FROM. Rings on top of rings is what made this look vibe-coded.
      if (n.dm && n.t === 0) { ctx.lineWidth = 1.2 / scale; ctx.strokeStyle = GOLD; ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const n of nodes) {
      if (!F(n.x) || !vis(n)) continue; const near = S && S.has(n.i);
      // In a category lens the view is sparse, so name the accounts — telling person
      // from person is the whole point there. In the dense overview, labels stay lazy.
      const showLbl = near || (n.t === 3 && scale > 0.4) || (n.t === 1 && scale > 0.75) || (focusCat && n.t === 0 && scale > 0.45) || scale > 1.7; if (!showLbl) continue;
      let lb = n.l || (n.t === 1 ? 'company' : 'person'); if (!lb) continue; if (lb.length > 26) lb = lb.slice(0, 25) + '…';
      const big = n.t === 3 || n.t === 1; const fs = ((near ? 12 : (big ? 11 : 10)) * disp.label) / scale;
      ctx.font = (big ? '600 ' : '500 ') + fs + 'px ui-sans-serif,system-ui,sans-serif';
      ctx.lineWidth = 3.4 / scale; ctx.strokeStyle = BG; ctx.strokeText(lb, n.x, n.y + n.r + 3 / scale);
      ctx.fillStyle = n.t === 3 ? (CATCOL[n.cat] || CLA) : 'rgba(' + INK + ',' + (near ? 1 : (n.t === 1 ? 0.85 : 0.4)) + ')';
      ctx.fillText(lb, n.x, n.y + n.r + 3 / scale);
    }
  }
  draw();
  // Hit test. The slop is generous and it is generous in SCREEN pixels, not world units,
  // so a company stays as easy to hit zoomed out as zoomed in — which it very much was
  // not before. Companies get more slop than people because a company is the thing you
  // are usually reaching for, and grouped nodes get more again because they are drawn
  // bigger and the target should match what you see.
  function pick(cx: number, cy: number) {
    const rb = root.getBoundingClientRect();
    const wx = (cx - rb.left - tx) / scale, wy = (cy - rb.top - ty) / scale;
    let best: any = null, bd = 1e9;
    // Hubs first: they are the thing you reach for to reorganise the canvas, so they win
    // ties against a member that has drifted underneath.
    for (const h of hubs) {
      if (!h.n || !F(h.x)) continue;
      const R = h.r + 8 / scale;
      const dx = wx - h.x, dy = wy - h.y, d = dx * dx + dy * dy;
      if (d < R * R && d < bd) { bd = d; best = h; }
    }
    if (best) return best;
    for (const n of nodes) {
      if (!F(n.x) || !vis(n)) continue;
      const slop = (n.t === 1 ? 10 : n.t === 3 ? 8 : 6) / scale;
      const R = n.r * disp.node * (groupColor(n) ? 1.35 : 1) + slop;
      const dx = wx - n.x, dy = wy - n.y, d = dx * dx + dy * dy;
      if (d < R * R && d < bd) { bd = d; best = n; }
    }
    return best;
  }
  // Two kinds of drag, and the difference is the whole point. Grab empty space and you
  // pan the camera. Grab a NODE and you move the node — the springs stretch, its
  // neighbours follow, the cluster reorganises around your cursor. That is the thing
  // that makes a graph feel like an object rather than a screenshot.
  let drag = false, lx = 0, ly = 0, moved = 0;
  let held: any = null;   // the node under the cursor, pinned while you hold it

  const onMove = (e: MouseEvent) => {
    if (held) {
      const r = cv.getBoundingClientRect();
      held.fx = (e.clientX - r.left - tx) / scale;
      held.fy = (e.clientY - r.top - ty) / scale;
      // A hub is not in the integrator, so move it directly. Its members are springed to
      // it, so the whole constellation follows your cursor.
      if (held.hub) { held.x = held.fx; held.y = held.fy; }
      moved++;
      // Keep it warm the whole time you are holding it, so the neighbourhood keeps
      // reacting rather than freezing after the first shove.
      alphaTarget = 0.3; reheat(0.3);
      return;
    }
    if (drag) { tx += e.clientX - lx; ty += e.clientY - ly; ttx = tx; tty = ty; lx = e.clientX; ly = e.clientY; moved++; fast = true; if (tip) tip.style.display = 'none'; req(); return; }
    // Cursor only. Nothing on the canvas reacts to the pointer — see fset().
    const under: any = pick(e.clientX, e.clientY);
    cv.style.cursor = under ? 'pointer' : 'grab';
    // In a category lens (a sparse view), hovering an account reveals its OWN words that
    // ground it in the focused pattern — the thing Obsidian shows you. Off in the dense
    // overview, where a hover would strobe.
    if (tip) {
      const ev = focusCat && under && under.t === 0 ? (under.pat || []).find((p: any) => p.cat === focusCat && p.evidence) : null;
      if (ev) {
        const rb = root.getBoundingClientRect();
        tip.style.left = (e.clientX - rb.left + 14) + 'px';
        tip.style.top = (e.clientY - rb.top + 14) + 'px';
        tip.innerHTML = `<b>${esc(under.l || 'account')}</b><em>${esc(ev.label)}</em><span>“${esc(ev.evidence)}”</span>`;
        tip.style.display = 'block';
      } else tip.style.display = 'none';
    }
  };
  const onDown = (e: MouseEvent) => {
    moved = 0;
    const n: any = pick(e.clientX, e.clientY);
    if (n) { held = n; n.fx = n.x; n.fy = n.y; cv.style.cursor = 'grabbing'; alphaTarget = 0.3; reheat(0.3); return; }
    drag = true; lx = e.clientX; ly = e.clientY; cv.style.cursor = 'grabbing';
  };
  const onUp = (e: MouseEvent) => {
    if (held) {
      // Let go and it rejoins the simulation where you left it, rather than snapping
      // back. Then everything settles.
      held.fx = null; held.fy = null;
      const wasClick = moved < 3;
      const n = held;
      held = null; alphaTarget = 0; cv.style.cursor = 'grab';
      // A hub is not an account. Dragging it is the point; clicking it opens nothing.
      if (wasClick && !n.hub) { sel = (n === sel) ? null : n; hi = null; clearActive(); if (onOpen) onOpen(n); }
      reheat(0.14);
      return;
    }
    if (!drag) return;
    drag = false; fast = false; cv.style.cursor = 'grab';
    if (moved < 3) { const n = pick(e.clientX, e.clientY); if (n && !n.hub) { sel = (n === sel) ? null : n; hi = null; clearActive(); if (onOpen) onOpen(n); } }
    req();
  };
  const onWheel = (e: WheelEvent) => { e.preventDefault(); const rb = root.getBoundingClientRect(); let d = e.deltaY; if (e.deltaMode === 1) d *= 16; d = Math.max(-50, Math.min(50, d)); zoomAt(e.clientX - rb.left, e.clientY - rb.top, Math.exp(-d * 0.003)); };
  const onDbl = () => { sel = null; hi = null; clearActive(); reheat(0.7); fit(); };
  const onResize = () => { size(); fit(); req(); };
  cv.addEventListener('mousemove', onMove); cv.addEventListener('mousedown', onDown); window.addEventListener('mouseup', onUp);
  cv.addEventListener('mouseleave', () => { if (tip) tip.style.display = 'none'; });
  cv.addEventListener('wheel', onWheel, { passive: false }); cv.addEventListener('dblclick', onDbl); window.addEventListener('resize', onResize);
  (root.querySelector('#gx-zin') as HTMLElement).onclick = () => zoomAt((W - RAIL) / 2, H / 2, 1.4);
  (root.querySelector('#gx-zout') as HTMLElement).onclick = () => zoomAt((W - RAIL) / 2, H / 2, 1 / 1.4);
  (root.querySelector('#gx-zfit') as HTMLElement).onclick = () => { sel = null; hi = null; clearActive(); fit(); kick(); };
  // The rail this used to clear is gone; it now only drops the highlight set.
  function clearActive() { hi = null; }

  // The engine is driven from React now, not from innerHTML it wrote itself.
  return {
    dispose() {
      dead = true;
      cv.removeEventListener('mousemove', onMove); cv.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp); cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('dblclick', onDbl); window.removeEventListener('resize', onResize);
    },
    setShow(v: typeof show)     { show = { ...show, ...v }; reheat(0.35); },
    setSearch(v: string)        { search = v; req(); },
    setFilter(v: string)        { filter = v; refilter(); reheat(0.5); },
    setGroups(v: typeof groups) { groups = v; regroup(); reheat(0.5); },
    setDisplay(v: typeof disp)  { disp = { ...disp, ...v }; req(); },
    setForces(v: typeof forces) { forces = { ...forces, ...v }; reheat(0.5); },
    setMode(m: string)          { toMode(m); },
    // Focus the graph on one revenue category (or null for the ICP overview). Re-derives
    // the accounts on that type's hubs, then reheats so they cluster around them.
    setFocus(cat: string | null) { focusCat = cat || null; computeFocus(); if (tip) tip.style.display = 'none'; toMode(cat ? 'patterns' : 'accounts'); },
    fit()                       { sel = null; hi = null; clearActive(); reheat(0.6); fit(); },
    // What is actually on the canvas right now. The panel shows these counts, because a
    // filter that does not tell you how much it removed is a filter you cannot trust.
    counts() {
      const on = nodes.filter(vis);
      return {
        companies: on.filter((n: any) => n.t === 1).length,
        people:    on.filter((n: any) => n.t === 0).length,
        claims:    on.filter((n: any) => n.t === 3).length,
        matched:   search.trim() ? on.filter((n: any) => matches(n, search)).length : null,
        total:     nodes.length,
        // How many nodes each group actually caught. A group that shows "0" is telling
        // you the query is wrong, which is the single most useful thing it can say.
        groups:    groups.map(g => (g.q ? on.filter((n: any) => matches(n, g.q)).length : 0)),
        // Every signal that has actually fired on a visible account, biggest first. The
        // panel offers these as a grouping instead of asking you to know the scorecard's
        // key names by heart. If this comes back with three entries, that is not a UI
        // problem — that is the ICP model telling you only three of its signals work.
        signals: (() => {
          const m = new Map<string, number>();
          for (const n of on) for (const k of (n.sig || [])) m.set(k, (m.get(k) || 0) + 1);
          return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n }));
        })(),
        // The shared claims carried by the PEOPLE on the canvas, biggest first. Counted on
        // people, not companies, because people are what the hubs hold.
        patterns: (() => {
          const m = new Map<string, { n: number; cat: string }>();
          for (const p of on) {
            if (p.t !== 0) continue;
            for (const pt of (p.pat || [])) {
              const cur = m.get(pt.label) || { n: 0, cat: pt.cat };
              cur.n++; m.set(pt.label, cur);
            }
          }
          return [...m.entries()].sort((a, b) => b[1].n - a[1].n).map(([key, v]) => ({ key, n: v.n, cat: v.cat }));
        })(),
      };
    },
  };
}

const CSS = `
.gx-root{position:absolute;inset:0;background:#17191e;overflow:hidden;color:#fff;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
.gx-root #gx-c{display:block;cursor:grab;position:absolute;left:0;top:0}
.gx-back{position:absolute;left:16px;top:16px;z-index:7;width:34px;height:34px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;color:rgba(255,255,255,.8);cursor:pointer;backdrop-filter:blur(8px)}
.gx-back:hover{background:rgba(255,255,255,.13)}
.gx-root #gx-bar{position:absolute;left:16px;bottom:16px;display:flex;gap:6px;z-index:6}
.gx-root #gx-bar button{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);color:rgba(255,255,255,.8);width:32px;height:32px;border-radius:9px;font-size:16px;cursor:pointer;backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center}
.gx-root #gx-bar button:hover{background:rgba(255,255,255,.13)}
.gx-root #gx-tip{position:absolute;display:none;z-index:9;pointer-events:none;background:rgba(14,17,24,.96);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:7px 10px;backdrop-filter:blur(10px);max-width:240px}
.gx-root #gx-tip b{display:block;color:#fff;font-size:12px;font-weight:600}.gx-root #gx-tip b i{color:#f5b942;font-style:normal;font-weight:500;font-size:10px}
/* ── Light theme: the ICP model lives inside the Vault, next to documents. A dark
   panel there is a hole in the page. Obsidian's graph is light for the same reason. */
.gx-root.gx-light{background:#fff !important;color:#1a1d23}
.gx-root.gx-light #gx-c{background:#fff}
.gx-root.gx-light #gx-bar button{background:rgba(255,255,255,.9);border:1px solid rgba(20,24,32,.1);color:rgba(26,29,35,.7);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.gx-root.gx-light #gx-bar button:hover{background:#fff;color:#1a1d23}
.gx-root.gx-light #gx-tip{background:rgba(255,255,255,.97);border:1px solid rgba(20,24,32,.1);box-shadow:0 6px 20px rgba(0,0,0,.08)}
.gx-root.gx-light #gx-tip b{color:#1a1d23}
.gx-root.gx-light #gx-tip b i{color:#c98a24}
.gx-root.gx-light #gx-tip span,.gx-root.gx-light #gx-tip div{color:rgba(26,29,35,.6)}

.gx-root #gx-tip span{display:block;color:rgba(255,255,255,.5);font-size:10.5px;margin-top:2px}.gx-root #gx-tip em{display:block;color:#f0a33a;font-size:10px;font-style:normal;margin-top:3px}
.gx-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.4);font-size:13px}
.gx-root.gx-light .gx-msg{color:rgba(26,29,35,.4)}
`;

// Embedded mode. The canvas engine positions everything `fixed`, which is right for
// the war-room at /graph and wrong inside a page, where it would cover the sidebar.
// Rather than rewrite the engine, we scope it: every `position:fixed` becomes
// `absolute`, and the host wraps it in a `relative` box. Same engine, contained.
//
// This exists because the graph is not a destination. It is a rendering of the
// accounts, and it belongs on the Accounts page next to the table — the same data,
// seen two ways. The full-screen route stays for when you want the whole window.
// Nothing is `fixed` any more: the root is a flex child and every overlay anchors to it,
// so the graph is contained wherever it is mounted. Kept as the light-theme entry point.
const CSS_EMBEDDED = CSS;

// Small typed localStorage helpers. A corrupt or absent value falls back to the default
// rather than throwing — a saved preference must never be able to break the graph.
function readPref<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? { ...fallback, ...JSON.parse(v) } : fallback; }
  catch { return fallback; }
}
function writePref<T>(key: string, val: T): void {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode / quota — not worth surfacing */ }
}

// ── The committee readout ─────────────────────────────────────────────────────
//
// The graph draws which accounts are alive. Clicking one on the war-room used to do
// nothing but light its neighbours — a dead interaction on the one surface where the
// whole buying group is already on screen. This is what makes the graph read as buyer
// INTELLIGENCE rather than a heat map: click a company and it reads the room. Who is in
// the buying group, who holds budget, who is your champion, and where the account is
// exposed — single-threaded, or with nobody who can sign.
//
// Every number here already rides on the nodes the graph loaded: the committee is the
// people whose `co` is this company, each carrying score, tier, decision-maker flag and
// days-since-activity. No new fetch. The intelligence was always in the graph; we were
// only ever drawing the temperature.
const TIER_LABEL: Record<string, string> = { tier_1: "Tier 1", tier_2: "Tier 2", tier_3: "Tier 3", not_icp: "Not ICP" };
// Score → the same gold/green/slate the canvas uses, so a dot in the card and a dot on
// the graph mean the identical thing.
function scoreHex(s: number | null): string {
  if (s == null) return "#9aa0ad";
  if (s >= 85) return "#e0a03a";
  if (s >= 70) return "#2fa36b";
  if (s >= 50) return "#8ec9a9";
  return "#9aa0ad";
}
// Days-since-activity, said the way a rep says it. Cold flags the ones that need warming.
function warmthOf(a: number | null): { label: string; cold: boolean } {
  if (a == null) return { label: "no activity yet", cold: true };
  if (a <= 7) return { label: "active this week", cold: false };
  if (a <= 30) return { label: `active ${a}d ago`, cold: false };
  return { label: `quiet ${a}d`, cold: true };
}
// The read of the room. A verdict, the gaps, and who the champion is — the champion being
// the engaged decision-maker with the strongest fit, because that is the thread you work.
function readRoom(members: any[]) {
  const n = members.length;
  const dms = members.filter((m) => m.dm);
  const engagedDm = dms.filter((m) => m.a != null && m.a <= 30).sort((a, b) => (b.s ?? -1) - (a.s ?? -1))[0] || null;
  const topDm = [...dms].sort((a, b) => (b.s ?? -1) - (a.s ?? -1))[0] || null;
  const active = members.filter((m) => m.a != null && m.a <= 30).length;
  const gaps: string[] = [];
  if (n <= 1) gaps.push("Single-threaded");
  if (!dms.length && n >= 1) gaps.push("No budget-holder");
  let verdict: string;
  if (n === 0) verdict = "No contacts mapped on this account yet";
  else if (n === 1) verdict = "Single-threaded — one contact carries the whole account";
  else if (!dms.length) verdict = `${n} contacts, none with buying authority`;
  else if (engagedDm) verdict = `Championed — ${engagedDm.l || "a decision-maker"} holds budget and is engaged`;
  else verdict = `${topDm?.l || "The decision-maker"} has gone quiet — warm the room`;
  return { n, active, gaps, verdict, championId: engagedDm?.i || null, dmIds: new Set(dms.map((d) => d.i)) };
}

function CommitteeCard({ room, onClose, onOpenAccount }: {
  room: { company: any; members: any[]; focus: string | null };
  onClose: () => void;
  onOpenAccount: (id: string) => void;
}) {
  const { company, members, focus } = room;
  const r = readRoom(members);
  const w = warmthOf(company.a);
  const tier = company.tier ? TIER_LABEL[company.tier] : null;
  return (
    <aside className={cn(
      "absolute left-4 top-16 z-10 w-[300px] max-h-[calc(100%-5rem)] flex flex-col",
      "rounded-xl border border-border/80 bg-background/90 backdrop-blur-xl",
      "shadow-[0_8px_30px_rgba(0,0,0,0.12)] overflow-hidden",
    )}>
      <div className="px-3.5 py-3 flex items-start justify-between border-b border-border/60 flex-shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full flex-shrink-0 ring-1 ring-black/10" style={{ background: scoreHex(company.s) }} />
            <span className="text-[13px] font-semibold text-foreground truncate">{company.l || "Company"}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            {tier && <span className="tabular-nums">{tier}{company.s != null ? ` · ${company.s}` : ""}</span>}
            {tier && <span className="opacity-40">·</span>}
            <span className={cn(w.cold && "text-amber-600/80")}>{w.label}</span>
          </div>
        </div>
        <button onClick={onClose} className="p-1 -mr-1 -mt-0.5 rounded text-muted-foreground/40 hover:text-foreground flex-shrink-0" title="Close">
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      <div className="px-3.5 py-2.5 border-b border-border/50 flex-shrink-0">
        <p className="text-[12px] leading-snug text-foreground/85">{r.verdict}</p>
        {r.gaps.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {r.gaps.map((g) => (
              <span key={g} className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 text-[10.5px] font-medium">
                <AlertTriangle className="h-3 w-3" strokeWidth={2} />{g}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1.5">
        {members.length === 0 ? (
          <p className="px-2 py-3 text-[11.5px] text-muted-foreground/50">No people resolved at this account yet.</p>
        ) : members.map((m) => {
          const mw = warmthOf(m.a);
          const isChamp = m.i === r.championId;
          const isDm = r.dmIds.has(m.i);
          return (
            <div key={m.i} className={cn("flex items-center gap-2 rounded-lg px-2 py-1.5", m.i === focus && "bg-accent/60")}>
              <span className="h-2 w-2 rounded-full flex-shrink-0 ring-1 ring-black/10" style={{ background: scoreHex(m.s) }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] text-foreground/90 truncate">{m.l || "Unknown"}</span>
                  {isChamp && <Crown className="h-3 w-3 flex-shrink-0 text-amber-500" strokeWidth={2} />}
                </div>
                <div className="flex items-center gap-1 text-[10.5px] text-muted-foreground/60 truncate">
                  {m.jt && <span className="truncate">{m.jt}</span>}
                  {isDm && !isChamp && <span className="text-foreground/50 flex-shrink-0">· decision-maker</span>}
                </div>
              </div>
              <span className={cn("text-[10px] tabular-nums flex-shrink-0", mw.cold ? "text-amber-600/70" : "text-muted-foreground/50")}>{mw.label}</span>
            </div>
          );
        })}
      </div>

      <button onClick={() => onOpenAccount(company.i)} className="flex items-center justify-center gap-1.5 border-t border-border/60 px-3.5 py-2.5 text-[12px] font-medium text-foreground/80 hover:bg-accent/60 flex-shrink-0 transition-colors">
        Open account <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </aside>
  );
}

export default function Galaxy({ embedded = false, view = "graph", onOpen }: { embedded?: boolean; view?: "graph" | "icp"; onOpen?: (n: { i: string; l: string | null; t: number }) => void } = {}) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = (userData as any)?.workspace?.id ?? "";
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const ctl = useRef<any>(null);
  // Held in a ref so a new callback identity never tears down and rebuilds the engine.
  const onOpenRef = useRef(onOpen);
  useEffect(() => { onOpenRef.current = onOpen; }, [onOpen]);
  // The loaded graph, kept so a click can read the committee off nodes already on the
  // canvas — no second fetch. The committee readout is the war-room's own interaction;
  // embedded on the Accounts page a click opens the full record instead, so we leave that
  // path untouched and only build the room when we own the whole window.
  const dataRef = useRef<any>(null);
  const [room, setRoom] = useState<{ company: any; members: any[]; focus: string | null } | null>(null);
  const openRef = useRef<(n: any) => void>(() => {});
  const openCommittee = (n: any) => {
    const D = dataRef.current;
    if (embedded || !D || !n || n.t === 3) { if (!embedded) setRoom(null); return; }
    const companyId = n.t === 1 ? n.i : n.co;
    if (!companyId) { setRoom(null); return; }
    setRoom((prev) => {
      // Re-clicking the open company toggles it shut, the same way the canvas toggles its
      // own selection — clicking a PERSON re-focuses the room rather than closing it.
      if (prev && prev.company.i === companyId && n.t === 1) return null;
      const company = D.nodes.find((x: any) => x.i === companyId);
      if (!company) return null;
      const members = D.nodes.filter((x: any) => x.t === 0 && x.co === companyId).sort((a: any, b: any) => (b.s ?? -1) - (a.s ?? -1));
      return { company, members, focus: n.t === 0 ? n.i : null };
    });
  };
  openRef.current = (n: any) => { onOpenRef.current?.(n); openCommittee(n); };
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [show, setShow] = useState<Show>({ people: true, companies: true, claims: true, orphans: false });
  const [search, setSearch] = useState("");
  // The graph opens as the ICP OVERVIEW — accounts coloured by tier, the map you want
  // first. Colour stays tier throughout; the LENS (below) is a separate axis that
  // refocuses the graph onto one revenue category (objections, pains, …) on click.
  const [groupBy, setGroupBy] = useState<GroupBy>("tier");
  const [groups, setGroups] = useState<Group[]>(() => buildGroups("tier", {}));
  // Which category the graph is focused on. 'icp' = the overview; a concept type
  // ('objection', 'pain', …) re-renders toward that category's concept web.
  const [lens, setLens] = useState<string>("icp");
  const [filter, setFilter] = useState("");
  // Display and Forces are the user's own tuning of THEIR graph, so they persist. Group
  // by / filter / search are questions you ask in the moment and reset when you leave;
  // node size and gravity are a preference, and a preference that forgets itself every
  // reload is just an annoyance. Reset (the ↺ in the panel) clears the key.
  const [display, setDisplay] = useState<Display>(() => readPref("nous.graph.display", { node: 1, label: 1, link: 1 }));
  const [forces, setForces] = useState<Forces>(() => readPref("nous.graph.forces", { repel: 1, dist: 1, center: 1 }));
  useEffect(() => { writePref("nous.graph.display", display); }, [display]);
  useEffect(() => { writePref("nous.graph.forces", forces); }, [forces]);
  const [counts, setCounts] = useState<Counts>({ companies: 0, people: 0, claims: 0, matched: null, total: 0, groups: [], signals: [], patterns: [] });

  // Push panel state into the engine, then read back what is actually on the canvas.
  // The panel reports the consequence of every control, which is the whole difference
  // between a filter and a set of decorative switches.
  const sync = (fn: (c: any) => void) => {
    const c = ctl.current; if (!c) return;
    fn(c);
    setCounts(c.counts());
  };
  // Choosing an axis REBUILDS the buckets. Custom is the exception: it is the axis you
  // are writing yourself, so it must not be overwritten under you.
  // Rebuild the buckets when the axis changes OR when the facets first arrive — the
  // pattern buckets come from the loaded graph (facets.patterns), so on first paint
  // they are empty and must repopulate the moment the data lands. Idempotent.
  useEffect(() => {
    if (groupBy === "custom") return;
    const f = ctl.current?.counts() ?? counts;
    setGroups(buildGroups(groupBy, { signals: f.signals, patterns: f.patterns }));
  }, [groupBy, counts.patterns?.length, counts.signals?.length]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { sync(c => c.setShow(show)); }, [show]);       // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sync(c => c.setFilter(filter)); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sync(c => c.setSearch(search)); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sync(c => c.setGroups(groups)); }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps
  // A category lens is NOT about ICP tier — so drop the tier grouping entirely (its
  // anchors and colours) when one is active, and restore it on the ICP overview.
  useEffect(() => {
    sync(c => c.setFocus(lens === "icp" ? null : lens));
    setGroups(lens === "icp" ? buildGroups("tier", {}) : []);
  }, [lens]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sync(c => c.setDisplay(display)); }, [display]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sync(c => c.setForces(forces)); }, [forces]);    // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!token || !workspaceId || !rootRef.current) return;
    let disposed = false; let dispose: (() => void) | null = null;
    setLoading(true); setErr(null); setRoom(null);
    // The ICP view needs the learned model as well as the graph, so the rail can show
    // what actually predicts a win. Fetched alongside, and a failure here is not fatal:
    // a graph with no rail beats no graph.
    const scorecard = view === 'icp'
      ? fetch(`${apiUrl}/api/mind/scorecard?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } })
          .then(r => (r.ok ? r.json() : null))
          .then(j => j?.signals ?? j?.top_signals ?? [])
          .catch(() => [])
      : Promise.resolve([]);

    fetch(`${apiUrl}/api/graph?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (r.ok) return r.json();
        const body = await r.text();
        let msg = `${r.status}`;
        try { const j = JSON.parse(body); msg = j.error ? `${r.status} ${j.error}` : msg; } catch { msg = `${r.status} ${body.slice(0, 60) || r.statusText}`; }
        return Promise.reject(new Error(msg));
      })
      .then(async (DATA: any) => {
        if (disposed || !rootRef.current) return;
        DATA.scorecard = await scorecard;
        if (disposed || !rootRef.current) return;
        setLoading(false);
        dataRef.current = DATA;
        if (!DATA.nodes?.length) return;
        // Seed positions only. The engine's live simulation takes it from here, warms
        // it, settles it, and keeps responding. There is no second precomputed layout
        // any more: switching mode reheats the sim instead of tweening to a frozen one.
        layout(DATA.nodes, DATA.edges);
        // A live wrapper, not the value: the engine is built once, and a callback captured
        // by value would freeze whatever `onOpen` was on the very first render.
        const c = runEngine(rootRef.current, DATA, view, embedded, (n: any) => openRef.current(n));
        ctl.current = c;
        dispose = () => c.dispose();
        // Push the panel's initial state in before the first counts read, or the tier
        // groups the graph opens with would be invisible to the engine.
        c.setGroups(groups); c.setFilter(filter); c.setShow(show);
        setCounts(c.counts());
      })
      .catch((e: any) => { if (!disposed) { setErr(e?.message || e?.error || "failed_to_load"); setLoading(false); } });
    return () => { disposed = true; if (dispose) dispose(); };
  }, [token, workspaceId, view, embedded]);

  return (
    <div className={embedded ? "absolute inset-0" : "fixed inset-0"}>
    <div ref={rootRef} className={embedded ? "gx-root gx-light" : "gx-root"}>
      <style>{embedded ? CSS_EMBEDDED : CSS}</style>
      <canvas id="gx-c" />
      {/* Evidence tooltip — only used in a category lens (a sparse view), where hovering
          an account reveals the account's OWN words that ground it in the pattern. */}
      <div id="gx-tip" />
      {/* Back only exists on the full-screen route. Embedded, there is nowhere to go
          back to — you are already on the page. */}
      {!embedded && (
        <button className="gx-back" onClick={() => navigate("/accounts")} title="Back"><ArrowLeft size={16} /></button>
      )}
      <div id="gx-bar"><button id="gx-zout">−</button><button id="gx-zfit">⤢</button><button id="gx-zin">+</button></div>
      {loading && <div className="gx-msg">{view === "icp" ? "drawing the model…" : "building your context graph…"}</div>}
      {err && <div className="gx-msg">could not load the graph ({err})</div>}
    </div>

    {!loading && !err && (
      <GraphFilters
        show={show} setShow={setShow}
        search={search} setSearch={setSearch}
        groupBy={groupBy} setGroupBy={setGroupBy}
        lens={lens} setLens={setLens}
        groups={groups} setGroups={setGroups}
        filter={filter} setFilter={setFilter}
        display={display} setDisplay={setDisplay}
        forces={forces} setForces={setForces}
        counts={counts}
        onFit={() => sync(c => c.fit())}
      />
    )}
    {room && !embedded && (
      <CommitteeCard room={room} onClose={() => setRoom(null)} onOpenAccount={(id) => navigate(`/companies/${id}`)} />
    )}
    </div>
  );
}
