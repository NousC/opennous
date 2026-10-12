import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { BOX_SHADOW } from "@/lib/authTheme";

// The card the Supabase sign-in / sign-up forms sit in (self-host auth), in the OpenNous brand:
// Geist, warm off-white, hairline borders, ink type, Signal Orange only for focus and hover.
// The mark and wordmark sit above the card, the card holds the heading and the form, and
// `footer` is one quiet line under it (what happens next, or the way to the other form).
export function AuthCard({ heading, sub, footer, children }: {
  /** No longer drawn (the card dropped its title bar); kept so callers need not change. */
  title?: string;
  heading: string;
  sub?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative z-10 w-full max-w-[400px] font-sans">
      <div className="mb-7 flex items-center justify-center gap-2">
        <img src="/nous-logo.svg" alt="" className="h-6 w-6 object-contain" />
        <span className="text-[17px] font-semibold tracking-[-0.02em] text-[#1C1A17]">OpenNous</span>
      </div>
      <div className="rounded-2xl border border-[#E9E6DC] bg-white px-6 pb-7 pt-6 sm:px-8 sm:pb-8 sm:pt-7" style={BOX_SHADOW}>
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-[#1C1A17]">{heading}</h1>
        {sub && <p className="mt-1.5 text-[13.5px] leading-relaxed text-[#787369]">{sub}</p>}
        {children}
      </div>
      {footer && <div className="mt-6 text-center text-[13px] leading-relaxed text-[#787369]">{footer}</div>}
    </div>
  );
}

/** A labelled field: the label stays visible while typing, the hint sits under the input. */
export function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-[#4A463F]">{label}</label>
      {children}
      {hint && <p className="text-[12px] text-[#A49D90]">{hint}</p>}
    </div>
  );
}

export const inputCls =
  "h-10 rounded-lg border-[#E9E6DC] bg-white px-3 text-[14px] text-[#1C1A17] shadow-none placeholder:text-[#A49D90] " +
  "focus-visible:border-[#E85B3D] focus-visible:ring-2 focus-visible:ring-[#F7E2DA] focus-visible:ring-offset-0";

export const submitCls =
  "mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#1C1A17] px-4 text-[14px] font-medium text-white " +
  "shadow-none transition-colors hover:bg-[#2E2B26] focus-visible:ring-2 focus-visible:ring-[#F7E2DA] disabled:opacity-60";

export const linkCls = "font-medium text-[#1C1A17] underline-offset-4 hover:text-[#E85B3D] hover:underline";

export function SubmitArrow() {
  return <ArrowRight className="h-4 w-4" aria-hidden="true" />;
}
