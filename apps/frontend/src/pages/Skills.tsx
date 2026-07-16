// Skills — the procedures the agent knows.
//
// Presented the way the public Skill Library presents them: the blueprint art on
// top, the department chip, the handle, what it does, what it runs on. Same
// visual language, because it is the same object — a skill you read on the
// website is the skill running in here.
//
// The one thing the store can't do and this must: you can OPEN it. On the public
// page you can only install; you never see the prompt you're installing. Here a
// click gives you the procedure verbatim — the exact text the model is handed —
// because an agent that acts on your accounts shouldn't be a black box.
import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { Sparkles, Check } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader } from "@/components/ui/page-header";
import { Sheet, SheetContent } from "@/components/ui/sheet";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type Skill = {
  id: string;
  name: string;
  /** What a person reads. */
  summary: string;
  /** What the model reads to decide whether the skill applies — longer, and precise. */
  description: string;
  body: string;
  category: string | null;
  requires_providers: string[];
  missing_providers: string[];
  est_cost_usd: number | null;
  is_builtin: boolean;
  ready: boolean;
};

// The blueprint art, by convention: /skill-art/<name>.svg. A skill with no art
// still renders — it just gets the empty plate rather than a broken image.
function SkillArt({ name }: { name: string }) {
  const [missing, setMissing] = useState(false);
  return (
    <div
      className="relative border-b border-border/60 aspect-[420/260] flex items-center justify-center"
      style={{ background: "radial-gradient(120% 100% at 50% 34%, #FEFBF3 0%, #F1EBDE 76%)" }}
    >
      {missing ? (
        <Sparkles className="h-6 w-6 text-[#c9ad82]" strokeWidth={1.5} />
      ) : (
        <img
          src={`/skill-art/${name}.svg`}
          alt=""
          className="w-full h-full object-contain"
          onError={() => setMissing(true)}
        />
      )}
    </div>
  );
}

/** The mark of each system a skill runs on. */
function ProviderMark({ name }: { name: string }) {
  const [src, setSrc] = useState<string | null>(`/provider-logos/${name.toLowerCase()}.svg`);
  if (!src) return null;
  return (
    <img
      src={src} alt={name} title={name}
      className="h-[17px] w-[17px] object-contain"
      onError={() => setSrc(src.endsWith(".svg") ? src.replace(".svg", ".png") : null)}
    />
  );
}

