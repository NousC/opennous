# Context library (GET-875)

Context is saved once for the workspace and **tagged** to RevBoxes. The same file can serve several
boxes. Before this change, every reference was a `revbox_context` row that belonged to exactly one box.

## Data model

Migration: `supabase/migrations/2026_10_15_context_library.sql`. It runs after `2026_10_14_revboxes.sql`, applies as one transaction and is idempotent.

| Table | What it holds |
|---|---|
| `workspace_context_files` | One piece of knowledge. It has a `title` and either a text `body` (up to 256 KB) or a linked `document_id`. Other columns: `kind`, `visibility`, `created_by`, `updated_by`, `icp_marked_at` and timestamps. |
| `revbox_context_links` | `(revbox_id, context_file_id)`, the tags. One file can be tagged to many boxes. Composite foreign keys keep both sides in the same workspace. Deleting a box or a file drops its tags. Deleting a box keeps the file. |

Columns on `workspace_context_files`:

- **`kind`** is `reference` (the default), `instructions` or `icp`. A partial unique index allows **at most one `icp` file per workspace**. A check constraint makes the ICP file always `visibility = 'workspace'`.
- **`visibility`**:
  - `boxes` (the default) means the file's creator can see it, and so can anyone who can open a box it is tagged to. Box access is `revboxAccess`: the owner, a member, or anyone if the box is shared. This is the same rule a box's references followed before.
  - `workspace` means every workspace member can see it.

The tables are service-role only, like every revbox table: RLS is on, `anon` and `authenticated` are revoked, and `service_role` is granted. The server checks access on every read and write, in `packages/core/src/db/contextLibrary.mjs`.

### Backfill and the legacy table

- Every `revbox_context` row is copied into a file with the **same id** plus one link to its box. The copy is `kind reference` and `visibility boxes`, so it stays private to that box.
- Job snapshots that recorded `context_references` ids therefore still name the same files.
- A title like `ICP.md` is **not** marked ICP automatically. Choosing the ICP file is always an explicit action.
- `revbox_context` is **not dropped** in this release.
- `revboxContextRows` reads a box's linked files and adds any legacy row the backfill has not adopted yet, matched by id. That covers a row written by an older API between the migration and the deploy. Re-running the migration adopts such rows.
- Untagging a file from a box, or deleting a file, also deletes the legacy row with that id, so it cannot reappear.
- If the library tables do not exist yet, every reader falls back to `revbox_context`.

## Who can do what

| Action | Who |
|---|---|
| See a file | Anyone allowed by its `visibility` (see above). A linked document is shown only while the viewer can still read that document; the API checks this on every read. |
| Add knowledge (text, upload, linked document) | Any workspace member. With no tags, the file is visible only to its creator unless it is shared with the workspace. |
| Tag or untag a box | Someone with owner or editor access to **that box**. Tags on boxes the viewer cannot open are counted ("1 private RevBox") but never named, and retagging never touches them. |
| Edit title, text, kind or visibility | The file's creator, a workspace owner or admin who can see it, or someone with owner or editor access to **every** box it is tagged to. An editor of one box cannot change what another box's runs read. **The ICP file: workspace owners and admins only, even for its creator.** |
| Mark or unmark the ICP file | A workspace owner or admin. Marking makes the file `workspace`-visible and remembers its previous visibility in `visibility_before_icp`; unmarking restores it. Marking or creating a second ICP file returns a 409 before anything is written. |
| Delete a file everywhere | Its creator or a workspace owner or admin. The ICP file: owners and admins only. |

## What a run reads

A box's run reads **only the files tagged to that box**, whatever their visibility. A `workspace` file that is not tagged to the box is not in its context. The readers below all go through `revboxContextRows`:

- **The engine:** `revboxRoutineContext` in `packages/core/src/services/automationRun.mjs`. Linked documents still pass the box owner's account visibility.
- **`revboxDetails`:** the box page, the legacy snapshot in `apps/api/src/lib/revboxSnapshot.mjs`, and the Job Builder's `revbox_context` tool.
- **`saveRevboxJob`:** the context ids it records in a reviewed snapshot.

The per-box instruction blocks (`revboxes.blocks`) are unchanged. They are edited on the box and listed read-only under the library in Settings > Context.

## The ICP file and ICP scoring

ICP scoring for a `nous` workspace is the learned scorecard (`scorecard_signals`). The LLM step that builds it from prose is `seedScorecardFromMemory` in `apps/api/src/cloud/lib/scorecardSeed.mjs`.

**What reads the ICP file:**

- `seedScorecardFromMemory` calls core `workspaceIcpContext(sb, ws)`. That returns the marked file's text, or the current body of the linked document.
- `scorecardSeedText` then builds the input:
  - **With an ICP file:** the file goes first as `[ICP]`. The older ICP-category notes are left out, including notes stored as `general` with `category_raw: 'ICP'`. The other GTM notes (Market, Product, Pricing, Competitors, Positioning) still follow.
  - **Without an ICP file:** the notes, exactly as before.

