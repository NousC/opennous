import { useState, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/components/ui/sonner";
import { Eye, EyeOff, Pencil, Copy, Check } from "lucide-react";
import { setRememberMe } from "@/lib/supabase";
import { useAuthConfig } from "@/lib/authConfig";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import GraphField from "@/components/GraphField";
import { PAGE_STYLE, BOX_SHADOW } from "@/lib/authTheme";
import { safeRedirect } from "@/lib/authRedirect";
import { installCommand } from "@/lib/install";

const SignupContent = () => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Email signup stays collapsed behind a single "Email" link until asked for — the page
  // leads with the agent + Google, and the form only appears if you actually want it.
  const [emailOpen, setEmailOpen] = useState(false);
  const [step, setStep] = useState<"signup" | "verify">("signup");
  const [otpCode, setOtpCode] = useState("");
  const [resendCountdown, setResendCountdown] = useState(0);
  // The default assumption is that you have a coding agent — Nous is built to be operated
  // by one, and that's the best way to set up your Vault. So the agent path is the hero:
  // run the one-liner, or paste a prompt into Claude Code / Cursor. Google / email is the
  // manual fallback for people without an agent.
  const [agentMethod, setAgentMethod] = useState<"terminal" | "agent">("terminal");
  const [copied, setCopied] = useState(false);
  const { signUp, signInWithGoogle, verifyOtp } = useAuth();
  const { signupsDisabled, googleEnabled } = useAuthConfig();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // One command. It installs the CLI, signs you in (creating your account), registers the
  // MCP with your agent, and hands off — the agent does the real setup, Vault and all.
  // Instance-aware: on self-host this points at the operator's own server, not our cloud.
  const TERMINAL_CMD = installCommand();
  // For people who'd rather let their agent drive: paste this into Claude Code / Cursor.
  const AGENT_PROMPT =
    "Set up Nous in this project. Run `npx @opennous/cli init` to install the CLI and connect it, then find my ICP (context/icp.md, or an ICP section in CLAUDE.md) and sync it to Nous — or, if there isn't one, ask for my website, draft an ICP, write it to ./context/icp.md, and sync that.";
  const copyAgent = () => {
    const text = agentMethod === "terminal" ? TERMINAL_CMD : AGENT_PROMPT;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {});
  };

  // The CLI flow sends new users here with ?redirect=/cli-login?code=… so the terminal
  // can finish after they create an account. With no such param, land on "/" — the
  // first-run gate (ConnectGate) takes it from there. See lib/authRedirect.
  const redirectParam = safeRedirect(searchParams.get("redirect"));
  const hasRedirect = redirectParam !== "/";
  const afterAuth = redirectParam;
  // Reached from the CLI device-login (`npx @opennous/cli init` → /cli-login → "Create
  // account"). These users ALREADY ran the terminal command, so leading with the
  // "Run in terminal" hero tells them to do the thing they just did — and sends them
  // right back to this page in a loop. In this flow, lead with the account form instead.
  const fromCli = redirectParam.startsWith("/cli-login");

  // Self-host: if registration is closed, there is no signup — send to login.
  useEffect(() => {
    if (signupsDisabled) navigate("/login", { replace: true });
  }, [signupsDisabled, navigate]);

  // Capture affiliate referral code from URL and persist in localStorage
  useEffect(() => {
    const ref = searchParams.get("ref") || searchParams.get("affiliate");
    if (ref) {
      localStorage.setItem("nous_affiliate_ref", ref.toUpperCase());
    }
  }, [searchParams]);

  // Resend countdown timer
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setTimeout(() => setResendCountdown(resendCountdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCountdown]);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    setRememberMe(true);

    const { error, data } = await signUp(email, password, name.trim() || undefined, true);

    if (error) {
      toast.error(error.message || "Failed to sign up");
      setLoading(false);
    } else {
      if (data?.session) {
        navigate(afterAuth, { replace: true });
        return;
      }
      setStep("verify");
      setResendCountdown(30);
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otpCode.length !== 8) return;
    setLoading(true);

    const { error } = await verifyOtp(email, otpCode);

    if (error) {
      toast.error(error.message || "Invalid verification code. Please try again.");
      setOtpCode("");
      setLoading(false);
    } else {
      toast.success("Email verified! Let's get you connected.");
      navigate(afterAuth, { replace: true });
    }
  };

  const handleResendCode = async () => {
    if (resendCountdown > 0) return;

    const { error } = await signUp(email, password, undefined, true);
    if (error) {
      toast.error("Failed to resend code. Please try again.");
    } else {
      toast.success("New verification code sent!");
      setResendCountdown(30);
      setOtpCode("");
    }
  };

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setRememberMe(true);

    const ref = searchParams.get("ref") || searchParams.get("affiliate");
    if (ref) {
      localStorage.setItem("nous_affiliate_ref", ref.toUpperCase());
    }

    // Carry the return-to through Google so a CLI signup lands back on /cli-login. With no
    // redirect param, pass undefined and keep Google's existing default landing.
    const { error } = await signInWithGoogle(hasRedirect ? redirectParam : undefined);

    if (error) {
      toast.error(error.message || "Failed to sign up with Google");
      setLoading(false);
    }
  };

  // ─── OTP Verification Screen ───
  if (step === "verify") {
    return (
      <div
        className="relative overflow-hidden min-h-screen flex items-center justify-center px-4 font-geist-mono text-[#1A1712]"
        style={PAGE_STYLE}
      >
        <GraphField />
        <div
          className="relative z-10 w-full max-w-[360px] overflow-hidden rounded-lg border border-[#E4DED1] bg-[#FBFAF5]"
          style={BOX_SHADOW}
        >
          {/* title bar */}
          <div className="flex items-center gap-2 border-b border-[#E4DED1] px-4 py-2 text-xs text-[#6B655B]">
            <span className="text-[#96601f]/80">●</span>
            <span className="text-[#E0912B]/80">●</span>
            <span className="text-[#96601f]/60">●</span>
            <span className="ml-1">nous — verify</span>
          </div>

          <div className="p-6 text-center">
            <h1 className="font-fraunces text-[26px] font-semibold tracking-[-0.02em] text-[#1A1712]">
              Check your email
            </h1>
            <p className="mt-1 text-xs text-[#6B655B]">
              We sent a verification code to
            </p>
            <div className="flex items-center justify-center gap-1.5 mt-1.5">
              <span className="text-[13px] text-[#1A1712]">{email}</span>
              <button
                onClick={() => {
                  setStep("signup");
                  setOtpCode("");
                }}
                className="text-[#6B655B] hover:text-[#96601f]"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex justify-center mt-6 mb-5">
              <InputOTP
                maxLength={8}
                value={otpCode}
                onChange={(value) => setOtpCode(value)}
                disabled={loading}
              >
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                    <InputOTPSlot
                      key={i}
                      index={i}
                      className="w-9 h-11 text-base border-[#E4DED1] bg-[#FBFAF5] text-[#1A1712] rounded-md first:rounded-l-md last:rounded-r-md"
                    />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>

            <p className="text-xs text-[#6B655B] mb-5">
              Didn&apos;t receive a code?{" "}
              {resendCountdown > 0 ? (
                <span className="text-[#6B655B]">Resend ({resendCountdown})</span>
              ) : (
                <button
                  onClick={handleResendCode}
                  className="font-medium text-[#1A1712] hover:text-[#96601f]"
                >
                  Resend
                </button>
              )}
            </p>

            <Button
              onClick={handleVerifyOtp}
              className="w-full h-12 rounded-lg pl-5 pr-1.5 flex items-center justify-between gap-2 font-medium text-sm bg-[#E0912B] hover:brightness-105 text-[#1a1000] transition-transform hover:scale-[1.005] disabled:opacity-60 disabled:hover:scale-100"
              disabled={loading || otpCode.length !== 8}
            >
              <span>{loading ? "Verifying..." : "Continue"}</span>
              <span
                className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-[#1a1000] text-[#E0912B]"
                aria-hidden="true"
              >
                →
              </span>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Signup Form Screen ───
  return (
    <div
      className="relative overflow-hidden min-h-screen flex items-center justify-center px-4 font-geist-mono text-[#1A1712]"
      style={PAGE_STYLE}
    >
      <GraphField />
      <div
        className="relative z-10 w-full max-w-[440px] overflow-hidden rounded-lg border border-[#E4DED1] bg-[#FBFAF5]"
        style={BOX_SHADOW}
      >
        {/* title bar */}
        <div className="flex items-center gap-2 border-b border-[#E4DED1] px-4 py-2 text-xs text-[#6B655B]">
          <span className="text-[#96601f]/80">●</span>
          <span className="text-[#E0912B]/80">●</span>
          <span className="text-[#96601f]/60">●</span>
          <span className="ml-1">nous — set up</span>
        </div>

        <div className="p-6">
          <div className="flex items-center gap-2">
            <img src="/nous-logo.svg" alt="" className="w-5 h-5 object-contain" />
            <span className="font-fraunces font-semibold text-[16px] tracking-[-0.01em] text-[#1A1712]">nous</span>
          </div>

          <h1 className="mt-4 font-fraunces text-[26px] font-semibold tracking-[-0.02em] text-[#1A1712]">
            {fromCli ? "Create your account" : "Set up Nous"}
          </h1>
          {fromCli && (
            <p className="mt-1.5 text-xs text-[#6B655B] leading-relaxed">
              You already ran the CLI. Create your account and we&apos;ll take you straight
              back to the terminal to finish connecting.
            </p>
          )}

          {/* Agent-first hero — HIDDEN in the CLI flow. The user arrived here by running the
              terminal command, so leading with "run the terminal command" loops them back to
              this page forever. Show the account form instead. */}
          {!fromCli && (
          <>
          {/* ── Agent-first: the hero. Run the one-liner, or paste a prompt to your agent. ── */}
          <div className="mt-5 rounded-xl border border-[#E7E1D4] bg-[#F7F3EA] p-4">
            <div className="flex items-center gap-2 text-[12px] font-semibold tracking-[-0.01em] text-[#1A1712]">
              <span className="font-geist-mono text-[#B87413]">&gt;_</span>
              Connect your coding agent
            </div>

            {/* toggle: terminal command vs a prompt to paste into the agent */}
            <div className="mt-3 flex items-center gap-4 text-[11.5px]">
              {(["terminal", "agent"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAgentMethod(m)}
                  className={`pb-0.5 transition-colors ${agentMethod === m
                    ? "text-[#1A1712] font-medium border-b border-[#1A1712]"
                    : "text-[#8A8478] hover:text-[#1A1712]"}`}
                >
                  {m === "terminal" ? "Run in terminal" : "Paste to your agent"}
                </button>
              ))}
            </div>

            {/* command box — copy button reveals on hover only */}
            <div className="group/cmd relative mt-2.5 rounded-lg border border-[#E7E1D4] bg-[#FCFBF7] px-3 py-2.5">
              <code className="block pr-7 text-[11.5px] leading-relaxed text-[#2A251E] font-geist-mono whitespace-pre-wrap break-words">
                {agentMethod === "terminal" ? TERMINAL_CMD : AGENT_PROMPT}
              </code>
              <button
                type="button"
                onClick={copyAgent}
                title="Copy"
                className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md text-[#8A8478] opacity-0 group-hover/cmd:opacity-100 hover:bg-[#EFEBE2] hover:text-[#1A1712] transition-all"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          <div className="relative py-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[#E7E1D4]" />
            </div>
            <div className="relative flex justify-center">
              <span className="px-3 text-[10px] uppercase tracking-[0.14em] text-[#8A8478] bg-[#FBFAF5]">
                or set it up here
              </span>
            </div>
          </div>
          </>
          )}

          <div className={`space-y-3 ${fromCli ? "mt-6" : ""}`}>
            {googleEnabled && (
              <Button
                type="button"
                onClick={handleGoogleSignIn}
                variant="outline"
                className="w-full h-11 rounded-lg flex items-center justify-center gap-2.5 font-medium text-sm border-[#E4DED1] bg-[#FBFAF5] hover:bg-[#EFEBE2] text-[#1A1712]"
                disabled={loading}
              >
                <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                Continue with Google
              </Button>
            )}

            {/* Email stays a quiet link until asked for. Click it, the form appears. */}
            {!emailOpen ? (
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => setEmailOpen(true)}
                  className="text-[12.5px] text-[#6B655B] underline underline-offset-4 decoration-[#C9C1B0] hover:text-[#1A1712] hover:decoration-[#1A1712] transition-colors"
                >
                  Email
                </button>
              </div>
            ) : (
              <form onSubmit={handleSignup} className="space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                <Input
                  type="text"
                  placeholder="Full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-11 rounded-lg text-sm border-[#E4DED1] bg-[#FBFAF5] text-[#1A1712] placeholder:text-[#6B655B] focus-visible:ring-[#96601f] focus-visible:border-[#96601f]"
                  disabled={loading}
                  autoFocus
                />
                <Input
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="h-11 rounded-lg text-sm border-[#E4DED1] bg-[#FBFAF5] text-[#1A1712] placeholder:text-[#6B655B] focus-visible:ring-[#96601f] focus-visible:border-[#96601f]"
                  disabled={loading}
                />
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    placeholder="Password (min 6 characters)"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    className="h-11 rounded-lg text-sm border-[#E4DED1] bg-[#FBFAF5] text-[#1A1712] placeholder:text-[#6B655B] pr-10 focus-visible:ring-[#96601f] focus-visible:border-[#96601f]"
                    disabled={loading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B655B] hover:text-[#96601f]"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                <Button
                  type="submit"
                  className="w-full h-12 rounded-lg pl-5 pr-1.5 flex items-center justify-between gap-2 font-medium text-sm bg-[#E0912B] hover:brightness-105 text-[#1a1000] transition-transform hover:scale-[1.005] disabled:opacity-60 disabled:hover:scale-100"
                  disabled={loading}
                >
                  <span>{loading ? "Creating account..." : "Continue"}</span>
                  <span
                    className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-[#1a1000] text-[#E0912B]"
                    aria-hidden="true"
                  >
                    →
                  </span>
                </Button>
              </form>
            )}
          </div>

          <p className="text-[11px] text-center mt-5 text-[#6B655B] leading-relaxed">
            By continuing, you agree to our{" "}
            <Link to="/terms" className="text-[#6B655B] hover:text-[#96601f]">
              Terms
            </Link>{" "}
            and{" "}
            <Link to="/privacy" className="text-[#6B655B] hover:text-[#96601f]">
              Privacy Policy
            </Link>
          </p>

          <div className="text-center text-xs mt-5">
            <span className="text-[#6B655B]">Already have an account? </span>
            <Link to={`/login${hasRedirect ? `?redirect=${encodeURIComponent(redirectParam)}` : ""}`} className="font-semibold text-[#1A1712] hover:text-[#96601f] transition-colors">
              Sign in →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

const Signup = () => <SignupContent />;

export default Signup;
