/**
 * The guided setup tour — the spotlight overlay + step machine.
 *
 * Mounted once inside the app shell (StandardLayout), so it survives navigation between
 * Integrations, Accounts and the ICP model and can drive that navigation itself. It reads
 * where the user is, sends them to the right page, spotlights the one button that matters,
 * and watches server truth (useTourProgress) to know when the step is actually done.
 *
 * Two shapes of step: a centered card (welcome, billing) and an anchored spotlight over a
 * real [data-tour] button. If the anchored element isn't on the page yet, the card centers
 * and offers to take them there rather than pointing at nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ArrowRight, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useTourProgress, type TourProgress, REQUIRED_SOURCES } from '@/hooks/useTourProgress';
import {
  TOUR_STEPS, loadTourState, saveTourState,
  type TourStep, type TourStatus,
} from '@/lib/tour';

const CARD_W = 372;
const apiUrl = import.meta.env.VITE_API_URL ?? '';

function anchorRoutePath(route?: string) {
  return route ? route.split('?')[0] : undefined;
}

function firstName(session: ReturnType<typeof useAuth>['session'], email?: string): string {
  const meta = (session?.user as { user_metadata?: { full_name?: string } } | undefined)?.user_metadata;
  const full = meta?.full_name?.trim();
  if (full) return full.split(/\s+/)[0];
  if (email) return email.split('@')[0].replace(/[._-]+/g, ' ').split(' ')[0];
  return '';
}

export default function GuidedTour() {
  const { isAuthenticated, session, userData } = useAuth();
  const wsId = (userData as { workspace?: { id?: string } })?.workspace?.id;
  const email = (userData as { user?: { email?: string } })?.user?.email;
  const navigate = useNavigate();
  const location = useLocation();

  const [status, setStatus] = useState<TourStatus>('unstarted');
  const [step, setStep] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from storage once we know the workspace. A finished/dismissed tour stays
  // that way; an 'unstarted' one is NOT opened yet — it waits for the server flag below,
  // so it never flashes for someone who already completed it on another device.
  useEffect(() => {
    if (!wsId) return;
    const s = loadTourState(wsId);
    if (s.status !== 'unstarted') { setStatus(s.status); setStep(s.step); }
    setHydrated(true);
  }, [wsId]);

  const persist = useCallback((next: { status: TourStatus; step: number }) => {
    if (wsId) saveTourState(wsId, next);
  }, [wsId]);

  // Fire-and-forget: stamp the workspace so the tour never re-shows on any device.
  const markTourSeen = useCallback(() => {
    const token = session?.access_token;
    if (!token) return;
    fetch(`${apiUrl}/api/onboarding/tour-seen`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }, [session]);

  const active = hydrated && isAuthenticated && status === 'active';
  const current: TourStep | undefined = TOUR_STEPS[step];

  const progress = useTourProgress(active);

  // Server-gated auto-start. Only open a never-seen tour once we've confirmed with the
  // server that this workspace hasn't already completed it (tourCompleted) — otherwise
  // a cleared/new browser would re-show it. If the server says done, cache that locally.
  useEffect(() => {
    if (!hydrated || status !== 'unstarted' || !progress.loaded || !wsId) return;
    if (progress.tourCompleted) {
      setStatus('done');
      saveTourState(wsId, { status: 'done', step: 0 });
    } else {
      setStatus('active');
    }
  }, [hydrated, status, progress.loaded, progress.tourCompleted, wsId]);

  // ── Advance / dismiss ────────────────────────────────────────────────────────
  const goTo = useCallback((n: number) => {
    const clamped = Math.max(0, Math.min(TOUR_STEPS.length - 1, n));
    setStep(clamped);
    persist({ status: 'active', step: clamped });
  }, [persist]);

  const next = useCallback(() => {
    if (step >= TOUR_STEPS.length - 1) {
      setStatus('done');
      persist({ status: 'done', step });
      markTourSeen();
      return;
    }
    goTo(step + 1);
  }, [step, goTo, persist, markTourSeen]);

  const dismiss = useCallback(() => {
    setStatus('dismissed');
    persist({ status: 'dismissed', step });
    markTourSeen();
  }, [step, persist, markTourSeen]);

  // Secondary action on the finish card: take them somewhere (the verifier lives in
  // Integrations) and end the tour.
  const finishAndGo = useCallback((route: string) => {
    setStatus('done');
    persist({ status: 'done', step });
    markTourSeen();
    navigate(route);
  }, [step, persist, navigate, markTourSeen]);

  // ── Auto-advance on a FRESH checkpoint completion ────────────────────────────
  // Only advance when the user completes the step's action WHILE on the step — not
  // when the checkpoint was already satisfied on entry (e.g. an agent-onboarded
  // workspace that already has integrations/accounts/ICP). Otherwise the tour would
  // sweep through every pre-done step on a timer. A manual Next is always available.
  const [justDone, setJustDone] = useState(false);
  const advancedFor = useRef<string | null>(null);
  const baseline = useRef<{ step: number; met: boolean } | null>(null);
  const cp = current?.checkpoint;
  const cpMet = cp ? !!progress[cp as keyof TourProgress] : false;

  useEffect(() => { setJustDone(false); baseline.current = null; }, [step]);

  // Capture the baseline (was it already done?) on the first loaded status for this step.
  useEffect(() => {
    if (!active || !cp || !progress.loaded) return;
    if (!baseline.current || baseline.current.step !== step) {
      baseline.current = { step, met: cpMet };
    }
  }, [active, cp, progress.loaded, step, cpMet]);

  useEffect(() => {
    if (!active || !current || !cp || !cpMet) return;
    // Don't auto-advance a step that was already complete before the user got here.
    if (!baseline.current || baseline.current.step !== step || baseline.current.met) return;
    if (advancedFor.current === current.id) return;
    advancedFor.current = current.id;
    setJustDone(true);
    const t = setTimeout(() => next(), 1300);
    return () => clearTimeout(t);
  }, [active, current, cp, cpMet, step, next]);

  // ── Drive navigation on step entry ───────────────────────────────────────────
  const navigatedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !current?.route) return;
    if (navigatedFor.current === current.id) return;
    navigatedFor.current = current.id;
    const wantPath = anchorRoutePath(current.route);
    if (wantPath && location.pathname !== wantPath) navigate(current.route);
  }, [active, current, navigate, location.pathname]);

  // ── Track the anchored element's position ────────────────────────────────────
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!active || current?.placement !== 'anchor' || !current.anchor) { setRect(null); return; }
    const sel = `[data-tour="${current.anchor}"]`;
    let raf = 0;
    let firstFound = false;
    const read = () => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) {
        const r = el.getBoundingClientRect();
        setRect(prev => (prev && prev.top === r.top && prev.left === r.left && prev.width === r.width ? prev : r));
        if (!firstFound) { firstFound = true; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      } else {
        setRect(null);
      }
    };
    read();
    const iv = setInterval(read, 250);
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(read); };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      clearInterval(iv);
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [active, current, location.pathname]);

  const stepNumber = useMemo(() => {
    // Human "1 of 3" over the three real steps, ignoring the two bookends.
    const gated = TOUR_STEPS.filter(s => s.checkpoint);
    const idx = gated.findIndex(s => s.id === current?.id);
    return idx >= 0 ? { n: idx + 1, total: gated.length } : null;
  }, [current]);

  if (!active || !current) return null;

  const name = firstName(session, email);
  const isCenter = current.placement === 'center';
  const anchorMissing = current.placement === 'anchor' && !rect;

  // The integration step wants at least REQUIRED_SOURCES sources before it lets you
  // move on — one connection leaves import with nothing to match against. Show the
  // X/3 progress and hold Next until it's met. Skip tour is always available.
  const sourceGate = current.id === 'integration'
    ? { have: Math.min(progress.sourceCount, REQUIRED_SOURCES), need: REQUIRED_SOURCES, blocked: progress.sourceCount < REQUIRED_SOURCES }
    : null;

  // Position the coach card relative to the spotlight.
  let cardStyle: React.CSSProperties = {};
  if (rect) {
    const below = rect.bottom + 14;
    const roomBelow = window.innerHeight - rect.bottom > 260;
    const top = roomBelow ? below : Math.max(16, rect.top - 260);
    let left = rect.left;
    left = Math.min(left, window.innerWidth - CARD_W - 16);
    left = Math.max(16, left);
    cardStyle = { position: 'fixed', top, left, width: CARD_W };
  }

  const card = (
    <motion.div
      key={current.id}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="pointer-events-auto rounded-2xl border border-border bg-background shadow-2xl p-5"
      style={isCenter || anchorMissing ? { width: CARD_W } : cardStyle}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <img src="/nous-logo.svg" alt="" className="h-4 w-4 object-contain" />
          {stepNumber && (
            <span className="text-[11px] font-medium text-muted-foreground/70 tabular-nums">
              Step {stepNumber.n} of {stepNumber.total}
            </span>
          )}
        </div>
        <button
          onClick={dismiss}
          className="text-muted-foreground/50 hover:text-foreground transition-colors -mt-1 -mr-1 p-1"
          aria-label="Skip the tour"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <h2 className="mt-3 text-[17px] font-semibold tracking-tight text-foreground">
        {current.id === 'welcome' && name ? `Welcome to Nous, ${name}`
          : current.id === 'billing' && name ? `Congrats, ${name}`
          : current.title}
      </h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{current.body}</p>

      {sourceGate && (
        <div className="mt-3 flex items-center gap-2">
          <div className="flex items-center gap-1">
            {Array.from({ length: sourceGate.need }).map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-6 rounded-full transition-colors ${i < sourceGate.have ? 'bg-emerald-500' : 'bg-border'}`}
              />
            ))}
          </div>
          <span className="text-[11.5px] font-medium tabular-nums text-muted-foreground">
            {sourceGate.have}/{sourceGate.need} connected
          </span>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <button
          onClick={dismiss}
          className="text-[12px] text-muted-foreground/60 hover:text-foreground transition-colors"
        >
          Skip tour
        </button>

        <div className="flex items-center gap-2">
          {anchorMissing && current.route && (
            <button
              onClick={() => { navigatedFor.current = null; navigate(current.route!); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12.5px] font-medium text-foreground hover:bg-muted/50 transition-colors"
            >
              Take me there
            </button>
          )}

          {current.secondaryCta && current.secondaryRoute && (
            <button
              onClick={() => finishAndGo(current.secondaryRoute!)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12.5px] font-medium text-foreground hover:bg-muted/50 transition-colors"
            >
              {current.secondaryCta}
            </button>
          )}

          {justDone ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-[12.5px] font-semibold text-emerald-600">
              <Check className="h-3.5 w-3.5" /> Done
            </span>
          ) : (
            // Manual Next — the user moves at their own pace. The integration step is the
            // one exception: it holds Next until at least REQUIRED_SOURCES are connected, so
            // nobody lands on "import your accounts" with an empty graph. Skip tour still
            // escapes. Gated steps also auto-advance on a fresh completion (effect above).
            <button
              onClick={next}
              disabled={!!sourceGate?.blocked}
              title={sourceGate?.blocked ? `Connect ${sourceGate.need - sourceGate.have} more to continue` : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3.5 py-2 text-[12.5px] font-semibold text-background hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:opacity-40"
            >
              {current.cta ?? 'Next'} <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );

  return createPortal(
    // z-40: above the page, but BELOW radix dialogs (z-50). So when the user clicks the
    // spotlit button and its connect dialog opens, the dialog sits cleanly on top instead
    // of being dimmed by our spotlight. By the time it closes the checkpoint has usually
    // flipped and the tour has moved on.
    <div className="fixed inset-0 z-40" style={{ pointerEvents: 'none' }}>
      {/* Backdrop. Centered cards dim the whole screen; anchored steps punch a hole with a
          huge box-shadow so the target button stays lit and clickable. */}
      {isCenter || anchorMissing ? (
        <div className="absolute inset-0 bg-black/50" style={{ pointerEvents: 'auto' }} />
      ) : rect ? (
        <div
          className="absolute rounded-xl"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)',
            outline: '2px solid rgba(224,145,43,0.9)',
            outlineOffset: '2px',
            pointerEvents: 'none',
          }}
        >
          <span className="absolute inset-0 rounded-xl ring-2 ring-[#E0912B]/60 animate-ping" />
        </div>
      ) : null}

      <AnimatePresence mode="wait">
        {isCenter || anchorMissing ? (
          <div className="absolute inset-0 flex items-center justify-center px-4" style={{ pointerEvents: 'none' }}>
            {card}
          </div>
        ) : (
          card
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
