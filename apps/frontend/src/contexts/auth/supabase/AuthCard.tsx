import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";

// The self-host sign-in / sign-up forms' heading and footer (Supabase Auth). The page draws the
// frame, in the website v2 design (components/auth/AuthLayout.tsx, GET-958): the card on sign-in,
// the left column on sign-up. This draws what sits inside it: the heading in the website's light
// Host Grotesk, the form, and `footer`, one quiet line under it (what happens next, or the way to
// the other form).
export function AuthCard({ heading, sub, footer, children }: {
  /** No longer drawn (the card dropped its title bar); kept so callers need not change. */
  title?: string;
  heading: string;
  sub?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative z-10 w-full">
      <h1 className="m-0 text-[30px] font-light leading-[1.1] tracking-[-0.03em] text-[#0E1116]">{heading}</h1>
      {sub && <p className="mt-2 text-[15px] leading-normal text-[#6E7480]">{sub}</p>}
      {children}
      {footer && <div className="mt-6 border-t border-[rgba(14,17,22,0.06)] pt-[18px] text-center text-[15px] text-[#6E7480]">{footer}</div>}
    </div>
  );
}

/** A labelled field: the label stays visible while typing, the hint sits under the input. */
export function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13.5px] font-normal text-[#2B303A]">{label}</label>
      {children}
      {hint && <p className="text-[12px] text-[#9AA0AA]">{hint}</p>}
    </div>
  );
}

// The website's fields and buttons (canvas Sign in / Sign up boards).
export const inputCls =
  "h-11 rounded-md border-0 bg-white px-3.5 text-[15px] font-normal text-[#0E1116] shadow-[inset_0_0_0_1px_rgba(14,17,22,0.12)] placeholder:font-light placeholder:text-[#9AA0AA] " +
  "focus-visible:shadow-[inset_0_0_0_1px_#C2410C,0_0_0_3px_rgba(194,65,12,0.14)] focus-visible:ring-0 focus-visible:ring-offset-0";

const submitBase =
  "mt-2 flex h-[46px] w-full items-center justify-center gap-2 rounded-md px-4 text-[16px] font-normal text-white " +
  "transition-transform hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-[rgba(194,65,12,0.3)] disabled:opacity-60 disabled:hover:translate-y-0";

/** Sign in: ink. */
export const submitCls = `${submitBase} bg-[#0E1116] shadow-[0_13px_27px_-12px_rgba(14,17,22,0.5)] hover:bg-[#0E1116]`;
/** Sign up: the accent, as on the website's "Start for free". */
export const submitAccentCls = `${submitBase} bg-[#C2410C] shadow-[0_13px_27px_-12px_rgba(194,65,12,0.45),inset_0_1px_0_rgba(255,255,255,0.16)] hover:bg-[#C2410C]`;

export const linkCls = "font-normal text-[#C2410C] underline-offset-4 hover:underline";

export function SubmitArrow() {
  return <ArrowRight className="h-4 w-4" aria-hidden="true" />;
}
