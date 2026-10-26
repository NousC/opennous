import { memo } from "react";
import ReactMarkdown from "react-markdown";
// Tables are not CommonMark. Without gfm a skill that answers with a table — which is
// most of them: stage mix, tiered leads, a committee — renders as literal | pipes |.
import remarkGfm from "remark-gfm";

// The shared agent-answer renderer — the SAME markdown styling the main Chat page uses,
// so the floating dock reads identically. Optional `onCite` turns [1] footnote markers
// into clickable citation chips (the Chat page passes it to open its sources panel); the
// dock omits it, and the markers render as plain superscript brackets.
// A marker is a TOKEN the agent copied from its tool result — `[ct7k2]` — not a number it
// chose. `citeIndex` maps it to the row the panel will draw, which is what makes the number
// the reader sees and the row it opens the same thing. A token with no row is left as plain
// text rather than rendered as a chip that opens nothing.
const linkifyCitations = (text: string, citeIndex?: (token: string) => number | undefined) =>
  text.replace(/\[(c[a-z0-9]{4})\](?!\()/g, (m, token) => {
    const n = citeIndex?.(token);
    return n ? `[${n}](#cite-${n})` : "";
  });

// ── The vertical rhythm ──────────────────────────────────────────────────────
//
// ONE gap between blocks, set once. This used to be five different values — p:my-2.5,
// ol:my-2, li:my-1, headings:mt-4/mb-2, table:my-3 — so the space between two things
// depended on which two things they happened to be, and a paragraph followed by a list
// sat differently from a paragraph followed by a paragraph. That reads as sloppy even
// when nobody can say why.
//
// `[&>*+*]` is every adjacent pair of top-level blocks, so the rhythm holds no matter what
// the agent writes. The only deliberate exception is a heading, which gets more room ABOVE
// it — a heading opens a section, and the extra space is what makes it read as one. That is
// hierarchy, not inconsistency.
// ONE class, defined as plain CSS at the foot of index.css.
//
// This was a stack of Tailwind arbitrary variants — `[&>*+ul]:mt-1.5`, `[&>ul+*]:mt-5` and
// six more. They generate real rules (verified in the deployed stylesheet, correct values,
// correct cascade position), and the rendering still disagreed with them: more air above a
// list than below it, the exact inverse of what the file said. Chasing that through escaping,
// generated order and plugin specificity cost an evening.
//
// So the rhythm is written out, in order, in one place a person can read top to bottom and a
// browser resolves without a build step in between. `.agent-prose` sits at the end of the
// stylesheet, so it wins every tie against the typography plugin by source order.
const RHYTHM = 'agent-prose';

// A real scale, so `##` and `###` are visibly different.
//
// They were all 15px once, which made every level the same heading. The fix after that left
// h3 at 14px against 14px BODY and h2 at 15.5px — technically a scale, visually none. A
// heading was bold text with a little extra space, and the comment here said so outright:
// "they lean on weight and colour instead."
//
// That was a fair trade while the agent rarely used headings. It stopped being one the moment
// we told it to open sections with a claim rather than a label, because the structure it
// writes is now the structure the reader is meant to see. 17px against 14px body is the first
// step that registers as a LEVEL rather than as emphasis.
//
// The ceiling is the document dock: a report's section heading is 18px, so these stay below it
// and the agent can never out-shout the section it is writing inside.
const HEADINGS = [
  'prose-headings:font-semibold prose-headings:text-foreground prose-headings:tracking-[-0.015em]',
  'prose-h1:text-[17.5px] prose-h2:text-[17px] prose-h3:text-[15px] prose-h4:text-[13.5px]',
  'prose-h1:leading-snug prose-h2:leading-snug prose-h3:leading-snug',
  // h4 is where the scale stops and a label begins.
  'prose-h4:text-muted-foreground prose-h4:font-medium',
].join(' ');

export const Prose = memo(({ text, onCite, citeTitle, citeIndex, doc = false, chat = false }: {
  text: string;
  onCite?: (n: number) => void;
  /** The nth source's name, for the marker's tooltip. */
  citeTitle?: (n: number) => string | undefined;
  /** A cite token → the row number the panel will draw for it. */
  citeIndex?: (token: string) => number | undefined;
  doc?: boolean;
  /** The main chat's answer: a touch looser (1.65) than the dock's 1.5. */
  chat?: boolean;
}) => (
  <div className={`prose prose-sm dark:prose-invert max-w-none text-foreground text-[14px] ${
    // A document reads looser than a chat message — the difference between something you
    // scan and something you sit with. 1.6 in chat was 1.625 (leading-relaxed), which on
    // 14px is 22.75px and read as airy next to the tighter blocks around it.
    doc ? 'leading-[1.6]' : chat ? 'leading-[1.65]' : 'leading-[1.5]'
  } ${RHYTHM} ${HEADINGS}
                  prose-strong:font-semibold prose-strong:text-foreground
                  prose-ol:pl-5 prose-ul:pl-5
                  prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[12.5px]
                  prose-code:before:content-[''] prose-code:after:content-['']
                  prose-pre:bg-muted prose-pre:text-foreground prose-pre:text-[12.5px]
                  prose-a:text-foreground prose-a:underline prose-a:underline-offset-2
                  prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:pl-3
                  prose-blockquote:not-italic prose-blockquote:text-muted-foreground prose-blockquote:font-normal
                  prose-hr:border-border/60
                  prose-table:text-[13px] prose-table:w-full
                  prose-thead:border-b prose-thead:border-border
                  prose-th:text-left prose-th:font-semibold prose-th:text-foreground prose-th:py-1.5 prose-th:pr-4
                  prose-td:py-1.5 prose-td:pr-4 prose-td:align-top prose-td:border-b prose-td:border-border/40
                  ${/* The row rules separate rows. The LAST one separates the table from the
                       sentence after it, which is not its job — it left the table ending on a
                       drawn line with prose sitting under it, reading as one more row. */ ''}
                  [&_tr:last-child_td]:border-0`}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // A `---` is never wanted here. An answer is a MESSAGE, and a message does not have
        // sections that need ruling off from each other — the paragraph break already did
        // that. The model reaches for one when it is writing something document-shaped into
        // the chat, which is precisely when the rule should stop it: the divider is the
        // answer pretending to be a report.
        //
        // Dropped rather than forbidden in the prompt, because a prompt rule a model can
        // ignore is not a rule, and this one already exists for briefs and did not hold.
        hr: () => null,
        // A note-taker's logo in a call page's Transcript link (GET-236): an inline icon beside
        // the words, not a full-width picture. Any other image renders as markdown would.
        img({ src, alt }) {
          if (typeof src === "string" && src.startsWith("/provider-logos/")) {
            return <img src={src} alt={alt ?? ""} className="not-prose !my-0 mr-1.5 inline-block h-4 w-4 rounded-[3px] object-contain align-[-3px]" />;
          }
          return <img src={src} alt={alt ?? ""} />;
        },
        ...(onCite || citeIndex ? {
        a({ href, children }) {
          if (href && href.startsWith("#cite-")) {
            const n = parseInt(href.slice(6), 10);
            // NO HANDLER IS NOT NO MARKER. A reading page has no dock to open a source in,
            // so it passes citeIndex without onCite — and this used to render the raw token,
            // putting "[cuo5q]" in the middle of the sentence. The marker still knows its
            // number and the page still lists its sources, so it becomes a link down to the
            // row instead of a button that opens a panel.
            if (!onCite) {
              return (
                <a
                  href={`#doc-source-${n}`}
                  title={citeTitle?.(n) ?? "Where this came from"}
                  className="not-prose inline-flex items-center justify-center align-[2px] ml-0.5 min-w-[15px] h-[15px] px-[3px] rounded-[4px] bg-muted text-ink-2 text-[10px] font-semibold leading-none tabular-nums no-underline hover:bg-foreground hover:text-background transition-colors">
                  {children}
                </a>
              );
            }
            return (
              <button
                type="button"
                onClick={() => onCite(n)}
                // What it points AT, not what a citation is for. "Where this came from"
                // is a label on every marker on the page and tells the reader nothing they
                // did not already know; the name of the call does.
                title={citeTitle?.(n) ?? "Where this came from"}
                className="not-prose inline-flex items-center justify-center align-[2px] ml-0.5 min-w-[15px] h-[15px] px-[3px] rounded-[4px] bg-muted text-ink-2 text-[10px] font-semibold leading-none tabular-nums no-underline hover:bg-foreground hover:text-background transition-colors cursor-pointer">
                {children}
              </button>
            );
          }
          return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
        } : {}),
      }}
    >
      {onCite || citeIndex ? linkifyCitations(text, citeIndex) : text}
    </ReactMarkdown>
  </div>
));
Prose.displayName = "Prose";