**Triggers.** There is no silent re-score of the workspace:

- **Marking a file as ICP** (`PATCH /api/revboxes/context-files/:id {kind:'icp'}`, or creating it with `kind: 'icp'`) calls the seed with `force: false`. This is the same thing `set_icp` does.
  - If the workspace has **no scorecard yet**, the first one is built from the file, and accounts are scored against it from then on.
  - An existing scorecard is left alone, and the answer says so.
- **"Rebuild ICP scoring from this file"** (`POST /api/revboxes/context-files/:id/icp-rebuild`, owners and admins) calls the seed with `force: true`. That is one model call, which is not credit-metered: building the scoring model is priced by active accounts, see `apps/api/src/lib/llmUsage.mjs`. It replaces the seed signals and keeps learned and manual ones. After a rebuild:
  - New accounts are scored against the new rules by the 10-minute `scoreEntities` worker.
  - Existing open scores move when their account's claims change.
  - Workspaces mature enough for the nightly scorecard loop also have their open scores replayed there.
  - Nothing re-scores the whole workspace the moment you click.
- **Editing the text of the ICP file** changes what the *next* build reads. It does not rebuild by itself.

On an open-source build there is no learned scorer. The file is kept, and the answer is `not_available` with a `message` that says so. It never switches the scorer.

### An ICP file means Nous scores (GET-878)

Rule (2026-10-14): when a workspace has an ICP file marked in Settings > Context, Nous scores its accounts from it (`workspaces.icp_scorer = 'nous'`). External scoring applies only when there is no ICP file.

`markIcpFile` (`apps/api/src/lib/icpContextFile.mjs`) runs marking (POST with `kind: 'icp'`, PATCH to `kind: 'icp'`) and the rebuild:

- **Workspace scorer is `external`** (`getIcpScorer`, so a plan default counts too) and the caller is an owner or admin:
  - Without `confirm_scorer_switch: true` the API answers **409** `{ error, code: 'icp_scorer_switch_required', scorer: 'external' }` with the message "Nous will score this workspace's accounts from this file from now on. Scores already posted from outside stay until they resolve." Nothing is written: no file is created or marked, nothing is mirrored and nothing is built.
  - With it: the file is marked, `setIcpScorer(sb, ws, 'nous')`, `mirrorIcpFile`, then the scorecard is built from the file with `force: true` (the old scorecard was not in use). The answer's `icp` carries `scorer: 'nous', scorer_switched: true`.
  - The rebuild never silently answers `external_scorer` any more: it takes the same confirm, switch and rebuild.
- **Already `nous`:** unchanged. A mark builds with `force: false`, a rebuild with `force: true`.
- **A member who is not an owner or admin** is not asked to confirm. The write refuses them with 403, as before.
- **Unmarking does not switch back.** Going to External stays the separate `PUT /v2/icp/scorer`.
- Scores already posted from outside (`ext:` model versions) stay until they resolve. Re-scoring is unchanged.

### The workspace ICP follows the file

When a file is marked ICP, when the ICP file is edited, and on a rebuild, `mirrorIcpFile`
(`apps/api/src/lib/icpContextFile.mjs`) writes the file's text through `writeIcp`. That updates three places:

- the `foundations` row, which `readIcp`, `GET /v2/icp` and MCP `query {foundation:'icp'}` serve to agents;
- a new ICP note, which the per-contact ICP scorers read: `enrichment.mjs` `scoreICP` fallback and worker `enrichContact.mjs`;
- `workspaces.icp_text`.

Rules:

- Unchanged text writes nothing, so no duplicate ICP notes pile up.
- A repo-authored ICP (`source: 'claude_code'`) keeps its source and `file_path`, so the next sync writes the new text back to the repo.
- **Unmarking does not wipe anything.** The foundation keeps the last text.
- A linked-document ICP file is mirrored when it is marked, edited in the library or rebuilt. An edit made to the document itself is not mirrored until one of those happens.

### Note categories

`saveNote` stores a label outside the claim taxonomy, such as 'ICP', 'Market', 'Product', 'Pricing' or 'Positioning', as category `general`, and keeps the label in `metadata.category_raw`. Before this change, `listNotes({categories:['ICP', ...]})` therefore missed every such note written since that normalisation. The scorecard seed and the per-contact scorers use exactly that filter. `listNotes` now also matches `category_raw`.

'Competitors' is still stored as the taxonomy key `competitor`, so it is still not matched by the 'Competitors' label. That is left as is: matching it would pull every account's extracted competitor facts into the workspace seed.

### Linked documents

A library file that is a linked document can be edited, deleted, tagged or rebuilt only by someone who can still read the document. To anyone else it is "not found", just as it is hidden from them in the list.

## API

All routes live under `/api/revboxes` (`apps/api/src/routes/api/revboxes.mjs`).