function SkillCard({ skill, onOpen }: { skill: Skill; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="group flex flex-col text-left rounded-xl border border-border bg-background overflow-hidden
                 transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20
                 hover:shadow-[0_20px_50px_-40px_rgba(70,58,34,.5)]"
    >
      <div className="relative">
        <SkillArt name={skill.name} />
        {skill.category && (
          <span className="absolute top-2 left-2 font-mono text-[9px] tracking-wide
                           text-[#7a4e12] bg-[#FCF3E4] border border-[#e9c690] rounded px-1.5 py-0.5">
            {skill.category}
          </span>
        )}
      </div>

      <div className="flex flex-col flex-1 px-3.5 pt-3 pb-3.5">
        <h3 className="font-mono text-[13px] text-foreground mb-1">/{skill.name}</h3>
        {/* The short line, for a human. The model's trigger line is longer and
            more precise, and lives on the skill's own panel. */}
        <p className="text-[12px] leading-snug text-muted-foreground flex-1 line-clamp-2">
          {skill.summary}
        </p>

        <div className="flex items-center gap-1.5 pt-3 mt-3 border-t border-border/60">
          {skill.requires_providers.map(p => <ProviderMark key={p} name={p} />)}
          {skill.est_cost_usd ? (
            <span className="font-mono text-[10.5px] text-muted-foreground/60 tabular-nums">
              ~${Number(skill.est_cost_usd).toFixed(2)}
            </span>
          ) : null}
          <span className="ml-auto font-mono text-[10.5px] text-muted-foreground/60 group-hover:text-foreground transition-colors">
            read →
          </span>
        </div>
      </div>
    </button>
  );
}

/** The skill, open: the art on top, then the procedure the model actually gets. */
function SkillSheet({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  return (
    <Sheet open={!!skill} onOpenChange={o => !o && onClose()}>
      <SheetContent side="right" className="sm:max-w-2xl w-full overflow-y-auto p-0">
        {skill && (
          <>
            <div className="relative">
              <SkillArt name={skill.name} />
              {skill.category && (
                <span className="absolute top-3 left-3 font-mono text-[10px] tracking-wide
                                 text-[#7a4e12] bg-[#FCF3E4] border border-[#e9c690] rounded-md px-2 py-1">
                  {skill.category}
                </span>
              )}
            </div>

            <div className="px-6 py-5 border-b border-border/60">
              <h2 className="font-mono text-[15px] text-foreground">/{skill.name}</h2>
              <p className="text-[12.5px] leading-relaxed text-muted-foreground mt-2">
                {skill.summary}
              </p>

              {/* The trigger line — the sentence the agent reads to decide whether
                  this skill applies. Shown because "why did it do that?" is the
                  question you'll actually have. */}
              {skill.description !== skill.summary && (
                <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                  <p className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/60 mb-1">
                    When the agent reaches for it
                  </p>
                  <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                    {skill.description}
                  </p>
                </div>
              )}

              <div className="flex items-center gap-3 mt-4">
                {skill.requires_providers.map(p => <ProviderMark key={p} name={p} />)}
                {skill.requires_providers.length === 0 ? null : skill.ready ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Check className="h-3 w-3" /> Connected
                  </span>
                ) : (
                  // The honest bit: the agent will hit this wall mid-procedure
                  // unless you fix it here first.
                  <Link
                    to="/integrations"
                    className="text-[11px] text-foreground underline underline-offset-2 decoration-border hover:decoration-foreground"
                  >
                    Connect {skill.missing_providers.join(" and ")} to run this
                  </Link>
                )}
                {skill.est_cost_usd ? (
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground/60 tabular-nums">
                    ~${Number(skill.est_cost_usd).toFixed(2)} a run
                  </span>
                ) : null}
              </div>
            </div>

            {/* The prompt itself. This is the whole point of the page. */}
            <div className="px-6 py-5">
              <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-4">
                The procedure your agent follows
              </p>
              <div className="prose prose-sm dark:prose-invert max-w-none
                              prose-headings:text-[13px] prose-headings:font-semibold
                              prose-p:text-[12.5px] prose-p:text-muted-foreground prose-p:leading-relaxed
                              prose-li:text-[12.5px] prose-li:text-muted-foreground
                              prose-code:text-[11px] prose-strong:text-foreground
                              prose-blockquote:text-[12.5px] prose-blockquote:text-muted-foreground">
                <ReactMarkdown>{skill.body}</ReactMarkdown>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function Skills() {
  const { session, userData } = useAuth();
  const token = session?.access_token;
  const workspaceId = userData?.workspace?.id ?? "";

  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [open, setOpen] = useState<Skill | null>(null);

  const load = useCallback(async () => {
    if (!token || !workspaceId) return;
    try {
      const res = await fetch(
        `${apiUrl}/api/skills?workspaceId=${encodeURIComponent(workspaceId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setSkills(data.skills ?? []);
    } catch {
      setSkills([]);
    }
  }, [token, workspaceId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="px-8 py-7">
        <PageHeader title="Skills" />

        {skills === null ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="rounded-xl border border-border overflow-hidden">
                <div className="aspect-[420/260] bg-muted/50 animate-pulse" />
                <div className="h-28 bg-muted/20" />
              </div>
            ))}
          </div>
        ) : skills.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-12 text-center">
            <Sparkles className="h-7 w-7 text-muted-foreground/50 mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-[13px] font-medium text-foreground/80 mb-1">No skills yet</p>
            <p className="text-[12px] text-muted-foreground/70">
              Your agent answers from the record, but has no worked-out procedures to follow.
            </p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
            {skills.map(s => (
              <SkillCard key={s.id} skill={s} onOpen={() => setOpen(s)} />
            ))}
          </div>
        )}
      </div>

      <SkillSheet skill={open} onClose={() => setOpen(null)} />
    </div>
  );
}