// A tool name → what the agent is doing, in words a person would use. Shared with the
// main Chat page so the process steps read the same everywhere.
// A tool name → what the agent is doing, in words a person would use. Shared with the
// main Chat page so the process steps read the same everywhere, and complete on purpose:
// a tool missing from here renders as "Running record_insight", which is the app showing
// the user a function name.
export const TOOL_VERBS: Record<string, string> = {
  // Identity + the record
  whoami: "Checking whose book this is",
  get_icp: "Reading your ICP",
  get_foundation: "Reading your ICP",
  get_context: "Assembling the account context",
  get_account: "Pulling the account record",
  query: "Searching across accounts",
  search: "Searching what people said",
  attention: "Checking what needs attention",
  pipeline: "Reading the pipeline",
  recommendations: "Reading what it recommended before",
  campaign_performance: "Reading outbound campaign performance",
  metrics: "Counting the numbers",
  revenue_report_data: "Computing the revenue report's numbers",
  calendar: "Reading the calendar",
  verify: "Verifying a fact",
  classify: "Checking these leads against our history",
  score: "Scoring against your ICP",
  // Writing back
  record: "Recording what happened",
  record_insight: "Recording what the market told us",
  insights: "Reading what the market told us",
  reporting: "Reading the objections your team is hitting",
  save_note: "Saving this to the record",
  remember_account: "Noting this on the account",
  learn_preference: "Learning how you work",
  watch_account: "Setting a watch",
  run_play: "Starting an autopilot play",
  schedule_automation: "Scheduling a workflow",
  // Drafts the operator approves
  propose_linkedin_message: "Drafting a message for you to approve",
  propose_linkedin_invite: "Drafting a connection request",
  propose_email: "Drafting an email for you to review",
  present_brief: "Writing the brief",
  present_document: "Writing the document",
  present_answer: "Drawing the answer",
  // Skills
  load_skill: "Loading a skill",
  run_skill: "Running a skill",
  read_skill_reference: "Reading the detail behind a skill",
  test_skill_triggers: "Testing when that skill should fire",
  // Setup — first-run only, but they render in the same list
  read_website: "Reading your website",
  set_workspace_profile: "Saving your company profile",
  write_company_overview: "Writing your company overview",
  write_icp: "Writing your ICP",
  build_icp_model: "Building your scoring model",
  train_icp_model: "Training the model on your closed deals",
  fetch_crm_stages: "Reading your CRM's stages",
  set_workspace_stages: "Saving your pipeline stages",
  complete_onboarding: "Finishing setup",
  ask_user: "Asking you to decide",
};

