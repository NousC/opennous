// One document, read (GET-426).
//
// The wiki at /pages is three columns — a tree, the document, a properties panel — which is
// the right shape when you are looking FOR something. It is the wrong shape when you already
// clicked the thing you wanted, which is how you arrive here from Home. So on the self-serve
// plans a document opens as a page: the title, what it is, and the text. Nothing else.
//
// Serif for the title and sans for the body. The title is the one place a document gets to
// look like a document rather than a record, and the mixture is what makes the difference
// legible at a glance — you know from across the room whether you are reading or scanning.
//
// The metadata is a row of round chips under the title, not a sidebar of labelled fields: at
// this size there are only ever three or four facts, and a panel for four facts is furniture.
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Calendar, Loader2, Trash2 } from "lucide-react";
import { EntityAvatar } from "@/components/EntityAvatar";
import { KIND_LABEL, fmtDay, useDoc, useDocMutations, docDate } from "@/components/docs/api";
import { SectionBody } from "@/components/ReportBlocks";
import { EditableSection } from "@/components/docs/EditableSection";
import { useDocCitations } from "@/components/docs/citations";
import { DocSources } from "@/components/docs/DocSources";
import { ShareBar } from "@/components/ShareBar";
import { cn } from "@/lib/utils";

/** A round chip. The unit the metadata row is made of. */
function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-border bg-background px-3.5 text-[13.5px] text-muted-foreground"
    >
      {children}
    </span>
  );
}

export default function DocPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { data: detail, isLoading, error, refetch } = useDoc(id ?? null);
  const { remove, editSection } = useDocMutations();
  const [deleting, setDeleting] = useState(false);

  const doc = detail?.document ?? null;
  // Citations, resolved the one way every surface resolves them. The markers the writer
  // emitted become links to the call or thread the claim came from.
  const { sections, cited, indexOf } = useDocCitations(detail);


  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error || !doc) {
    return (
      <div className="mx-auto max-w-[680px] px-6 pt-16">
        <p className="text-[14px] text-foreground">That document is not here.</p>
        <button onClick={() => navigate("/")} className="mt-4 text-[12.5px] text-muted-foreground underline underline-offset-4 hover:text-foreground">
          Back to Home
        </button>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-y-auto bg-background">
      {/* Back on the left, Share on the right, both floating over the scroll. Share is the
          one dark object on the page — it is the only thing here that leaves the page. */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-background/85 px-5 py-3.5 backdrop-blur">
        <button
          onClick={() => navigate(-1)}
          className="flex h-[30px] w-[34px] items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Back"
          title="Back"
        >
          <ArrowLeft className="h-[14px] w-[14px]" strokeWidth={1.75} />
        </button>

        <div className="flex items-center gap-2">
          {/* Delete. Two presses, not a dialog: a confirm box for one document is a modal
              you learn to dismiss without reading, and the second press is right there. */}
          <button
            onClick={async () => {
              if (!deleting) { setDeleting(true); setTimeout(() => setDeleting(false), 3000); return; }
              if (!doc) return;
              await remove(doc.id);
              navigate("/");
            }}
            title={deleting ? "Press again to delete" : "Delete"}
            aria-label={deleting ? "Press again to delete" : "Delete"}
            className={cn(
              "flex h-[30px] items-center justify-center rounded-full border transition-colors",
              deleting
                ? "border-foreground/30 bg-foreground/[0.06] px-3 text-[12.5px] text-foreground"
                : "w-[30px] border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {deleting ? "Press again" : <Trash2 className="h-[14px] w-[14px]" strokeWidth={1.75} />}
          </button>
          <ShareBar />
        </div>
      </div>

      <article className="mx-auto max-w-[680px] px-6 pb-28 pt-4">
        <h1 className="font-serif text-[29px] leading-[1.15] tracking-tight text-foreground">{doc.title}</h1>

        {/* What it is, who it is about, when. Three or four facts, as chips. */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {/* The account leads, with its logo. A report is about an account before it is a
              report, and the logo is what you recognise from the doorway. */}
          {/* The account, with its logo, and it goes there. A report is about an account —
              reading one and then having to search for the account is a dead end where a
              link belongs. */}
          {detail?.subject && (
            <button
              onClick={() => navigate(`/accounts/${detail.subject!.id}`)}
              title={`Open ${detail.subject.name ?? "the account"}`}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-border bg-background px-3.5 text-[13.5px] text-foreground transition-colors hover:bg-accent"
            >
              <EntityAvatar
                kind={detail.subject.type === "person" ? "person" : "company"}
                name={detail.subject.name}
                domain={detail.subject.domain}
                photoUrl={detail.subject.photo_url}
                className="h-[18px] w-[18px] rounded-[4px]"
                textClassName="text-[7.5px] font-semibold"
              />
              {detail.subject.name}
            </button>
          )}
          <Chip>{KIND_LABEL[doc.kind] ?? doc.kind}</Chip>
          <Chip>
            <Calendar className="h-[12px] w-[12px]" strokeWidth={1.75} />
            {fmtDay(docDate(doc))}
          </Chip>
        </div>

        {doc.headline && (
          <p className="mt-6 text-[15px] leading-relaxed text-muted-foreground">{doc.headline}</p>
        )}

        {/* The body, through SectionBody — the renderer the wiki already uses.
            
            This page first drew `sec.body` directly and showed nothing but headings: a
            section's text lives in `blocks` and `body` is the legacy shape, so every document
            written since blocks arrived rendered as a list of its own titles. Two renderers
            for one object, which is the exact failure documents.ts opens by warning about. */}
        <div className="mt-9 flex flex-col gap-10">
          {sections.map((sec, i) => (
            <section key={i}>
              {sec.label && (
                <h2 className="mb-3 text-[15px] font-medium text-foreground">{sec.label}</h2>
              )}
              {/* Editable where it is prose, rendered where it is blocks. The agent writes
                  it; you correct it. */}
              <EditableSection
                sec={sec}
                citeIndex={indexOf}
                onSave={async body => { await editSection(doc.id, i, body); await refetch(); }}
              />
            </section>
          ))}
          {!sections.length && doc.body_md && (
            <div className="whitespace-pre-wrap text-[15px] leading-[1.75] text-foreground/85">{doc.body_md}</div>
          )}
        </div>

        {/* THE SOURCES, AT THE FOOT OF THE PAGE. A [7] in the prose is a promise that there
            is something to go and read; without this list it was a number that led nowhere.
            The document carried them all along — useDocCitations has been numbering them —
            and the page simply never drew them. Same shape as the agent's chat: a count you
            can collapse, then one numbered row per source with what it is and when. */}
        {cited.length > 0 && <DocSources cited={cited} />}
      </article>
    </div>
  );
}
