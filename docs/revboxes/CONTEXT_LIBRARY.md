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

On an open-source build there is no learned scorer. The file is kept, and the answer is `not_available`.

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
| `POST /context-files` | Takes `{ title, body \| document_id, kind?, visibility?, revbox_ids? }`. |
| `PATCH /context-files/:id` | Takes any of `{ title, body, kind, visibility, revbox_ids }`. `revbox_ids` is the full tag set among the boxes the viewer can see. |
| `DELETE /context-files/:id` | Deletes the file. |
| `POST /context-files/:id/icp-rebuild` | The explicit rebuild described above. |
| `POST /:boxId/context` | `{ title, body }` or `{ document_id }` creates a library file tagged to the box. `{ file_id }` tags an existing file. |
| `DELETE /:boxId/context/:fileId` | Untags the file from the box. The file stays in the library. |

## UI

- **Settings > Context** (`apps/frontend/src/components/settings/ContextLibrary.tsx`):
  - One "Library" card with Upload and Add knowledge.
  - Each file shows its title, a kind badge (ICP, Instructions or Reference), its box chips and who can see it.
  - Expanding a file shows its text plus Edit (title, text, kind, sharing, tags), Mark as ICP, Rebuild ICP scoring and Delete.
- **The box page** (`RevBoxes.tsx`): "Add from your library" lists library files not yet tagged to the box. It sits above the documents list. Upload still creates a library file tagged to the box.
- **Preview** (`apps/frontend/preview/revboxes.mjs`): seeds the ICP file tagged to two boxes ("Closed won/lost analysis" and "Customer onboarding") and a workspace "Email voice" instructions file.