// Past tense, for the collapsed "what it did" line after the turn. Bookkeeping the person
// doesn't care about (record, learn_preference) is deliberately absent — a summary that
// lists everything summarises nothing.
export const DONE_VERBS: Record<string, string> = {
  whoami: "Checked your seat",
  get_icp: "Read your ICP",
  get_foundation: "Read your ICP",
  get_context: "Assembled the account context",
  get_account: "Pulled the account record",
  query: "Searched your accounts",
  search: "Searched what people said",
  attention: "Checked what needs attention",
  pipeline: "Read your pipeline",
  recommendations: "Reviewed earlier recommendations",
  campaign_performance: "Read campaign performance",
  metrics: "Counted the numbers",
  revenue_report_data: "Computed the revenue report's numbers",
  calendar: "Read your calendar",
  verify: "Verified a fact",
  classify: "Checked leads against your history",
  score: "Scored against your ICP",
  record_insight: "Recorded what the market told us",
  insights: "Read what the market told us",
  reporting: "Read the recurring objections",
  save_note: "Saved a note",
  watch_account: "Set a watch",
  run_play: "Started an autopilot play",
  schedule_automation: "Scheduled a workflow",
  propose_linkedin_message: "Drafted a message",
  propose_linkedin_invite: "Drafted a connection request",
  propose_email: "Drafted an email",
  present_brief: "Wrote the brief",
  read_website: "Read your website",
  write_icp: "Wrote your ICP",
  build_icp_model: "Built your scoring model",
  train_icp_model: "Trained the model on your closed deals",
};

// The skill tools carry the interesting half of the label in their INPUT. "Loading a
// skill" is the app knowing something the user can see and not saying it; a turn that
// followed `brief` should say so, live and in the summary afterwards.
const skillName = (input?: Record<string, unknown>) => {
  const raw = input && (input.name ?? input.skill);
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
};

const withSkill = (
  map: Record<string, string>,
  name: string,
  input: Record<string, unknown> | undefined,
  phrase: (skill: string) => string,
) => {
  const skill = skillName(input);
  return skill ? phrase(skill) : map[name];
};

/** The words a search was actually run with. "Searching what people said" three times in a
 *  row tells you nothing; the query is the part that says what it went looking for. */
const searchTerm = (input?: Record<string, unknown>): string | null => {
  const raw = input && (input.query ?? input.q);
  if (typeof raw !== "string") return null;
  const q = raw.trim().replace(/\s+/g, " ");
  if (!q) return null;
  return q.length > 48 ? `${q.slice(0, 45)}…` : q;
};

/** Present tense, shown live while the tool runs. */
export const toolVerb = (name: string, input?: Record<string, unknown>): string => {
  if (name === "search") {
    const q = searchTerm(input);
    return q ? `Searching what people said about “${q}”` : "Searching what people said";
  }
  if (name === "load_skill") return withSkill(TOOL_VERBS, name, input, (s) => `Using the ${s} skill`) ?? "Loading a skill";
  if (name === "run_skill") return withSkill(TOOL_VERBS, name, input, (s) => `Running ${s}`) ?? "Running a skill";
  if (name === "read_skill_reference") return withSkill(TOOL_VERBS, name, input, (s) => `Reading the detail behind ${s}`) ?? "Reading the detail behind a skill";
  return TOOL_VERBS[name] ?? `Running ${name}`;
};

/** Past tense for the summary. Returns null for tools not worth naming afterwards. */
export const doneVerb = (name: string, input?: Record<string, unknown>): string | null => {
  if (name === "search") { const q = searchTerm(input); return q ? `Searched for “${q}”` : DONE_VERBS[name]; }
  if (name === "load_skill") { const s = skillName(input); return s ? `Used the ${s} skill` : null; }
  if (name === "run_skill") { const s = skillName(input); return s ? `Ran ${s}` : null; }
  return DONE_VERBS[name] ?? null;
};