| Route | What it does |
|---|---|
| `GET /context-library` | Returns `{ files, boxes, is_admin, icp_file_id }`. `files` are the files the viewer can see, each with its `boxes` chips, `hidden_boxes` and `can_edit`. |
| `POST /context-files` | Takes `{ title, body \| document_id, kind?, visibility?, revbox_ids?, confirm_scorer_switch? }`. |
| `PATCH /context-files/:id` | Takes any of `{ title, body, kind, visibility, revbox_ids, confirm_scorer_switch }`. `revbox_ids` is the full tag set among the boxes the viewer can see. |
| `DELETE /context-files/:id` | Deletes the file. |
| `POST /context-files/:id/icp-rebuild` | The explicit rebuild described above. Takes `{ confirm_scorer_switch? }`. |

Marking or rebuilding on an `external` workspace without `confirm_scorer_switch: true` answers 409 `icp_scorer_switch_required` (see GET-878 above).
| `POST /:boxId/context` | `{ title, body }` or `{ document_id }` creates a library file tagged to the box. `{ file_id }` tags an existing file. |
| `DELETE /:boxId/context/:fileId` | Untags the file from the box. The file stays in the library. |

## UI

- **Settings > Context** (`apps/frontend/src/components/settings/ContextLibrary.tsx`):
  - One "Library" card with Upload and Add knowledge.
  - Each file is one compact row: its title, a kind badge (ICP, Instructions or Reference), its box chips, who can see it and when it was last updated.
  - Clicking a row opens the file as a document (GET-895, see "Context as documents" below), with Edit, Tags & sharing (the full dialog: title, text, kind, sharing, tags), Mark as ICP, Unmark ICP, Rebuild ICP scoring and Delete.
  - `?section=context&file=<id>` opens that file on arrival. The box page links there to edit a file.
  - When the API answers `icp_scorer_switch_required`, a small dialog shows its message with "Use this file for scoring" and "Cancel". Confirming sends the same request again with `confirm_scorer_switch: true`. The outcome is shown plainly after, e.g. "Scoring rebuilt from this file: 20 signals".
- **The box page** (`RevBoxes.tsx`): "Add from your library" lists library files not yet tagged to the box. It sits above the documents list. Upload still creates a library file tagged to the box. Clicking a file in the Context card opens the same document sheet, read-only, with "Open in library" to edit it there.
- **Preview** (`apps/frontend/preview/revboxes.mjs`): seeds the ICP file tagged to two boxes ("Closed won/lost analysis" and "Customer onboarding"), a workspace "Email voice" instructions file, and (GET-895) a markdown "Win/loss report format" file plus a markdown "Report format" instruction block on the won/lost box, so the document sheet shows headings, numbered and bullet lists, a table, bold, code and a quote. The preview workspace starts on the `external` scorer (`icp_scorer` in the store), so Mark as ICP and Rebuild ask first; confirming switches it to `nous`.

### Context as documents (GET-895)

Context files and instruction blocks are shown as documents, not as raw text in an expand/collapse row.

- **The sheet** (`apps/frontend/src/components/revboxes/ContextDocSheet.tsx`): a right-side sheet, up to 680px wide and full width on a phone. The header has the kind badge, where the file comes from, who can see it, when it was updated, the title and the box chips. The body scrolls inside the sheet. Actions sit in a footer.
- **Rendering**: the app's own markdown renderer, `Prose` in `AgentMarkdown.tsx` (react-markdown with remark-gfm, the same renderer and `doc` typography as Results reports). It renders headings, numbered and bullet lists, tables, bold, italic, code and quotes. It has no raw-HTML plugin, so HTML in a file is shown as text and never injected, and `javascript:` links are stripped. Wide tables and code blocks scroll sideways on their own.
- **How the text is read** (`apps/frontend/src/lib/contextDoc.ts`, pinned by `apps/frontend/tests/contextDoc.test.ts`):
  - `docFormat` decides `markdown`, `json` or `plain`. One markdown signal (a heading, list item, table row, fence, quote, bold, italic, inline code or link) is enough.
  - Plain text is split into paragraphs on blank lines and keeps its single line breaks (`plainParagraphs`), so a hand-written note does not fold into one run-on paragraph.
  - A JSON upload is shown as a pretty-printed code block.
  - A first `#` or `##` heading that only repeats the file's title is dropped (`withoutRepeatedTitle`), since the sheet already shows the title.
- **Editing**: Edit switches the sheet to a markdown editor with Write and Preview tabs and Save and Cancel. Save sends `PATCH /api/revboxes/context-files/:id` with `{ title, body }`. Edit shows only when the file's `can_edit` is true, and for the ICP file only to workspace owners and admins. A linked document has no Edit: its text is edited in the document. Closing the sheet with unsaved changes asks first.
- **Instruction blocks** (`revboxes.blocks`) open in the same sheet, read-only, with "Open RevBox".

