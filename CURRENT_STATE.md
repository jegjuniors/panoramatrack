# PanoramaTrack — Current State

**Current Version:** v49.1 *(Submission notifications — Edge Function + trigger wiring built; deployment is the only step left)*
**Last Updated:** July 14, 2026

> Note: this file had fallen out of sync with the codebase (last full update was at v44.0; the
> actual app was already at v47.4 per the `index.html` version badge and in-code comments before
> this session). The v47.5–v49.1 entries below are current; v44.1–v47.4 history isn't backfilled.

> **Migrations required (run in order in the Supabase SQL editor before deploying this version):**
> 1. `migration_v48_start_time.sql` — adds `punches.declared_start_time` and 5 `pt_settings`
>    columns for scheduled-start selection. (Carried over from v48.0.)
> 2. `migration_submit_notify.sql` — adds `pt_settings.submit_notify_enabled` and
>    `pt_settings.submit_notify_emails`. (Carried over from v49.0 — no new migration this version.)

> ⚠️ **Deployment still needed before this feature is live** — see "Not built yet" at the bottom
> of the v49.1 entry below. The code is complete; Julio still needs to create the Edge Function
> in the Supabase Dashboard, paste in the provided code, and set the `RESEND_API_KEY` secret.

---

## 🚧 v49.1 — Submission notifications: Edge Function + trigger wiring (part 2 of the feature)

**Context:** Continuation of v49.0 (settings foundation). This part adds the actual Edge Function
that sends the email via Resend, and wires it into the three action handlers identified in the
v49.0 entry. Full design reasoning (trigger choice, batching, why the admin override is
excluded, the supervisor-self-submit edge case) is documented there — not repeated here.

**What shipped this session:**
- **`submission-notify-edge-function.ts`** (new file, delivered separately — not part of the app
  bundle, meant to be pasted into the Supabase Dashboard) — a Deno Edge Function that:
  - Accepts `{ supervisorName, periodLabel, items: [{employeeName, jobsite}] }` via POST.
  - Reads `submit_notify_enabled`/`submit_notify_emails` from `pt_settings` on every call (via
    the auto-injected `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, using the REST API directly —
    no supabase-js import needed) — so toggling the setting takes effect immediately, no
    redeploy required.
  - No-ops cleanly (200 response, `sent:false`) if disabled, no recipients configured, or an
    empty items array — never errors out for these expected non-send cases.
  - Groups items by jobsite, builds a subject line (single site vs "+N more"), and an HTML body
    listing employees under each jobsite heading. All interpolated values are HTML-escaped.
  - Sends via `POST https://api.resend.com/emails` using the `RESEND_API_KEY` secret (never
    hardcoded — must be set directly in Supabase, since this file may end up in GitHub).
  - From address: `PanoramaTrack <alerts@notify.panoramabuildingsystems.ca>` (the verified Resend
    sending domain from v49.0).
  - Handles CORS (OPTIONS preflight) so it can be called directly from the browser via
    `sb.functions.invoke(...)`.
  - Genuine failures (missing secrets, Resend API errors, pt_settings read failures) return
    non-200 so they show up properly in Supabase's function logs; expected no-send cases return
    200 so they don't look like errors.
- **`app.js` — new `notifySubmission(items, supervisorName, periodLabel)` helper** (placed right
  after `setTimecardStage()`), a thin fire-and-forget wrapper around
  `sb.functions.invoke('submission-notify', {...})`. Never awaited by callers; any failure is
  caught and only `console.warn`'d — per the agreed rule, a notification failure must never
  block or surface as an error on the supervisor's actual submission.
- **Wired into all three trigger points, none into the admin override:**
  1. `doSubmitSiteToOffice` (supervisor batch send) — builds items only from pairs that actually
     succeeded (zips `readyPairs` against the `results` array), looks up each employee's name
     from the `employees` array (falls back to `'Unknown'` rather than crashing if not found),
     supervisor name from `activeSup.name`.
  2. `supSendEmployeeToOffice` (supervisor per-employee send) — only reached on full success
     (partial failure returns earlier, before the notify call, matching the function's existing
     early-return pattern for partial failures).
  3. `submitMyTimecard`'s supervisor-self-submit branch — gated on `isSupEmp` so regular
     employees (who only ever reach `emp_submitted` here, never `sup_submitted`) never trigger a
     notification; only a supervisor's own bypass-straight-to-office submission does.

**Verified:** `node --check` on `app.js`. The Edge Function was syntax/type-checked with `tsc`
against a minimal ambient `Deno` global shim (zero errors) — Deno's actual runtime isn't
available in this environment, so this catches syntax/type mistakes but isn't a substitute for
testing the deployed function directly. An 8-assertion harness verifies the item-building/
filtering logic used in all three wiring points (success/failure zipping in the batch path,
unknown-employee-id fallback, per-employee and self-submit item shapes, and the
`notifySubmission` empty-array no-op guard) — all against extracted/mirrored logic, since the
real functions depend on live Supabase and DOM state that can't be exercised outside the app.

**Not built yet — remaining steps, all on Julio's side:**
1. In the Supabase Dashboard: Edge Functions → New Function → name it `submission-notify` →
   paste in `submission-notify-edge-function.ts` → Deploy.
2. Add the `RESEND_API_KEY` secret (Function Secrets, or Project Settings → Edge Functions →
   Secrets). The key was provided in an earlier session message — not stored in any delivered
   file.
3. Turn on "Submission notifications" in the app's Settings screen and enter the GM's (and any
   other) recipient email(s) — the toggle and field were built in v49.0 but nothing was sending
   until this session's Edge Function existed to receive the call.
4. End-to-end test: have a supervisor send a real (or test) timecard to the office and confirm
   the email arrives. Worth checking the Edge Function's logs in the Supabase Dashboard the
   first time, in case anything about the deployed environment differs from what was
   syntax-checked locally.

---

## 🚧 v49.0 — Submission notifications: settings foundation (part 1 of the feature)

**Context:** GM asked to be emailed whenever a supervisor submits timecards to the office, so he
knows work is coming in for export without having to check the app. Worked through the design
with Julio step-by-step before building anything (see decisions below) — this entry covers only
the first build increment (settings/storage); the Edge Function and trigger wiring are separate,
not-yet-built pieces tracked in "On the horizon."

**Design decisions, confirmed:**
- **Channel:** Email via Resend (not Microsoft 365 — Panorama's M365 admin was hesitant about
  registering an Azure app for this purpose). Sending domain: `notify.panoramabuildingsystems.ca`
  — a dedicated subdomain, not the root domain (which carries M365's SPF/DKIM) and not
  `panoramatrack.panoramabuildingsystems.ca` (which already has a CNAME to Netlify for app
  hosting — DNS doesn't allow a TXT/MX record to coexist with a CNAME at the same hostname, so
  that hostname was never usable for this regardless of the M365 question). **Domain is verified
  in Resend as of this session.**
- **Trigger:** Fires on the *action*, not on full jobsite completion — i.e. the moment a
  supervisor sends timecards to the office, not once every employee at a site has been submitted.
- **Frequency:** Real-time, one email per action (not a daily digest).
- **Recipients:** Stored in `pt_settings` (not hardcoded as an Edge Function secret), editable
  from the Settings screen, comma-separated for multiple addresses — built this session.
- **Which actions count (4 total call sites, all funnel through `setTimecardStage(...,TC_STAGE.SUP,...)`):**
  1. Supervisor batch "submit site to office" (`submitSiteToOffice` → `doSubmitSiteToOffice`,
     ~line 2128) — **notifies**. Can span multiple jobsites in one action if the supervisor
     manages more than one site.
  2. Supervisor per-employee send (`supSendEmployeeToOffice`, ~line 2258) — **notifies**.
  3. Admin override (`adminOverrideSite`, ~line 4680) — single employee/site, bypasses both the
     employee submission and supervisor review steps entirely — **does NOT notify**. If the
     admin/GM is the one pulling a card to export, they don't need to be told about their own
     action.
  4. **A supervisor-employee submitting their own timecard** (`submitMyTimecard`, ~line 1237) —
     already skips `emp_submitted` entirely for any employee with `dept==='Supervisor'` (v46.0
     behavior, confirmed unchanged this session — "As a supervisor, this goes straight to the
     office once you submit"), regardless of whether that supervisor is actually supervising the
     site they worked or just working it as a regular employee that day (raised via two real
     examples — a supervisor covering un-supervised sites, and a supervisor working as a regular
     employee on someone else's site — both confirmed to already behave this way). **This
     notifies too.**
  - Net: 3 of the 4 paths to `sup_submitted` trigger a notification; only the admin override is
    silent.
- **Batching:** One email per action, not one per employee/row. The low-level
  `setTimecardStage()` function writes one status row per employee (so a 6-person batch send is 6
  DB writes) — hooking the low-level function would cause a burst of separate emails per batch.
  Instead, the notify call must be hooked at the **three action handlers** listed above (after
  their `Promise.all(...)` of stage changes succeeds), building one combined summary per action
  from whichever employees/jobsites were actually included in *that* pass. Confirmed self-
  exclusion behavior: `readyPairs`/`sendable` in the supervisor batch/per-employee paths only
  ever include rows still at `emp_submitted` — a supervisor's own row (already elevated straight
  to `sup_submitted` via path 4) is automatically excluded from later batch emails without any
  special-casing needed, since it's simply no longer in the "still waiting" set the batch action
  operates on.
  - Straggler passes get their own separate email — e.g. a batch of 5 followed later by a
    catch-up pass that picks up 2 more sends a second email for just those 2.
- **Failure handling (not yet built, but agreed):** the Edge Function call must never block or
  fail the actual submission — if Resend is briefly down, the supervisor's action still succeeds
  normally; the notification failure should log quietly, not surface as an error to the
  supervisor.
- **Email content (drafted, not finalized):** subject + body listing jobsite(s), pay period,
  supervisor name, and the employee(s)/site(s) included in that action.

**What shipped this session (`app.js`, `index.html`, `migration_submit_notify.sql`):**
- New `pt_settings` columns: `submit_notify_enabled` (boolean), `submit_notify_emails` (text,
  cleaned comma-separated string).
- New Settings screen section ("Submission notifications") — enable checkbox + recipient email
  field, following the existing settings-section pattern (Scheduled-start, lunch deduction, etc).
- `parseNotifyEmails(raw)` helper — splits/trims/dedupes (case-insensitive) the comma-separated
  input, loosely validates each entry as an email shape, returns `{clean, invalid}`. On save,
  invalid-looking entries are dropped from what's stored and surfaced as a non-blocking amber
  warning message (the settings save itself still succeeds).
- `APP_SETTINGS`/`applySettingsRow()` extended with `submitNotifyEnabled`/`submitNotifyEmails` —
  folded into the existing single-row `pt_settings` load/save cycle for simplicity, even though
  (unlike the rest of `APP_SETTINGS`) these aren't pay-rule fields — the Edge Function (not yet
  built) will read them directly from Supabase rather than via the client's `APP_SETTINGS` object.

**Verified:** `node --check` on `app.js` + an 8-assertion harness on `parseNotifyEmails()`
covering: basic comma-separated parsing, whitespace trimming, empty string, trailing/empty
entries dropped, invalid entries flagged without crashing, case-insensitive dedupe (first casing
kept), single-entry input, null/undefined input.

**Not built yet — next steps:**
1. The Supabase Edge Function itself — calls Resend's API using `RESEND_API_KEY` (Resend API key
   was provided this session; **not stored in any file** — it must be added directly in Supabase
   as an Edge Function secret when the function is deployed, never committed to GitHub).
2. Wiring the three trigger points (`doSubmitSiteToOffice`, `supSendEmployeeToOffice`,
   `submitMyTimecard`'s supervisor-bypass branch) to call the Edge Function after a successful
   send, each building its own one-action summary.
3. Julio deploys via the **Supabase Dashboard's built-in Edge Function editor** (confirmed this
   session — no CLI use), and sets `RESEND_API_KEY` as a secret there.
4. Finalize exact email subject/body wording.

---

## ✅ v48.1 — My Timecard transparency: day-grouped Paid vs Actual times

**Context:** Julio's ask — employees should be able to see both their actual clocked in/out
times and the rounded/credited/selected times used to calculate paid hours, side by side, with
the calculated time bolder and the actual time visually secondary, plus a daily total so the
picture is grouped by day rather than a flat punch list. Confirmed design choices (asked as
numbered options, Julio picked per-item):
1. Show both Paid and Actual lines always, even when identical — consistent UX over minimalism.
2. Show a day total even on single-punch days — consistent grouped-by-day layout.
3. Show the lunch deduction as a note next to the day total when it applies.
4. An open punch (not yet clocked out) should already show what its rounded/declared-start time
   will settle to on the Paid line — only the out side is genuinely still pending.

**Bug found and fixed along the way:** `adjustedTimes()` only resolved (rounded, or honored a
declared start) the "in" side of a punch *after* confirming a clock-out existed — so an open
punch's in-time stayed completely raw until the employee clocked out, even though the eventual
rounded/declared value is already fully determined by the in-punch alone. Restructured so the
"in" side is resolved up front regardless of whether `out` exists yet; the "out" side is
unaffected and still `null` until a real clock-out happens. Synthetic (auto-clocked/estimated)
punches continue to skip all rounding on both sides, unchanged. This is a fix in the shared
pay-rule engine, so it also cleans up the day-view "clock in" time for an employee's still-open
punch anywhere else `adjustedTimes()` feeds a per-day rollup (Master Log Report / Excel Pack
`consolidate()`), not just My Timecard — flagged here since it wasn't the original target but is
the same underlying computation.

**What shipped (`app.js`):**
- `adjustedTimes()` reworked (see bug note above) — behavior for closed, non-synthetic punches is
  unchanged; only the open-punch in-time and the (unused elsewhere) synthetic-open case changed.
- New `myTcDayHours(punches)` helper — per-day paid vs. raw (pre-lunch-deduction) hour totals,
  plus an `anyOpen` flag. Pending lunch-waive punches are counted as-if-approved, mirroring the
  existing `myTcRunningHours()` pattern, so the day total stays consistent with the period total
  shown above the list.
- `renderMyTcList()` restructured: punches are bucketed into calendar-day groups (single pass,
  relying on the existing clock_in-descending fetch order so same-day punches are contiguous).
  Each day gets a header showing the date, the day's paid-hours total, a `−Xm lunch` note when
  the lunch deduction applied that day, and `still open` when a punch in that day hasn't been
  clocked out yet. Each punch card now shows a bold **Paid: in → out · X.XXh** line (using
  `adjustedTimes()` + `paidHours()`) above a smaller, dimmer **Actual: in → out** line (raw
  `e.in`/`e.out`) — replacing the old single "In: … → Out: …" line and the redundant per-punch
  date header (now covered by the day-group header instead).

**Verified:** `node --check` on `app.js` + a 27-assertion logic harness covering:
- `adjustedTimes()`: rounding disabled passthrough (regression), open punch with rounding
  (new behavior — in gets rounded), open punch with a declared start (declared value used
  as-is, unrounded), open + synthetic (defensive edge case — stays raw), closed + rounding
  (regression), closed + declared start (regression), closed + synthetic (regression, both
  sides raw), sched-end credit still applies normally on a closed punch (regression).
- `myTcDayHours()`: single punch under lunch threshold (raw===paid), single punch over
  threshold (30-min gap surfaces correctly), multi-punch day with one open punch (paid total
  excludes the open one, `anyOpen` true), pending lunch-waive counted as approved without
  mutating the stored `lunchWaived` flag.
- Day-grouping bucket logic (extracted standalone): 3 punches spanning 2 calendar days group
  correctly (2 in today's group, 1 in yesterday's), preserving arrival order within each group.

**Not built / deferred:** "why" explanatory tags next to the Paid line (e.g. "(rounded)",
"(you selected 7:00 start)") — Julio went with the simpler bold/dim contrast for v1; can add
later if employees are still confused by the two numbers.

---

## ✅ v48.0 — Scheduled-start selection + clock-out credited-time popup

**Context:** GM/Julio edge-case discussion — ~95% of employees have a 7:00 AM standard start, but
routinely punch in earlier while waiting around before their shift actually begins. A few
employees are supervisor-approved to genuinely start at 6:00 or 6:30. Unlike the existing
scheduled-**end** credit (one fixed time, applied silently to everyone), mornings have multiple
legitimately-valid start times, so this asks the employee rather than guessing.

**Scheduled-start selection popup:**
- New pay-rule engine piece: `computeStartTimeOptions(punchIn)` (`app.js`, next to
  `adjustedTimes`) — returns the ascending list of start-time options to offer, or `null` if no
  popup should show. Confirmed exact bands (grace=5, inclusive boundary — see harness below):
  - Before 6:06 AM → `[06:00, 06:30, 07:00]`
  - 6:06 AM – 6:35 AM → `[06:30, 07:00]`
  - 6:36 AM – 6:59 AM → `[07:00]`
  - 7:00 AM or later → no popup
  - Each early time independently drops off `grace` minutes after its own mark — not a single
    global cutoff.
- Configurable via new **Scheduled-start selection** Settings section (mirrors the existing
  Scheduled-end credit section): enabled toggle, standard start time, two early option times,
  grace period in minutes. Defaults match the confirmed bands (7:00 / 6:30 / 6:00 / 5 min grace)
  but nothing is hardcoded — Julio can retune later without a code change.
- **Flow (`submitPin()`):** clock-in → (if options returned) **"What time are you starting
  work?"** modal, large buttons, forced choice (no dismiss — this is payroll data) → selecting an
  option writes `declared_start_time` on the punch (raw `clock_in` is never touched, same
  principle as the lunch deduction) → **then** the Corfix safety reminder fires. If no popup is
  needed, flow is unchanged (straight to Corfix, same as before).
- **Explicitly reordered per Julio's call:** safety reminder now always comes *after* the
  start-time question, not simultaneously.
- `adjustedTimes()` now uses `entry.declaredStart||entry.in` for the "in" side, and — when a
  declared start exists — **skips rounding it** (it's already a clean, deliberately-chosen mark,
  not a raw punch needing normalization). A declared start is honored even on an otherwise
  auto-clocked entry (auto-clock only means the *out* side was synthetic; the declared start is
  still real data from the employee's actual clock-in).
- `dbRowToEntry()` maps the new `declared_start_time` column → `entry.declaredStart` everywhere
  punches are loaded (Master Log, Supervisor Log, My Timecard, admin correction modal, exports —
  all flow through `paidHours()`/`adjustedTimes()` automatically).
- **Staleness guard:** editing a punch's raw clock-in via the admin/supervisor edit modal
  (`saveEdit()`) or an employee's own My Timecard edit (`saveMyTcEdit()`) now clears
  `declared_start_time` — prevents a stale declared value from silently overriding a legitimate
  correction to the raw time.

**Clock-out credited-time popup:**
- Found the underlying gap while discussing this: `confirmClockOut()`'s toast showed the **raw**
  punch-out time, never what the employee would actually be paid to after rounding/schedule
  credit — e.g. a 3:07 PM punch showed "Punched out at 3:07 PM" even though paid hours reflected
  3:00 PM, with zero indication of the discrepancy.
- `confirmClockOut()` now compares `adjustedTimes(entry).out` (credited) against the raw punch,
  and only when they differ by ≥60 seconds (avoids noise from sub-minute artifacts), shows a new
  modal — large text, "You're clocked out at [credited time]", with the raw punch time noted
  smaller underneath — instead of the plain toast. When they match, the existing toast is
  unchanged (no new information to add, no extra tap).
- Deliberately **not** a selection popup like the morning one — there's only one scheduled end
  time (no per-employee exceptions the way mornings have), so there's nothing to choose between;
  this is purely informational.

**Verified:** `node --check` on `app.js` + two logic harnesses (28 assertions total):
- 19 assertions on `computeStartTimeOptions()` covering every confirmed band boundary
  (including the exact 6:06/6:36 transition minutes), the disabled-feature case, and a
  zero-grace edge case that caught a real off-by-one (see below).
- 9 assertions on `adjustedTimes()` covering declared-start bypassing rounding, an auto-clocked
  entry still honoring a real declared start, an open punch with no declared start, and the
  clock-out popup's difference threshold (rounds-down case, exact-match case, sub-minute noise
  case).

**Bug caught during testing (fixed before delivery):** the first implementation used a strict `<`
comparison with a 6-minute grace default. Testing a grace=0 edge case exposed that this excluded
the exact checkpoint minute itself (punching in at *exactly* 6:00 would have shown the popup
without 6:00 as an option) — a real off-by-one, not just an edge-case curiosity. Fixed by
switching to an inclusive `<=` comparison with grace=5 (matching Julio's own "5 min grace"
wording) — produces the identical confirmed band boundaries while correctly treating landing
exactly on time as never "late," even at zero grace.

**Not built:** per-employee approval enforcement for the early options — Julio explicitly chose
the simpler approach (all employees see the same bands based on punch-in time, honor system for
who's actually authorized to be there early), not a per-employee allow-list.

---

## ✅ v47.8 — Report tab query bound + Archive old punches (Part C, reframed)

**Context:** Julio's underlying goal for "database wipe" (from the original 4-part Database
Maintenance request) was keeping the DB small enough for Supabase's free tier and keeping the app
fast — not a general-purpose nuke-any-table tool. Investigated both goals before building:

- **Supabase free tier (verified July 2026): 500 MB total database size**, shared across the
  whole project — and this project already shares its budget with at least one unrelated app (the
  `orders` table found during the FK constraint check isn't part of PanoramaTrack's schema, same
  pattern as the earlier `pt_settings` naming collision).
- **Growth math:** `employees`/`jobsites`/`departments`/`activities` are static — a few hundred
  rows total, ever. They don't meaningfully affect size and were dropped from this effort
  entirely. `punches` is the only table with real compounding growth (~50-100 employees × ~2
  punches/day × ~250 workdays ≈ 25-50k rows/year, roughly 10-15 MB/year) — years away from being
  an emergency at this employee count, but the actual lever worth building.
- **Found a real, already-existing performance issue** unrelated to total data volume:
  `getMasterLogFiltered()` (the Report tab query) had no fallback when its date fields were empty
  — an admin manually clearing the native date-input controls would trigger a full unfiltered
  `punches` fetch, every time, regardless of table size. This was the more direct threat to "bog
  down loading of the app" than data volume itself.

**What shipped:**
- **`getMasterLogFiltered()`** — if the "from" date is missing (to being missing is fine, it's
  naturally bounded by "no future punches exist"), falls back to a 1-year lookback instead of
  fetching the entire table, and writes the fallback dates back into the visible `#m-log-from` /
  `#m-log-to` fields so the UI honestly reflects what's being queried rather than showing blank
  dates with silently-limited results.
- **Archive old punches** (`archiveOldPunches()` / `doArchivePunches()`, new section in the
  Database Maintenance modal, below Backup) — replaces the earlier "wipe Punches" checkbox idea.
  Pick a cutoff date → previews the count → `showCustomConfirm()` (existing app-wide confirm
  pattern, matches convention rather than a bespoke type-to-confirm) → downloads matching punches
  as JSON (same shape as backup) → deletes them from `punches` in chunks of 500 once the download
  has fired. History is moved to a file, not destroyed — keeps the payroll-record-retention
  concern from the earlier wipe discussion satisfied.
  - **Safety floor:** cutoff can't be more recent than 6 months ago (`ARCHIVE_MIN_MONTHS_AGO`,
    both a JS validation check and the date input's `max` attribute) — prevents accidentally
    archiving punches still mid-submission/export. Arbitrary but conservative default; easy to
    adjust (one constant) if Julio wants a different threshold.
  - Known limitation, same as `runBackup()`: there's no browser callback confirming a download
    actually completed/saved before the delete proceeds — this mirrors an existing accepted
    limitation elsewhere in the app rather than introducing a new one.
- Employees/Jobsites/Departments/Activities wiping **dropped from scope** — they don't
  meaningfully contribute to database size, so a wipe tool for them doesn't serve this goal. (If
  a separate "clear test data before go-live" utility for those 4 is wanted later, that's a
  distinct, smaller ask — not pursued here.)
- `app_version` in the backup payload synced to v47.8 (same dual-tracked spot as the version
  badge, noted in the table further down this file).

**Still open / explicitly deferred:**
- **Part B (backup restore)** — not built this round; got sidelined by the wipe reframing. Still
  wanted per Julio, semantics already agreed: wipe-and-reinsert (exact match to backup file),
  scoped to just the current 5 tables.
- **Part D (audit log)** — untouched, own design pass needed (see v47.7 entry below for the open
  questions: no per-admin identity exists today, scope of loggable actions, retention policy).

**Verified:** `node --check` on `app.js` + a 12-assertion logic harness covering the report-range
fallback (both-empty, from-empty-with-to-set, from-set-with-to-empty, both-set) and the archive
cutoff floor (exact boundary, one day inside it, well past it, today).

---

## ✅ v47.7 — Database Maintenance modal shell (Part A of a 4-part feature)

**Context:** Julio wants a proper "Database Maintenance" area covering backup, backup restore,
selective database wipe, and a separate audit log feature. Scoped into 4 independently-buildable
pieces (see "On the horizon" below for B/C/D — none of that is built yet):
- **A (this entry):** move the backup button into Settings, wrap it in a new modal shell.
- **B:** backup restore.
- **C:** selective database wipe (by table).
- **D:** audit log (separate design pass — see open questions below).

**What shipped (Part A only):**
- Backup card removed from the Overview tab.
- New "Database Maintenance" entry point card added to the bottom of the Settings tab →
  `openDbMaintModal()` / `closeDbMaintModal()` (`#dbmaint-modal-bg`).
- `runBackup()` moved into the new modal **unchanged** — same `#backup-btn` / `#backup-status`
  ids, same logic, just relocated. Backup description copy corrected to accurately describe what
  it covers today.
- `app_version` recorded inside the backup payload updated to match this release (was stale at
  v47.4 — this is the second of the two version-bump spots noted in the table below).

**Findings from investigating current backup (relevant to Parts B/C):**
- Backup covers 5 tables only: `employees`, `jobsites`, `departments`, `activities`, `punches`
  (capped to the last 90 days). It does **not** include `pt_settings`, `pt_timecard_status`, or
  the legacy `submissions` table (still live — used by the PDF export's duplicate-check, not
  fully retired despite the v44.0 rewrite).
- Table names are inconsistent with the "`pt_` prefix" convention — only `pt_settings` and
  `pt_timecard_status` actually carry it; `employees`/`jobsites`/`departments`/`activities`/
  `punches`/`submissions` predate that convention and were never renamed.

**Open questions before B/C/D can be built:**
- **B (restore):** wipe-and-reinsert per table (Claude's lean) vs. merge/upsert? Scope restore to
  only the tables present in the backup file being loaded?
- **C (wipe):** exact table list, plus how to handle dependents — e.g. wiping `employees` orphans
  `punches` and `pt_timecard_status` rows unless those are wiped together. Needs a hard
  confirmation step given how destructive this is.
- **D (audit log):** biggest open item — **no per-admin identity exists today** (Master/GM panel
  is a single shared password, not individual logins), so admin-level actions could only be
  attributed generically as "Admin" unless individual admin accounts are added first (a feature of
  its own). Also needs: which actions get logged (punch edits are obvious; employee/activity/
  jobsite/settings changes and force-submit/override/send-back are open), and a retention policy
  (manual "Clear" only vs. auto-purge by age).

---

## ✅ v47.6 — Admin correction modal: per-punch flags

**Problem:** `openAdminEmpCorrect()` / `refreshAdminEmpCorrect()` (the modal that opens when an
admin clicks an employee's name in the Submissions panel) listed every punch for the period but
gave no visual indication of which ones were actually flagged — same three categories the
Submissions panel already rolls up into that employee's row-level "⚠️ ..." summary one screen up
(unresolved auto-clock, pending lunch waive, punch after submission), just not surfaced per punch
here. Admin had to open each punch to check.

**Fix (`refreshAdminEmpCorrect()`):**
- Now also fetches the employee's `pt_timecard_status` rows for the period via
  `getEmployeeStatusRows()` (needed to evaluate `isOutOfSubmission` per punch, which requires each
  punch's own jobsite's status row).
- Per punch: `autoFlag = autoClocked && !editedAfterAuto`, `waiveFlag = isPendingWaive(e)`,
  `oosFlag = isOutOfSubmission(e,row)` — same helpers used elsewhere, no new logic invented.
- Flagged punches: hours text turns red + bold; a small red "⚠️ …" label appears under the
  jobsite/time line naming which reason(s) apply (e.g. "Unresolved auto-clock · Pending lunch
  waive"), so the admin knows *why* without opening it.
- Confirmed (no code change needed): the modal's "Edit" button already opens the shared
  `openEditModal()`, which unconditionally shows the lunch-waive approve/deny block whenever a
  punch has a pending request — so waive resolution already works from this modal, and the list
  already auto-refreshes after save.
- Also confirmed: hours shown in this modal were already `paidHours(e)` — the same fully-adjusted
  (scheduled-end credit + rounding + lunch deduction) figure used everywhere else hours are
  totaled, not raw elapsed time.

**Verified:** `node --check` on `app.js` + a 16-assertion logic harness covering all three flag
types individually, resolved states no longer flagging (edited auto-clock, decided waive), missing
status row, still-open stage, and a multi-flag punch combining all three reasons.

---

## ✅ v47.5 — Overview "Ready to Export" tile spans current + last period

**Problem:** the tile (added v47.3) only counted the **current** pay period. On the morning right
after a period rolls over — exactly when Brad processes payroll — the tile read **0**, because the
new current period had barely started while the just-closed last period (which actually had ready
timecards) wasn't counted at all.

**Fix:**
- `computeReadyCountForPeriod(period)` (new helper, `app.js` — sits next to `isFullyReadyForExport`)
  factors out the status/punch query + `isFullyReadyForExport` filter so it can be run against any
  period, not just current.
- `refreshMasterOverview()` now calls it for **both** `getPeriodByOffset(0)` (current) and
  `getPeriodByOffset(1)` (last) in parallel and displays the **sum** in `#m-stat-ready`.
- `_overviewReadyPrefPeriod` (new global) is set each refresh: `'last'` if current is 0 and last
  has ready employees, otherwise `'current'`.
- Tile click-through changed from `switchMasterTab('submissions')` directly to a new
  `goToReadyExports()`, which sets `_subPeriodMode='last'` when `_overviewReadyPrefPeriod==='last'`
  before calling `switchMasterTab('submissions')` — so clicking the tile lands on whichever period
  actually has the ready employees, instead of always opening on Current and showing an empty list.
- `index.html`: tile's `onclick` updated to `goToReadyExports()`; version badge → v47.5.

**Verified:** `node --check` on `app.js` + a 16-assertion logic harness covering
`isFullyReadyForExport` regression, the period-preference decision, and the click-through routing
(including the case where an admin had manually left the Submissions panel on "Last" — confirmed
the new logic doesn't force it back to "Current").

---

## ✅ v44.0 — 3-Tier Submission Flow (Employee → Supervisor → Admin) — COMPLETE

**The flow:** Employee reviews their own punches and **submits** their timecard → Supervisor reviews per-employee and does a single **site-wide submit** (only covers already-submitted employees; stragglers stay open) → Admin/GM sees per-jobsite submission status and does the **final export** from the Submissions panel. Supervisors no longer need to export/email PDFs — the GM does it from the office. Supervisor PDF export is demoted to a preview tool.

**Data model — `pt_timecard_status`, schema changed mid-arc (Build 3):** moved from **one row per employee per pay period** to **one row per employee per pay period PER JOBSITE**. Reason: employees can split a period across multiple jobsites (and multiple supervisors), and each site needs its own independent submit/export lifecycle — a single shared row was found to conflate two different supervisors' actions for the same employee. `stage` column (`open → emp_submitted → sup_submitted → exported`), additive timestamps. **No row for a jobsite = 'open' at that jobsite.** `employee_id` is `bigint` (matches `employees.id`). Migration (`migration_v44_build3.sql`, run by Julio) is non-destructive — the new unique constraint is strictly looser than the old one, so no data conflicts, no backfill.
```sql
CREATE TABLE pt_timecard_status (
  id               bigint generated always as identity primary key,
  employee_id      bigint not null,
  period_start     date not null,
  period_end       date not null,
  stage            text not null default 'open',
  emp_submitted_at timestamptz,
  sup_submitted_at timestamptz,
  exported_at      timestamptz,
  jobsite          text,
  updated_at       timestamptz not null default now(),
  unique (employee_id, period_start, jobsite)  -- was (employee_id, period_start) before Build 3
);
```

**Locked design decisions (all confirmed with Julio):**
- **Employee submit:** button lives at the **top of the My Timecard modal**; always available. Caution warning if submitting **before** period end; clean submit **after**. **Auto-clocked punches block** submission → kicked back to the modal to fix via Edit. One submit action writes **one status row per distinct jobsite** the employee worked that period. Employee can **pull back** — but **only while no site has advanced past `emp_submitted`** (aggregate `maxStage` across all their site-rows). Post-submit punches don't require re-submit → supervisor gets an out-of-submission flag (matched per-site).
- **Editing while submitted:** at `emp_submitted` (no site advanced yet), Add/Edit are disabled — the employee must **pull back first**. Hard-locked once **any** site reaches `sup_submitted` (partial per-site self-edit was ruled out of scope — simpler to lock the whole card).
- **Supervisor:** reviews per-employee (flag/fix), submits **site-wide** in one action, scoped to the supervisor's own assigned jobsites; submits only already-submitted employees at those sites, stragglers stay open. **Color-coded per-employee stage chip** in the time log (Option A — one extra `pt_timecard_status` query per log refresh, scoped to the supervisor's sites). PDF export demoted to a **preview/preliminary** tool.
- **NEW — Supervisor "Force Submit":** for an employee who can't/didn't submit themselves (away, forgot, fired, on vacation, etc.), the supervisor reviews/corrects their punches and force-submits on their behalf for whichever of the supervisor's own sites they haven't submitted (`open → emp_submitted`). Gated by the same clean-punches check as everywhere else (blocks on unresolved auto-clocks / pending lunch waives). **No audit marker** — a forced submission is indistinguishable from a normal one; only the resulting stage is tracked.
- **Admin Submissions panel (fully rewritten):** period selector (**Current / Last**, mirrors the supervisor's pattern — added specifically because the "submit whatever period is being viewed" issue from Build 2 applies here too). **Jobsite accordions**; an employee appears under **every** jobsite they logged hours at that period (not just one "home" site — the data model has no fixed employee→jobsite assignment). Header shows **"X of Y submitted"** (site-level `sup_submitted` count). Employee row: name · ✓ once that site is `sup_submitted` · a separate **"Exported" badge** once fully exported (deliberately NOT the same coloured-chip pattern as the supervisor log) · total period hours (all sites) · **failsafe flags** (never submitted · stuck at emp_submitted · out-of-submission punches · unresolved auto-clocks · pending waives) with an **Override** button when the flag is override-eligible (blocked instead if punches need fixing first).
- **NEW — Admin override:** for when **neither** the employee nor the supervisor can act, the admin does both jobs at once — one button pushes a flagged employee's *that-site* row straight to `sup_submitted`. Same clean-punches gate. No audit marker.
- **Export mechanics (the trickiest piece — see rationale below):** readiness is tracked **per site**, but the actual export **fires per employee, all-or-nothing**, only once **every** jobsite that employee worked has reached `sup_submitted`. When it fires, it generates **one full consolidated PDF/Excel file per employee** (all hours, all sites — matching the existing template, which already splits a multi-site employee into column-groups within one sheet) and stamps `exported` on **every one of that employee's site-rows simultaneously**. Stragglers (not yet ready at every site) stay pending and get swept up on a later export click. Per-site export buttons + one all-sites button at the top; both use this same all-or-nothing-per-employee logic, just with a different eligibility filter. Format picker (PDF / Excel Pack) unchanged.
  - *Why not literally per-site partial exports:* first considered, but the payroll Excel template expects one complete file per employee per period — splitting an employee's hours across separate per-site files would mean Brad Rogers could work from partial numbers if he only opened one of the files. Reconsidered mid-build and changed to the all-or-nothing-per-employee approach above.
- **`submissions` table stays** — still used only by the supervisor preview-export's duplicate detection. `pt_timecard_status` is fully separate and is what the admin panel reads.
- Old first-submission-wins submissions-list UI (and its `deleteSubmission()` function) **removed entirely**, replaced by the panel above.

**Known minor limitation (not fixed, low priority):** `openSubmissionsExport()` reuses the Report tab's Excel Pack filename logic, which reads whatever `m-filter-site` / `m-filter-emp` currently hold on the Report tab — so the downloaded zip's filename may not reflect the Submissions-panel scope (data inside the file is still correct either way; this is cosmetic only).

**Bank Hours** (employee requests to bank/draw hours over 88/period) remains **shelved to a future feature** — not part of this v44.0 arc.

---

## 🗂 File Structure

| File | Purpose |
|---|---|
| `index.html` | All UI markup, modals, screens |
| `app.js` | All logic, Supabase calls, state |
| `styles.css` | All styling |
| `payroll-template.js` | **(v40.0)** Embedded base64 blank payroll Excel template, loaded by the Excel-pack export. Auto-generated — do not hand-edit. |
| `CURRENT_STATE.md` | This file — project state tracker |
| `PanoramaTrack_Future_Features.md` | Roadmap / future ideas |

---

## 🗄 Database (Supabase)

**Tables:** `employees`, `jobsites`, `departments`, `activities`, `punches`, `submissions`, `pt_settings`

`pt_settings` (added v36.1, extended v36.2) is a single config row (`id = 1`) holding app-wide pay rules: `rounding_enabled`, `rounding_minutes`, `sched_end_enabled`, `sched_end_time`, `sched_end_window`, `lunch_enabled`, `lunch_minutes`, `lunch_threshold_hours`. Loaded on boot into `APP_SETTINGS`; edited in the master admin Settings tab. Rules are display/export-only — punch rows are never modified.

`punches` columns of note: `employee_id`, `employee_name`, `department`, `jobsite`, `clock_in`, `clock_out`, `activities` (array), `auto_clocked`, `edited_after_auto`, `manual_entry` (bool, added v37.0 — true for punches created/edited via the supervisor/master manual Add-punch flow OR (v41.0) via employee self-edit in My Timecard; surfaces an amber "✎ Manual" badge in the logs either way — no separate flag distinguishes who made the edit), `lunch_waive_requested` + `lunch_waived` (v42.0 — per-shift lunch waive, see below).

**Lunch waive columns (v42.0, SQL run by Julio):**
- `lunch_waive_requested` (bool, `NOT NULL DEFAULT false`) — the employee's "I worked through lunch" tick at clock-out. Always true/false.
- `lunch_waived` (bool, **nullable, no default**) — the supervisor's decision. Three states by design: `NULL` = pending (no decision yet), `true` = approved (skip the lunch deduction for this punch), `false` = denied (keep the deduction). Code must check `=== true` / `IS NULL` explicitly, never truthiness (null and false are both falsy in JS).
- A punch is a **pending waive** when `lunch_waive_requested = true AND lunch_waived IS NULL` — that's the condition surfaced by the needs-review filter, the Needs Review tile, and the supervisor export gate. Helper: `isPendingWaive(entry)` in app.js.

Supervisors are employees with `dept = 'Supervisor'`. Supervisor password stored in `supervisor_password` column. Supervisor jobsite assignments stored in `supervisor_jobsites` (text array).
No separate supervisors table.

---

## ⚠️ Standing Build Rules / Gotchas (read before every build)

- **Dark-mode text color — NEVER rely on the browser default.** The app defaults to dark mode (`body` background is near-black `#000`), but no global rule colors bare text/headings. Any element whose color isn't set by a class or inline style falls back to browser-default **black → invisible in dark mode.** This has bitten us twice now (v40.1 review-gate names, v41.0 My Timecard heading). **Rule going forward: every new text element — headings, `<strong>`, custom spans, dynamically-injected HTML — must get an explicit theme-aware color (`color:var(--txt)` / `--txt2` / `--txt3`), never a hard-coded hex and never nothing.** A global `h1,h2,h3,h4{color:var(--txt)}` fallback was added in v41.0 to catch bare headings, but injected markup and non-heading elements still need explicit colors. Use the `--txt*` vars (they flip per theme automatically); avoid literal `#000`/`#111`/`black`.
- **`position:fixed` bars** rely on `#app` having no `transform`/`filter`/`contain` (which would trap fixed descendants) — keep it that way.
- **Native scrollbars are invisible on mobile/PWA** — use the custom JS scroll-rail pattern (see v39.1), not CSS scrollbar styling.
- **Stale-render races** in async refreshers — guard with a sequence number (e.g. `_supLogSeq`, `_masterLogSeq`).
- **Row-template variables must survive edits.** The log row builders (`refreshMasterLog`/`refreshSupLog`) declare locals (`color`, `si`, `idx`, `hrs`…) just above the `return` template literal. When inserting badges or columns near there, don't delete those `const` lines — a missing one throws `ReferenceError` *inside* the `.map()` and silently blanks the whole table (bit us in v42.0 → fixed v42.2). After editing a row builder, smoke-test that the log still renders rows.

---

## ✅ Features Currently Working

- Employee PIN clock-in / clock-out with jobsite + activity selection
- Auto-clock out at 12 hours (flagged with orange border in logs)
- Supervisor panel: view/edit punches, preliminary & final PDF export
- Master admin panel: manage employees, jobsites, activities, departments
- Pay period logic: bi-weekly, anchored date, with offset support
- Duplicate submission detection (blocks re-submitting a final)
- Archived jobsites panel
- Submissions tracking panel (master admin)
- Dark/light/auto theme toggle (kiosk + persists app-wide)
- PWA manifest + installable on iOS/Android
- PDF export with activity codes (e.g. `41-001 (Interior Steel)`)
- Preliminary export allowed for in-progress periods
- Multi-period view in supervisor log (Today / Yesterday / Current / Last / 2 periods ago)
- Master admin Report tab: same period buttons as supervisor (Today / Yesterday / Current / Last / 2 periods ago), defaults to current pay period on open
- In-app "Backup Now" button (master admin) — downloads JSON of all tables
- Corfix safety reminder — pops up at clock-in if jobsite has a Corfix URL configured
- Jobsite extra fields — address, GC, job number, Corfix URL (editable in master admin)
- **Session persistence across app close/reopen** — supervisors and master admin stay logged in for up to 8 hours (refreshes on activity); stored in `localStorage` so it survives tab close and returning to the app
- **Supervisor permission gating** — a supervisor cannot change another supervisor's kiosk PIN or login password (admin only); they can still change their own and manage regular employees' PINs. UI-level guard (Reset PIN button hidden + PIN field locked + password field hidden when editing another supervisor), with a matching guard in `saveEmployee` against DOM tampering
- **Clickable Live tiles (supervisor panel)** — the three Live stat tiles now jump to the Time log with the right view: Head Count → Today + "still clocked in only"; Yesterday's Head Count → Yesterday; Needs Review → "needs review only" showing ALL outstanding flagged records (period-independent, matches the tile count). Backed by a new filter dropdown on the supervisor Time log (`s-filter-flags`: All records / Still clocked in only / Needs review only)
- **Review gate on supervisor submit** — a supervisor cannot submit a report (preliminary OR final) while any punch in the selected range is still auto-clocked. A blocking modal lists the affected employees + clock-in times; "Review these now" jumps the Time log into the needs-review filter to fix them. The gate clears automatically as each auto-clock is edited to a real clock-out. Master admin export is intentionally NOT gated (admin override) — instead it gets a non-blocking warning (see v40.1 below).
- **Configurable pay rules (master admin Settings tab, v36.1 + v36.2)** — three admin-toggleable rules, all Supabase-backed (shared across devices) and display/export-only (raw punches untouched):
  - **Punch-time rounding** — rounds each clock-in/out to nearest 15 / 6 / 5 min (neutral nearest-mark / 7-8 rule). Default 15 min, off by default.
  - **Paid break-in-lieu credit** — clock-outs within a window (default 15 min) before a scheduled end (default 3:30 PM) are paid to the scheduled end; later punch-outs are never clipped. Off by default.
  - **Unpaid lunch deduction (v36.2)** — subtracts an unpaid lunch (default 30 min) from any shift longer than a threshold (default 5h, deduction applies to shifts *over* the threshold). Off by default. Applied as the final step after credit-then-round. With it enabled, a 7:00–3:30 day now reads **8.0h** (8.5h elapsed − 0.5h lunch). Auto-clocked and estimated punches are left exact, same as the other two rules.
  - Order: credit → round → lunch. Auto-clocked and estimated punches are always left exact. On-screen review tables show RAW times with PAID hours; PDF/CSV exports show ADJUSTED times + paid hours.
- **Manual punch entry (v37.0)** — "+ Add punch" button in both the supervisor and master logs, for an employee who forgot to clock in/out entirely. Reuses the edit modal in an add mode (`openAddPunchModal(ctx)`): employee dropdown (full active roster, alphabetical), clock-in (required), clock-out (optional — covers in-only cases), jobsite, activities. Inserts a new `punches` row with `manual_entry = true`, shown with an amber "✎ Manual" badge in both logs. Both supervisors and master can use it; supervisor scope is the full roster (per Julio's call). NOT included this version (noted for future): overlap guard against double-booking an employee, and a manual marker in CSV/PDF exports.
- **Master admin export — review warning instead of checklist (v40.1)** — the old shared 4-checkbox checklist is gone from the admin export path. `openMasterExportConfirm()` now checks the current filtered log for auto-clocked/unreviewed punches: none found → straight to the PDF/Excel Pack format picker (`#master-format-modal`); some found → a non-blocking warning modal (`#master-review-modal`) showing a count (expandable to the full name + clock-in list), with "Review now" (jumps to the master log's needs-review filter via the existing `goToReport({flags:true})`) or "Export anyway" (secondary/outline-styled override button → proceeds to the format picker). Admin export remains intentionally ungated — this is a heads-up, not a block. Supervisor's checklist/review-gate modal is untouched.
- **Quick-set time buttons on Edit/Add Punch modals (v40.1)** — saves having to pick a date/time for the common case of fixing an auto-clock-out or backfilling a forgotten punch. Edit Punch modal: Clock-out gets two buttons, **3:15 PM** / **3:30 PM**, which stamp that time onto the *same date as the punch's existing clock-in* (correct for fixing an auto-clock from any day, not just today). Add Manual Punch modal: Clock-in gets **Today 7:00 AM** / **Yesterday 7:00 AM**; Clock-out gets **Today 3:15/3:30 PM** / **Yesterday 3:15/3:30 PM** (4 buttons). Implemented as `quickSetEditOut(hh,mm)` and `quickSetAddTime(fieldId,'today'|'yesterday',hh,mm)`; the three button rows (`#out-quickset-edit`, `#in-quickset-add`, `#out-quickset-add`) are toggled by `openEditModal()` / `openAddPunchModal()` since the modal is shared between both flows.
- **My Timecard — employee self-edit (v41.0)** — a new "My Timecard" option on the kiosk screen, beside Clock In / Out, so employees can fix their own forgotten/incorrect punches without going through the supervisor. Employee enters their PIN (same as clock-in) to open `submitTimecardPin()` → `openMyTimecard(emp)`, which lists their punches for the **current pay period only** (`getPeriodByOffset(0)`), pulled fresh from Supabase. They can edit any of the four fields on an existing punch (clock-in, clock-out, jobsite, activities) via `openMyTcEdit(dbId)`, or add a punch they forgot entirely (missing clock-in or clock-out) via `openMyTcAdd()` — a simplified single modal shared between both flows (`#mytc-edit-modal-bg`), not the full supervisor Add-Punch modal. Every self-edit applies **immediately** (no approval queue — the agreed "flagged-but-live" model) and is written with `manual_entry = true`, the same flag supervisors already use, so it surfaces with the existing amber "✎ Manual" badge in the supervisor/master logs — no new flag, no separate before/after audit trail; supervisors follow up with the employee directly if a flagged edit looks off. **Locked once submitted:** if the current period already has a `final` row in `submissions` for that employee, the screen goes view-only (`mytc-locked-note` shown, Add/Edit buttons hidden) — only a supervisor or master admin can touch it from that point. No min/max time-shift guardrail (per Julio's call) beyond staying inside the current period's date range.

---

## 🚧 What Was Last Being Worked On

**Last session date:** July 2, 2026
**Tasks completed this session:**
- **v44.0 Build 3 of 3 — Admin side + schema retrofit. Stamps the version badge/backup payload to v44.0 — the 3-tier submission flow is now complete.** DB migration required (`migration_v44_build3.sql`, provided this session — non-destructive, see the v44.0 section at the top of this doc for the SQL and rationale).
  - **Schema change: `pt_timecard_status` → one row per employee per period PER JOBSITE** (was per employee per period). Discovered mid-design: an employee splitting a period across two jobsites (two different supervisors) would have had their single shared status row conflated by whichever supervisor submitted first. `jobsite` is now part of the unique key and **required** on every write — `setTimecardStage()` now refuses (`{ok:false}`) if called without one.
  - **Data-layer retrofit (`app.js`):** `getTimecardStatus(empId, periodStart, jobsite)` now takes a jobsite and returns one site's row. New `getEmployeeStatusRows(empId, periodStart)` returns ALL of an employee's site-rows for a period. `getAllStatusForPeriod(periodStart)` now returns `{empId: [rows...]}` (array per employee, was a single row). New aggregate helpers `minStage(rows)` / `maxStage(rows)` (least/most-advanced stage across an employee's site-rows) and `isFullyReadyForExport(rows, sitesWorked)` — the last one takes the employee's **worked jobsites** (from punches) as well as their rows, specifically so a worked site with **no row at all** still correctly blocks readiness rather than being silently skipped (caught by the assertion harness this session — see Verified below).
  - **My Timecard retrofit:** `myTcStatus` (single row) → `myTcStatusRows` (array). `openMyTimecard()` loads via `getEmployeeStatusRows`; lock uses `maxStage` (hard-locked once **any** site reaches `sup_submitted`); editable only while zero rows exist. `submitMyTimecard()` now writes **one row per distinct jobsite** in that period's punches (`Promise.all`). `retractMyTimecard()` resets **every** existing site-row back to `open` (re-checks `maxStage` against a fresh fetch first, same "too late" guard as before). Employee-facing UI/copy unchanged — still one Submit button regardless of how many sites they worked.
  - **Supervisor retrofit (`refreshSupLog`, `submitSiteToOffice`):** the per-employee card now computes its stage chip from `minStage` over **only this supervisor's own jobsites** (an employee's rows at other supervisors' sites don't affect this card). `submitSiteToOffice()` / `doSubmitSiteToOffice()` now operate on `{empId, jobsite}` pairs instead of just employee IDs, so a supervisor covering multiple sites can submit independently per site.
  - **NEW — Supervisor "Force Submit" (`forceSubmitEmployee`).** Button appears on an employee's card when they have punches at one of the supervisor's sites but no status row there yet. Fetches fresh punches for that employee/site/period, gates on unresolved auto-clocks / pending waives (alert + block, same wording pattern as elsewhere), confirms, then writes `emp_submitted` for each open site on the employee's behalf. No audit marker — indistinguishable afterward from a normal employee submission.
  - **Admin Submissions panel — full rewrite (`refreshSubmissionsPanel` + new functions), replaces the old first-submission-wins list.** Reads `pt_timecard_status` instead of `submissions` (that table is now supervisor-preview-only, untouched by this panel).
    - **Period selector** (`setSubPeriod`/`subStatusPeriod`, Current/Last) — added specifically because the same period-rollover issue flagged in Build 2 applies here too.
    - **Jobsite accordions** (reuses the existing `emp-card`/`toggleEmpCard` pattern). An employee can appear under **every** jobsite they logged hours at that period — there's no fixed employee→jobsite assignment in this data model (jobsite lives on the punch, not the employee), and Julio confirmed multi-site employees should show at each site rather than being forced under one "primary" one.
    - Header: **"X of Y submitted"** per site (site-level `sup_submitted+` count).
    - Employee row: name → **✓** once that site is `sup_submitted`, plus a separate **"Exported" badge** once fully exported (deliberately a different visual treatment than the supervisor log's coloured chip, per Julio) → total period hours (**all sites**, via `paidHours`) → failsafe flags with inline **Override** button (or "Fix punches first" if blocked).
    - **Failsafe flags:** never submitted (only flagged once the period's ended — suppressed on an in-progress "Current" period to avoid noise) · stuck at `emp_submitted` · out-of-submission punches (per-site match, not a shared row) · unresolved auto-clocks · pending lunch waives.
    - **NEW — Admin override (`adminOverrideSite`).** For when neither the employee nor supervisor can act — pushes that employee's *this-site* row straight to `sup_submitted` (standing in for both steps). Same clean-punches gate as Force Submit. No audit marker.
    - **Export (`openSubmissionsExport`, per-site buttons + one all-sites button at top).** Eligibility = `isFullyReadyForExport` (every jobsite the employee worked is `sup_submitted`) — genuinely all-or-nothing per employee, not per site. Fetches that employee's full-period punches (all sites), points the existing `_masterLogs` + Report-tab date fields at this scoped set (see the new `_pendingExportStampFn` comment in `app.js` for why `_masterLogs` has to be set directly — `masterExportRange.logs` turned out to be dead code, since `_masterLogs` is initialized to `[]`, which is truthy, so the `_masterLogs || masterExportRange.logs` fallback could never actually reach the fallback), then opens the **same PDF/Excel format picker** the Report tab uses. On completion, `doMasterExcelZip()`/`generateMasterPDF()` call the pending stamp callback, which writes `stage='exported'` to **every** row for each included employee (all their sites at once) and refreshes the panel. Stragglers not yet ready anywhere stay pending for a later export click.
    - **Design pivot during this build:** per-site partial exports (only that site's hours) were the initial plan, but the Excel Pack template expects **one complete file per employee per period** — a multi-site employee split across separate per-site files risked Brad Rogers working from partial numbers. Changed to all-or-nothing-per-employee before writing any export code.
  - **Removed:** the old `refreshSubmissionsPanel` (read `submissions`, grouped by period, "first-submission-wins" framing) and `deleteSubmission()` — both fully replaced, no longer referenced anywhere.
  - **Files changed:** `app.js` (data layer, My Timecard, supervisor retrofit + Force Submit, full Submissions panel rewrite + admin override + export; version badge → v44.0), `index.html` (version badge → v44.0; `#mpanel-submissions` replaced — period buttons, all-sites export button, `#submissions-list` container; old period/supervisor filter selects removed). **No** `styles.css` / `payroll-template.js` change — new UI is inline-styled with existing theme vars (`--amber`/`--amber-l`/`--blue-l`/`--blue-d`/`--green`, all confirmed already defined). **Migration required** — see `migration_v44_build3.sql`.
  - **Known minor limitation (cosmetic only, not fixed):** the Excel Pack zip filename (built in `doMasterExcelZip` from `m-filter-site`/`m-filter-emp`) reads whatever the Report tab's own filter dropdowns currently hold, since both features share those DOM fields. The exported *data* is always correctly scoped to the Submissions-panel selection regardless — only the filename text could look off if the Report tab has filters set. Low priority; flagged for a future polish pass if it bothers Julio in practice.
  - **Post-delivery fix:** the constraint-lookup `DO` block in `migration_v44_build3.sql` originally failed with `operator does not exist: information_schema.sql_identifier[] = text[]` — `array_agg(kcu.column_name ...)` returns `sql_identifier[]`, which has no direct `=` against a `text[]` literal even though each element casts individually. Fixed by casting inside the aggregate: `array_agg(kcu.column_name::text ORDER BY kcu.column_name)`. Migration file re-delivered with the fix; the rest of the migration (and all of Build 3's app code) was unaffected.
  - **Verified:** `node --check` clean on `app.js`; HTML div-balance delta unchanged from baseline (pre-existing +1, not introduced by this build); a 19-assertion logic harness (extracted the pure stage/readiness functions in isolation) covered `minStage`/`maxStage` aggregation, `isOutOfSubmission` per-site matching, and — the one real bug this caught before it shipped — `isFullyReadyForExport` incorrectly treating a worked-but-never-submitted jobsite as "not blocking" when only checking existing rows; fixed by passing the employee's worked jobsites in alongside their rows.

**Last session date:** July 2, 2026
**Tasks completed this session:**
- **v44.0 Build 2 of 3 — Supervisor side.** Middle slice of the 3-tier flow. Version badge/backup-payload still **v43.0** (Build 3 stamps v44.0). No DB migration (uses the Build 1 `pt_timecard_status` table + helpers). No `styles.css` / `payroll-template.js` change — new chips/badges/blocks are inline-styled with theme vars.
  - **Per-employee stage colours in the supervisor time log (`refreshSupLog`) — Option A.** One `getAllStatusForPeriod(supStatusPeriod().start)` call per refresh, re-guarded by the existing `_supLogSeq` sequence number (a second race-check added after the extra async call). Each employee card now carries a **stage chip** next to the name + a **left-border accent**, via new `supStageChip(stage)`:
    - **grey "Not submitted"** (open / no row) → **amber "✓ Submitted — review"** (emp_submitted) → **green "✓ Sent to office"** (sup_submitted / exported). Deliberately grey→amber→green (distinct hues) rather than the near-identical blue/green in this palette.
  - **Out-of-submission surfacing (`isOutOfSubmission`, defined in Build 1, now wired).** Per-row "⚠️ After submit" badge on any punch whose clock-in is newer than the employee's `emp_submitted_at`, plus an "N ⚠️ after submit" count in the card summary line — flags employees who worked after handing in their card (no re-submit required from them).
  - **New helper `supStatusPeriod()`** — maps the log's period mode to the stage period: `last`→offset 1, `prev2`→offset 2, everything else (`today`/`yesterday`/`current`)→offset 0 (the in-progress period employees submit against). Used by both the colours and the site-submit action so they always agree.
  - **Site-wide "Submit site to office" action.** New primary block at the bottom of the Log tab (above the demoted preview export), with a period label (`#s-submit-period-label`, set in `setSupPeriod`) and a live "N ready to send · N already sent · N not submitted" summary (`#s-submit-summary`, updated by `updateSubmitSummary()` at the end of every `refreshSupLog`, counted over the shown employees).
    - `submitSiteToOffice()` runs an **authoritative period-scoped pass independent of the display filter**: queries punches at the supervisor's assigned jobsites within `supStatusPeriod()`, builds the roster, then moves every employee at `emp_submitted` → `sup_submitted`. `open` employees are left untouched (stragglers stay for a later pass); already-`sup_submitted` are skipped (idempotent). Confirm dialog states how many will be sent and how many stay open; empty-state alerts ("no submitted timecards yet"). `doSubmitSiteToOffice()` does the writes via `Promise.all` of `setTimecardStage(id, period, SUP, jobsite)` (jobsite preserved from the emp-submit stamp), reports any failures, then `refreshSupLog()` repaints (submitted employees flip to green). This is what **hard-locks** those employees' My Timecard (Build 1 keyed the lock off stage ≥ `sup_submitted`).
    - **Period-anchor decision flagged for Julio** — see the "⚠️ One decision made in Build 2" note in the v44.0 section above. Anchored to the viewed period (not hard-wired "current") to avoid missing a just-ended period after the offset rolls.
  - **Supervisor PDF export demoted to a preview tool.** Wording-only — **all machinery intact** (`openExportConfirm` / review-gate / est-clockout / dup-check / checklist / `generatePDF` / `doExport`, and the `submissions`-table writes that the future admin preview-export dup-detection relies on). Relabels: export section header → "Preliminary export (preview)" with a subtext saying the office finalizes; the export button demoted from `btn-primary` to a neutral outline `btn` and relabelled ("Preview PDF →" / "…(partial)" / "…(preliminary)" in `setSupPeriod`); confirm-modal title/subtext/submit-button → preview framing (`openChecklist` + `closeConfirmModal` + the static defaults in `index.html`); **chk4** reworded from "…sent to head office and cannot be recalled" → "…this PDF is a preview for my own use — the official payroll export is finalized by the office"; chk3 softened to "look accurate for my review"; prelim-banner button "Review & submit final →" → "Review timecards →".
  - **Files changed:** `app.js` (new `supStatusPeriod`/`supStageChip`/`updateSubmitSummary`/`submitSiteToOffice`/`doSubmitSiteToOffice`; `refreshSupLog` stage fetch + chips + out-of-submission badges + summary; `setSupPeriod` button relabels + submit period label; `openChecklist`/`closeConfirmModal` relabels), `index.html` (Submit-to-office block + demoted preview block in `#spanel-log`; export-confirm-modal defaults + chk3/chk4 wording; prelim-banner button). Version strings untouched (still v43.0).
  - **Verified:** `node --check` clean on `app.js`; HTML div balance preserved (delta unchanged from the pre-edit file). **Standing-rule checks:** all new injected text uses theme-aware colours (chips are explicit bg+colour pills); the `refreshSupLog` row-builder locals (`idx`, `ph`, `hrs`, and the new `statusRow`/`stage`/`chip`/`oos`) are all declared above their template literals — smoke-test that the supervisor log still renders rows after deploy.

- **v44.0 Build 1 of 3 — Data layer + Employee submission side (My Timecard).** First slice of the 3-tier submission flow (see the "v44.0 IN PROGRESS" section at the top of this doc for the full design). Version badge/backup-payload intentionally **left at v43.0** — Build 3 stamps v44.0.
  - **Data layer (`app.js`) — the single source of truth for the whole flow.** New `pt_timecard_status` helpers near the engine helpers (just after `isPendingWaive`):
    - `TC_STAGE` constant (`OPEN/EMP/SUP/EXPORTED` → the string values) + `TC_STAGE_RANK` (0–3, for at-or-past comparisons).
    - `getTimecardStatus(empId, periodStart)` → one employee's status row for a period (`maybeSingle`); `null` = open.
    - `getAllStatusForPeriod(periodStart)` → all rows for a period as a `{empId: row}` map (for Build 2 supervisor colors + Build 3 admin panel).
    - `setTimecardStage(empId, period, stage, jobsite)` → upsert on `(employee_id, period_start)`, stamps the matching `*_submitted_at` / `exported_at` timestamp. Returns `{ok, error}`.
    - `stageOf(row)` (null row → `'open'`), `stageAtLeast(stage, target)`.
    - `isOutOfSubmission(entry, statusRow)` → true if a punch's clock-in is newer than `emp_submitted_at` while stage ≥ `emp_submitted` (the "worked Saturday after submitting Friday" supervisor flag; detected at query time, no extra column). **Wired into UI in Build 2.**
    - `myTcRunningHours(punches)` → `{hours, pendingWaiveCount}`. Sums `paidHours` over **completed** punches only (skips still-in), and **optimistically treats a pending lunch waive as approved** (temporarily flips `lunchWaived` for the calc, then restores — never mutates the real record). Approved/denied waives already flow through `paidHours` normally.
  - **My Timecard — running-hours total (`#mytc-total`).** New `renderMyTcTotal()` shows "Hours accumulated this period" using `myTcRunningHours`, with a small disclaimer line: "Excludes N punches still clocked in." and/or "Includes N pending lunch waives — final hours may be lower if your supervisor denies…". Uses the rounding/deduction engine (via `paidHours`), excludes active punches, includes pending waives optimistically — exactly per Julio's spec.
  - **My Timecard — submit / pull-back bar (`#mytc-submit-bar`, at the very top).** New `renderMyTcSubmitBar()` renders one of three states off the stage:
    - **open** → green "Submit my timecard →" button.
    - **emp_submitted** → green "✓ Timecard submitted" panel with a **"Pull back"** button.
    - **sup_submitted+** → grey "✓ Submitted & locked" status, no actions.
    - `submitMyTimecard()` — **auto-clock gate** (blocks + alert pointing them to Edit the offending punch(es); does NOT proceed); then a **before-period-end caution** via `showCustomConfirm` ("Submit before the period ends?") vs. a **clean submit after**; writes `stage='emp_submitted'` (with the most-recent punch's jobsite for admin grouping), then reloads the modal. Guarded against double-tap (`myTcBusy`).
    - `retractMyTimecard()` — re-checks the DB stage first (in case the supervisor just submitted → "Too late to pull back"), else writes `stage='open'` and reloads.
  - **My Timecard — lock rework.** `openMyTimecard()` no longer checks `submissions` for a `final` row. It now loads the stage via `getTimecardStatus`:
    - `myTcLocked` = stage ≥ `sup_submitted` (hard view-only; `#mytc-locked-note` shown, Add hidden).
    - `myTcEditable` = stage is exactly `open` (new flag). At `emp_submitted`, Add/Edit are **disabled** — a hint line tells the employee to pull back first (makes "submitted" a real handoff). `openMyTcAdd()` / `openMyTcEdit()` / the per-row Edit button now gate on `myTcEditable` (was `myTcLocked`).
  - **State vars added:** `TC_STAGE` / `TC_STAGE_RANK` (consts), `myTcStatus`, `myTcBusy`, `myTcEditable`. All reset in `closeMyTimecard()`.
  - **What Build 1 does NOT do yet (comes in Builds 2–3):** supervisors/admins can't yet *act* on submissions — no status colors, no site-submit, no admin panel rework. An employee submitting today simply writes a `pt_timecard_status` row and gets the submitted/locked UX; nothing downstream breaks. `isOutOfSubmission` is defined but not yet surfaced (Build 2).
  - **Files changed:** `app.js` (all the above), `index.html` (`#mytc-submit-bar` + `#mytc-total` at the top of `#screen-mytc`). **No** `styles.css` / `payroll-template.js` change. **No new migration** (the `pt_timecard_status` table was already created by Julio before this build). Version strings untouched (still v43.0).
  - **Verified:** `node --check` clean; 17-assertion logic harness passed (stage ranking, out-of-submission detection, running-hours with active-punch exclusion + optimistic/approved/denied waive handling + no-mutation guard); HTML div balance preserved.

- **v43.0 — UI: employee lists → accordion (mobile fix) + activities alphabetical:** Batch of three UI changes agreed one at a time before build.
  - **Employee lists converted to accordion (Admin + Supervisor panels).** The old 5-column tables overflowed on mobile — the Deactivate/Reset-PIN action buttons in the last column were pushed off-screen with no horizontal scroll. Both panels now use the existing punch-log accordion pattern (`emp-card` / `emp-card-header` / `emp-card-body` + `toggleEmpCard()`). Collapsed header shows **Name + PIN**; expanded body shows Dept, assigned jobsites (supervisors only, Admin panel), and the action buttons. Removed the `<table>` markup for both; new containers `#s-emp-accordion` (supervisor) and `#m-emp-accordion` (admin). Rewrote `refreshSupEmps()` and `refreshMasterEmps()`.
  - **Deactivate → "Remove" with hide-on-remove (Option B).** Chose to keep the DB `active` flag (no true DELETE — protects historical punch rows that reference `employee_id`) but change the UX so removed employees don't clutter lists. **Supervisor panel:** shows active employees only. **Admin panel:** shows active employees first, then a "Removed employees" section with those cards greyed-out (`opacity:.55`) and an **Activate** button to bring them back — so Admin retains a re-activation path with no DB surgery. The button on active employees is renamed **Remove** (was "Deactivate"); `toggleEmpActive()` unchanged in logic (sets `active=false/true`), now also refreshes the supervisor accordion if present. No DB migration.
  - **Activities listed alphabetically (Option A — everywhere).** Was sorted by `sort_order`. Now sorted by `name` (`localeCompare`) in: the admin Activities panel (`refreshActivitiesPanel`), the clock-out activity picker (`renderActList`), the supervisor/master edit-punch grid (`openEditModal`'s `edit-act-grid`), and the My Timecard grid (`buildMyTcActGrid`). Because ordering is now alphabetical, the admin panel's **↑/↓ reorder buttons and the position-number column were removed**; `moveActivity()` is now dead code (function left in place, no callers) and the `sort_order` column is retained but ignored for display (`addActivity` still stamps one — harmless). No DB migration.
  - **Files changed:** `index.html` (both employee tables → accordion `<div>`s; version badge → v43.0). `app.js` (`refreshSupEmps`, `refreshMasterEmps`, `toggleEmpActive`, `refreshActivitiesPanel`, `renderActList`, `buildMyTcActGrid`, `openEditModal` grid; backup payload → v43.0).
  - **Note:** the earlier v42.3 dark-mode settings-label fix (below) is already folded into this same delivery.

- **v42.3 — Bugfix: settings panel checkbox labels invisible in dark mode:** The three `<label>` elements in the admin Settings panel (Punch-time rounding, Paid break-in-lieu, Unpaid lunch deduction) had `font-weight:600` but no `color`, so they fell back to browser-default black — invisible against the dark background. Fixed by adding `color:var(--txt)` to all three label elements. `index.html` only.

**Last session date:** June 30, 2026
**Tasks completed this session:**
- **v42.2 — Bugfix: admin reporting log rendered nothing (regression from v42.0):** The master reporting log showed no rows for any filter/date range. Cause: the v42.0 edit that added the 🍴 lunch-waive badges to `refreshMasterLog()` accidentally deleted the adjacent line `const si=JOBSITES.indexOf(l.jobsite);const color=si>=0?getSiteColor(si):'#555';`. The row template still referenced `${color}` for the jobsite stripe, so each row threw `ReferenceError: color is not defined` *inside* the `.map()` callback, which aborted the whole `tbody.innerHTML` assignment → empty table. Filters/dropdowns/date logic were never affected; only row rendering. Fix: restored the one deleted line right before the row `return`. `app.js` only.

**Last session date:** June 30, 2026
**Tasks completed this session:**
- **v42.1 — Lunch waive toggle moved to top of activities list:** Contained UI tweak. The "I worked through lunch" toggle card (`#lunch-waive-row`) now sits *above* `#act-list` instead of below it, so it's the first thing seen on the clock-out screen. `margin-top:14px` → `margin-bottom:14px` for correct spacing above the list. No JS change — the custom scroll-rail math (`updateActScroll`) reads total page scroll height regardless of element order, so it's unaffected. `index.html` only (+ this doc).

**Last session date:** June 30, 2026
**Tasks completed this session:**
- **v42.0 — Per-shift lunch waive (worked-through-lunch request + supervisor approval):** Closes the last piece of the lunch arc. Automatic lunch deduction (v36.2) docks 30 min from any shift over 5h; this lets an employee who genuinely skipped lunch and left early request that the deduction be waived — but as a *request the supervisor approves*, never an auto-apply, so there's no standing daily incentive for 50–100 people to claim free time.
  - **Design (all confirmed with Julio before build, one question at a time):**
    1. **Two flags, not one.** `lunch_waive_requested` = the employee's ask; `lunch_waived` = the supervisor's decision. Request ≠ approval.
    2. **`lunch_waived` is a nullable boolean** (null/true/false = pending/approved/denied) rather than a separate status column — same three states, one column, `paidHours` still checks a plain boolean. Chosen over an enum because the states won't multiply.
    3. **Capture = always-visible toggle on the clock-out (activity) screen**, no popup, no threshold gating the prompt. Employee ticks "I worked through lunch (no break taken)" → sets `lunch_waive_requested=true`. Threshold is handled downstream: an approved waive on a short shift simply has nothing to subtract.
    4. **Approval = per-punch approve/deny in the edit modal**, surfaced via the **export gate** (not a standalone review screen). The gate — previously triggered only by unresolved auto-clocks — now also blocks on pending waives, listing both kinds.
    5. **Bulk "Approve all for [Name]"** inline in the export-gate modal (common case: someone worked through lunch all period). **Denial stays individual** (more scrutiny) — done one-at-a-time via "Review these now" → edit modal.
    6. **Needs-review filter + Needs Review tile** now catch pending waives in addition to auto-clocks, so "Review these now" lands on a combined list and the tile count matches.
  - **DB migration (Julio ran before build):** `ALTER TABLE punches ADD COLUMN lunch_waive_requested boolean NOT NULL DEFAULT false;` and `ADD COLUMN lunch_waived boolean;` (nullable, no default). Existing rows: requested=false, waived=null — so none are caught by the gate. No backfill.
  - **Engine:** `paidHours()` skips the lunch deduction only when `entry.lunchWaived===true` (explicit `===`, not truthiness — null/false both keep the deduction). New `isPendingWaive(entry)` helper (`requested===true && waived==null`) is the single source of truth for the gate, filter, and tile. `dbRowToEntry()` maps both columns (`lunchWaiveRequested`, `lunchWaived`).
  - **Capture:** new `#lunch-waive-row` toggle card on `#screen-activity` (at the top of the activities list, above `#act-list`, visually set apart); `lunchWaiveRequested` global + `toggleLunchWaive()`; reset in `showActivityScreen()`; written in `confirmClockOut()` alongside the activities/clock-out update.
  - **Approval UI:** `#edit-waive-wrap` block in the shared edit modal, shown only when the punch carries a request (`setupEditWaive(entry)`); Approve/Deny buttons (`setEditWaive(bool)` → `_editWaiveDecision`, rendered by `_renderEditWaive()`); persisted in `saveEdit()` only when a decision was made this session (`_editWaiveDecision!==null`). Hidden in Add-Punch mode.
  - **Surfacing:** status chips (🍴 Waive pending / Waived / Waive denied) added to both supervisor and master log rows; supervisor per-employee summary gained a pending-waive count; supervisor needs-review query (`refreshSupLog` `review` branch) and Needs Review tile (`refreshSupLive`) extended with an `.or(...)` / second count for pending waives.
  - **Export gate:** `openExportConfirm()` now collects `pendingWaives` alongside `needsReview` and blocks if either is non-empty. `showReviewGate(autoList, waiveList)` rewritten with two labeled sections; waives grouped by employee with an "Approve all" button → `approveAllWaivesFor(empId)` (bulk `lunch_waived=true`, heals memory, then re-runs `openExportConfirm()` so the gate clears or advances). Master export path remains intentionally ungated (badges only).
  - **Files changed:** `index.html` (lunch-waive toggle on `#screen-activity`; `#edit-waive-wrap` approve/deny block in edit modal; restructured `#review-gate-bg` into auto + waive sections; version badge → v42.0). `app.js` (`dbRowToEntry`, `paidHours`, new `isPendingWaive`/`toggleLunchWaive`/`setupEditWaive`/`_renderEditWaive`/`setEditWaive`/`approveAllWaivesFor`; `showActivityScreen`, `confirmClockOut`, `openEditModal`, `openAddPunchModal`, `saveEdit`, `refreshSupLog`, `refreshSupLive`, `refreshMasterLog`, `openExportConfirm`, `showReviewGate`; `lunchWaiveRequested`/`_editWaiveDecision`/`_reviewGateWaives` state; backup payload → v42.0).
  - **Note / to verify in testing:** `approveAllWaivesFor()` re-runs `openExportConfirm()` after writing, which re-fetches fresh logs so the gate either clears or advances to the next step. Confirm that flow feels right in practice.
  - **Scope deliberately left out:** the lunch-waive toggle is on the main clock-out screen only — it is NOT surfaced in the v41.0 "My Timecard" employee self-edit path (would be scope creep; not discussed). If an employee edits a punch in My Timecard, the waive flags are left as they were.

**Last session date:** June 30, 2026
**Tasks completed this session:**
- **v41.0 — My Timecard: employee self-edit of their own punches:** Too many employees were forgetting to clock in or out entirely, and chasing every one down was overloading the supervisor. This adds a new self-service path so employees can correct their own punches directly, scoped tightly enough to keep the existing supervisor-policing model intact.
  - **Design (confirmed with Julio before build):** employees can edit only their own punches, and only within the **current pay period** — once that period has a final submission on record, only a supervisor/master admin can touch it from then on. Edits **apply immediately** (flagged-but-live, not a request/approval queue, matching Julio's call). All four punch fields are editable (clock-in, clock-out, jobsite, activities), including adding a punch the employee forgot entirely. No before/after value is retained — the supervisor follows up directly with the employee if a flagged edit looks off. No min/max time-shift guardrail beyond staying inside the current period.
  - **Access:** a new **"My Timecard"** button sits beside the existing "Clock In / Out" button on the kiosk screen. Employee enters their PIN (same PIN pad, same lookup as clock-in) → `submitTimecardPin()` → `openMyTimecard(emp)`.
  - **Screen (`#screen-mytc`):** lists the employee's own punches for the current pay period only, queried fresh from Supabase each time (not from the in-memory `timeLog`, which only caches open punches). Each punch shows date, jobsite, in/out times, activities, and the existing "In" / "✎ Manual" / "Auto-clocked" badges. A "+ Add a missed punch" button sits above the list.
  - **Editing:** reuses a dedicated, simplified modal (`#mytc-edit-modal-bg` — separate from the supervisor/master `#edit-modal-bg` to avoid entangling employee-permission logic with that modal's existing add/edit/admin branches) for both "edit an existing punch" (`openMyTcEdit(dbId)`) and "add a missed punch" (`openMyTcAdd()`). Saving validates clock-out > clock-in and that both timestamps fall inside the current pay period, then writes with **`manual_entry = true`** — intentionally reusing the existing flag rather than adding a new one, so self-edits surface with the same amber "✎ Manual" badge supervisors already watch for in the supervisor/master logs (per Julio's call — no separate audit flag).
  - **Submission lock:** on opening "My Timecard", queries `submissions` for a `status = 'final'` row for that employee overlapping the current period (same overlap check the export duplicate-detection already uses). If found, the screen goes view-only — `#mytc-locked-note` is shown and the Add/Edit buttons are hidden.
  - **Open-punch consistency:** if an employee uses this to add their own missing clock-out, the in-memory `timeLog` cache on that device is updated/closed too, consistent with how the existing supervisor `saveEdit()` keeps memory and DB in sync.
  - **Roadmap impact:** this took the v41.0 slot that had been earmarked for the per-shift lunch-waive feature — that feature is now pushed to **v42.0** (see updated roadmap section below).
  - **Files changed:** `index.html` ("My Timecard" button + `#screen-mytc` + `#mytc-edit-modal-bg` markup; version badge). `app.js` (new `submitTimecardPin()`, `openMyTimecard()`, `closeMyTimecard()`, `renderMyTcList()`, `openMyTcAdd()`, `openMyTcEdit()`, `buildMyTcActGrid()`, `toggleMyTcAct()`, `closeMyTcEditModal()`, `saveMyTcEdit()`; new state vars `myTcEmp`/`myTcPeriod`/`myTcPunches`/`myTcLocked`/`myTcEditingDbId`/`myTcAdding`/`myTcEditActs`; backup payload version). No DB migration needed — reuses the existing `manual_entry` column.
  - **Post-build fix 1 — blank screen on load:** the new `#mytc-edit-modal-bg` modal was accidentally nested *inside* the still-open existing `#edit-modal-bg` modal, leaving two `<div>`s unclosed and breaking the whole DOM render. Fixed by closing the Edit Punch modal before opening the My Timecard modal (siblings, not nested). `index.html` only.
  - **Post-build fix 2 — black/unreadable heading in dark mode:** the My Timecard screen `<h2>` (`#mytc-name`) had no color rule and fell back to browser-default black, invisible on the dark background (same class of bug as the v40.1 review-gate names). Fixed by (a) adding a global `h1,h2,h3,h4{color:var(--txt)}` fallback in `styles.css` so no bare heading can hit this again, and (b) setting `color:var(--txt)` inline on `#mytc-name`. Also logged as a **standing build rule** in the new "Standing Build Rules / Gotchas" section near the top of this doc — all future text elements must get an explicit theme-aware color, never browser default. `styles.css` + `index.html`.


**Last session date:** June 25, 2026
**Tasks completed this session:**
- **v40.1 — Admin export checklist removed + review warning, dark-mode fix, needs-review race fix, quick-set time buttons:** A bundle of contained UI/bugfix tweaks, no structural changes.
  - **Master admin export — checklist replaced with a conditional warning.** The shared 4-checkbox checklist (`chk1`–`chk4`) that the master export path borrowed from the supervisor submit flow is gone. `openMasterExportConfirm()` now checks `_masterLogs` for any `autoClocked` records: if none, it jumps straight to the format picker (no extra modal at all — fewer clicks than before); if some exist, a new dedicated warning modal (`#master-review-modal`) shows a count (expandable via "Show details" to the full name + clock-in list, same data shape as the supervisor review-gate), with **Review now** (`masterReviewGoNow()` → reuses the existing `goToReport({flags:true})` to jump the master log into the needs-review filter) and **Export anyway** (styled as a secondary/outline button — a deliberate override, not the default next-step) → proceeds to a new dedicated format-picker modal (`#master-format-modal`, just the PDF/Excel Pack buttons, no checkboxes). Admin export stays intentionally ungated per existing design — this is a heads-up, not a block. Built as fully separate modals/functions from the supervisor's `#export-confirm-modal` so the supervisor checklist + blocking review-gate are completely untouched.
  - **Dark mode fix — review-gate employee names were invisible.** In `showReviewGate()`, the employee `<strong>` name had no explicit text color; nothing further up the DOM chain sets `color` either (`body{}` only sets background), so it fell back to the browser default (black) — invisible against the dark theme's near-black background. Fixed by adding `color:var(--txt)` directly on the `<strong>`. Same pattern was used for the new master review-warning list to avoid the same bug there.
  - **"Review these now" — fixed a stale-render race.** `goToSupReport('review')` calls `switchSupTab('log')`, which (via `initLogDates()`) resets the filter dropdown to default and kicks off its own `refreshSupLog()` call *before* the caller sets the filter to `'review'` and fires a second one — two competing async calls updating the same DOM, whichever resolves last wins. Fixed with a sequence-number guard (`_supLogSeq`): each call captures its own sequence number and only renders if it's still the latest one when its data arrives; any older, now-superseded call's results are silently dropped instead of overwriting the correct list. Also removed a redundant duplicate `refreshSupLog()`/`updateExportPreview()` call that `switchSupTab('log')` was firing on top of the one already triggered inside `initLogDates()` — that redundancy existed on every normal "Log" tab click too, not just this path. Applied the same `_masterLogSeq` guard to `refreshMasterLog()` for consistency, since the new "Review now" button on the master side reuses the identical `switchMasterTab('log')` → override filter → refresh pattern.
  - **Quick-set time buttons — Edit Punch & Add Manual Punch modals.** Saves picking a date/time by hand for the common case of fixing an auto-clock-out or backfilling a forgotten punch (these two modals share the same `#edit-in`/`#edit-out` fields). Edit Punch: Clock-out gets **3:15 PM** / **3:30 PM** buttons (`quickSetEditOut(hh,mm)`), which stamp that time onto the *same date as the punch's current clock-in value* — correct for fixing an auto-clock from any day, not just today. Add Manual Punch: Clock-in gets **Today 7:00 AM** / **Yesterday 7:00 AM**; Clock-out gets **Today 3:15 PM** / **Today 3:30 PM** / **Yesterday 3:15 PM** / **Yesterday 3:30 PM** (`quickSetAddTime(fieldId,'today'|'yesterday',hh,mm)`). The relevant button rows are toggled by `openEditModal()` (shows the 2-button edit row, hides both add-mode rows) vs. `openAddPunchModal()` (shows both add-mode rows, hides the edit row), since the modal is shared between the two flows. Existing `newOut<=newIn` / `aOut<=aIn` validation at save time already catches an inverted shift if mismatched buttons are clicked, so no extra guard was needed.
  - **Files changed:** `index.html` (removed `#master-format-picker` from `#export-confirm-modal`; added `#master-review-modal` + `#master-format-modal`; added quick-set button rows to the edit/add-punch modal; version badge). `app.js` (rewrote `openMasterExportConfirm()` + new `showMasterReviewWarning()`/`toggleMasterReviewList()`/`closeMasterReviewModal()`/`masterReviewGoNow()`/`masterReviewExportAnyway()`/`showMasterFormatModal()`/`closeMasterFormatModal()`; removed checkbox checks from `doMasterExcelZip()`; redirected its and `generateMasterPDF()`'s closing call to `closeMasterFormatModal()`; removed stale `master-format-picker` reference from `closeConfirmModal()`; `showReviewGate()` color fix; `_supLogSeq`/`_masterLogSeq` guards in `refreshSupLog()`/`refreshMasterLog()`; removed redundant call in `switchSupTab()`; new `quickSetAddTime()`/`quickSetEditOut()`; toggling added to `openEditModal()`/`openAddPunchModal()`; backup payload version).


- **v40.0 — Excel Pack export (one .xlsx per worker, zipped) — replaces the master CSV export:** A second master-admin export format that produces the GM's payroll timesheet, pre-filled, instead of the old flat CSV. The GM's downstream process is one Excel sheet per worker per pay period, so this generates one `.xlsx` per worker (matching the uploaded `Payroll_output_Sheet` template exactly — borders, legend, accounting block, `Brad Rogers`, and all pre-built K-column/Total formulas preserved) and bundles them into a single `.zip` for download. Built with **ExcelJS** (jsPDF can't write formatted Excel; SheetJS-free can't write styling) + **JSZip**, fully client-side. Approach: the blank template is embedded as base64 (`payroll-template.js`); for each worker the app reloads a fresh copy, drops values into mapped cells, and writes it back — so the GM's formatting/formulas survive untouched.
  - **Design (all confirmed with Julio before build):** scope = whatever the master log is filtered to (site/employee/date); one sheet per employee per pay period; up to 3 jobsites per week-block, up to 6 across the two weeks (week 2 can differ); each day = 2 rows for up to 2 activities with **hours split ½/½** when 2 codes (full hours on row 1 when 1 code); Job# header = the jobsite's manually-entered abbreviated name+code (`jobsites.job_number`), fallback to the site name; OT ignored; accounting summary left blank (head office).
  - **Filenames:** zip = `[Filter] - [PayPeriodEnd].zip` where Filter is the active jobsite and/or employee filter (`Site - Employee`, or just one, or `All Records` when unfiltered); each inner file = `Employee Name - [PayPeriodEnd].xlsx`. Period end = the master log "to" date; H3 (pay-period date) = the "from" date.
  - **Cell map (per sheet):** B3 name · H3 period start · B5/E5/H5 (wk1) & B24/E24/H24 (wk2) job headers · day grid rows 8–21 (wk1) / 27–40 (wk2), Sun→Sat, 2 rows each · Code/Hrs columns C/D (job1), F/G (job2), I/J (job3). Stray Julio leftovers in the "blank" template (`D43=71.5`, `G43=0` — values, not formulas) are reset at write time to `=D22+D41` / `=G22+G41` so the ST total is correct on every sheet.
  - **Overflow:** an employee with 4+ jobsites in a week gets a second file (` (2)` suffix), jobs chunked 3-per-sheet — no data dropped. Export-time notif reports how many workers hit this.
  - **Edge cases handled:** 3+ activity codes at the *same* jobsite on the *same* day (the parked GM question) → first code on row 1, the rest slash-joined on row 2, hours ½/½; logged to console. Still-clocked-in punches are skipped (no hours yet). Punches outside the 14-day grid are skipped + logged.
  - **⚠️ Known caveats flagged to Julio (not yet resolved):** (1) **Employee code (B2) is blank** — the `employees` table has no code field (`JG001`-style); B2 is wired but left empty until a code field is added or head office fills it. (2) **OT cells** — the template's OT total formulas sum the *second* row of each day; since ½-split now puts hours on row 2, the OT cells will read non-zero on any 2-activity day. Left untouched per "ignore OT"; can be neutralized to 0 on request. (3) The template was **converted .xls→.xlsx** (required — ExcelJS can't read legacy .xls); eyeball the first real export against the GM's original. (4) H3 holds the period *start date* and overwrites the "Pay Period" placeholder text, per Julio's instruction.
  - **Files changed:** `index.html` (ExcelJS+JSZip+template `<script>` tags, CSV button → Excel-pack button, version badge), `app.js` (removed `doMasterExport` CSV fn; added `doMasterExcelZip()` + helpers `_xlB64ToU8`/`_xlSanitize`/`_xlNumericCode`/`_xlRound2`; backup payload version), **new** `payroll-template.js` (embedded base64 blank template).

- **v39.1 — Custom scroll rail + tappable arrows on the activity screen:** The v39.0 full-screen checklist removed the dropdown, but Julio still wasn't getting a "this can scroll" feeling from the plain page scroll — confirmed the root cause: this screen relies on native page/PWA scrolling (no inner fixed-height box, `#app` just grows with content), and native scrollbars are essentially invisible on mobile/installed-PWA regardless of CSS styling, which is why the earlier v38.4 themed-scrollbar attempt never showed up for him either. Rather than fight native scrollbar APIs again, this builds a fully custom, self-drawn scroll-position indicator plus large tappable arrows — both driven by real `window.scrollY`/`scrollHeight`/`innerHeight` math, so they render identically everywhere instead of depending on what the OS/browser chooses to show. Per Julio's choices: arrows are tappable (auto-scroll on press, not just visual hints), and this is scoped to the clock-out activity screen only, not applied app-wide.
  - **Added:** `#act-scroll-overlay` — a `position:fixed` overlay (constrained to `#app`'s `max-width:520px` column, same centering trick as `.act-confirm-bar`) holding: `.act-scroll-rail` (a thin track + `#act-scroll-thumb`, resized/repositioned via JS to reflect actual scroll fraction — not a native scrollbar), and two 48px circular buttons (`#act-arrow-top` ▲ / `#act-arrow-bottom` ▼) that fade in only when there's content to scroll to in that direction.
  - **New JS:** `updateActScroll()` — reads `window.scrollY`, `document.documentElement.scrollHeight`, and `window.innerHeight`, sizes/positions the thumb proportionally within the rail, and toggles the `.show` class on each arrow. Guarded on `#screen-activity` actually being the active screen (cheap check up front, so it's a no-op everywhere else) and attached to `window`'s `scroll`/`resize` events. `scrollActivityBy(dir)` — what the arrows call — scrolls the page by ~60% of viewport height (`window.scrollBy({behavior:'smooth'})`), repeatable per tap.
  - **Also fixed in passing:** `showActivityScreen()` now resets `window.scrollTo(0,0)` on entry. This app's screens all share one underlying page scroll (`.screen{display:none}` just toggles which screen occupies it), so without this the activity screen could open already scrolled from whatever position a previous screen left behind — needed for the new rail/arrows to read correct state on entry, not a general app-wide scroll-reset (out of scope per "this screen only").
  - Files changed: `index.html` (new scroll-overlay markup + version badge), `styles.css` (new `.act-scroll-*` rules), `app.js` (`updateActScroll()` + `scrollActivityBy()` + scroll-reset in `showActivityScreen()` + backup payload version).


**Last session date:** June 17, 2026 (earlier in the same day)
**Tasks completed this session:**
- **v39.0 — Activity selection redesigned as a full-screen checklist (replaces the v36–v38 dropdown):** The collapsed dropdown approach (v36 original, v38.4 scrollbar+fade, v38.5 chevrons) never solved the core discoverability problem — a tiny arrow or thin scrollbar just isn't a strong enough signal on a phone someone's tapping through quickly mid-shift. Since the clock-out activity screen is already dedicated solely to this one task, the dropdown was removed entirely and replaced with the full activity checklist shown directly as the screen's main content — every activity visible in an ordinary scrolling list, no popup, no scroll-hint mechanics needed (a normal full-page scroll is something everyone already understands). Per Julio's call: the "selected activities" tag-pill summary was dropped (checkmarks in the list itself already show what's picked), and the Confirm/Cancel buttons are now pinned to the bottom of the screen in a fixed bar so they're always reachable without scrolling back down through a long activity list.
  - **Removed:** the entire v36–v38.5 dropdown mechanism — `act-dropdown-wrap/btn/list-wrap/list`, the scroll fade (`act-fade-top/bottom`), the chevrons (`act-chevron-top/bottom`), the tag pills (`act-tags`/`act-tag`), and their JS (`renderActDropdown`, `renderActTags`, `removeActTag`, `updateActDropdownLabel`, `toggleDropAct`, `toggleActDropdown`, `updateActFades`, the outside-click-to-close listener, the scroll listener).
  - **Added:** `#act-list` — a plain checklist container rendered directly in the page flow (`renderActList()`), using `.act-list-item` rows (renamed from `.act-dropdown-item`, slightly larger touch targets — 18px checkboxes, 13px row padding — since it's now the primary screen content rather than a cramped popup). Tapping a row toggles it via the new `toggleAct(name,id)` (renamed from `toggleDropAct`, simplified since there's no dropdown-open state to preserve).
  - **Added:** `.act-confirm-bar` / `.act-confirm-bar-inner` — a `position:fixed` bar pinned to the bottom of the viewport (constrained to the app's `max-width:520px` column so it doesn't span the full window on desktop test views), holding the Confirm/Cancel buttons with safe-area padding for iOS home-indicator clearance. It's nested inside `#screen-activity`, so it automatically hides along with the rest of the screen when another screen is shown (no extra JS toggle needed) — relies on the fact `#app` has no `transform`/`filter`/`contain` that would otherwise trap `position:fixed` descendants. `#screen-activity` got matching `padding-bottom:140px` so the scrollable checklist content doesn't end up hidden behind the fixed bar.
  - **Roadmap impact:** this took the v39.0 slot that had been earmarked for the per-shift lunch-waive feature — that feature is now planned for **v40.0** (see updated section below).
  - Files changed: `index.html` (activity screen markup + version badge), `styles.css` (replaced dropdown/tag rules with checklist/confirm-bar rules, including light/auto theme overrides), `app.js` (rewrote the activity-screen functions + backup payload version).


**Last session date:** June 17, 2026 (earlier in the same day)
**Tasks completed this session:**
- **v38.5 — Chevron hints added to activity dropdown scroll affordance:** Follow-up to v38.4. The scrollbar styling alone wasn't a reliable visual cue on mobile (iOS Safari ignores `::-webkit-scrollbar` styling entirely, and native scrollbars typically only render while actively touched/dragged), so a small chevron (▴ / ▾) was added at the top/bottom edge of the dropdown as a clearer, more legible "more below" signal. Driven by the same scroll-position logic as the fade, not a separate check — when there's nothing to scroll to in a direction, neither the fade nor the chevron shows.
  - **Structure:** two new sibling divs inside `#act-dropdown-list-wrap` — `#act-chevron-top` (▴) and `#act-chevron-bottom` (▾) — sitting alongside the existing fade divs.
  - **JS:** `updateActFades()` extended to toggle `.show` on the two chevrons using the same `showTop`/`showBottom` booleans already computed for the fades; no new event listeners needed.
  - Files changed: `index.html` (two new chevron divs + version badge), `styles.css` (new `.act-dropdown-chevron*` rules), `app.js` (`updateActFades()` extended + backup payload version).
- **v38.4 — Activity dropdown scroll affordance:** The clock-out activity list (`#act-dropdown-list`) only shows a handful of items before needing a scroll, but had no visible scrollbar or hint that more activities existed below — easy to miss on a phone. Added a themed, always-visible thin scrollbar (cross-browser: `scrollbar-width`/`scrollbar-color` for Firefox, `::-webkit-scrollbar*` for Chrome/Safari) plus a top/bottom fade overlay that only appears when there's actually more to scroll in that direction (computed from `scrollHeight`/`scrollTop`/`clientHeight`, not just shown statically). Purely a UX/visual fix — no change to activity data, selection logic, or how punches are saved.
  - **Structure change:** the dropdown list is now wrapped in a new `#act-dropdown-list-wrap` div, which holds the border/background/shadow/rounding and clips its contents (`overflow:hidden`); the inner `#act-dropdown-list` is just the scrolling area; two new sibling divs (`#act-fade-top` / `#act-fade-bottom`) sit on top as the fade overlays, toggled via a `.show` class.
  - **New function:** `updateActFades()` — checks if the list is actually scrollable and how far scrolled, toggles the two fade overlays accordingly. Called on render (`renderActDropdown()`), on open (`toggleActDropdown()`), and on every scroll event (listener attached once to `#act-dropdown-list`).
  - **Renamed references:** all existing show/hide logic that used to target `#act-dropdown-list` directly (`showActivityScreen()`, `toggleDropAct()`, `toggleActDropdown()`, the outside-click listener, `confirmClockOut()`) now targets `#act-dropdown-list-wrap` instead — the inner list element keeps its old ID and is otherwise untouched.
  - Files changed: `index.html` (dropdown markup + version badge), `styles.css` (new wrap/scrollbar/fade rules), `app.js` (new `updateActFades()` + wrapper-ID updates + backup payload version).
  - Note: `styles.css` was not re-uploaded in that session — edited from the project copy, later confirmed identical to Julio's actual current file when re-uploaded.


**Tasks completed this session:**
- **v38.3 — Master admin PDF export + export bug fix:** Added PDF export to the master admin report, and fixed the async bug that was causing the export to always show "No records". After confirming all 4 checkboxes and tapping "Continue →", a format picker appears in-modal with "Export PDF" and "Export CSV" buttons. PDF matches the supervisor format — one time card per page, grouped by jobsite then alphabetically by employee; same columns, colours, auto-clock footnotes and signature line. Header band reads "MASTER ADMIN EXPORT". New functions: `masterConfirmStep2()`, `generateMasterPDF()`. Updated: `openMasterExportConfirm()` (uses `_masterLogs` cache, drives step-2 flow), `closeConfirmModal()` (resets picker on close). `index.html`: added `#master-format-picker` div inside confirm modal.


**Tasks completed this session:**
- **v38.1 (this session — hotfix to v38.0 nav reorg):** The v38.0 edit had broken `index.html` structurally — master admin panel loaded blank and the supervisor screen was showing the master panel.
  - **Root cause (index.html only — `app.js`/`styles.css` were fine):** the v38.0 nav edit overwrote the supervisor dashboard *body* with the master dashboard body and deleted the `<div id="screen-master">` wrapper. Net effect: (1) the supervisor nav (`stab-live/log/employees`) and all three supervisor panels (`spanel-live`, `spanel-log`, `spanel-employees`) were gone; (2) the `</div>` closing `screen-sup` was gone; (3) `screen-master` + its "Master Administrator" header no longer existed. So `screen-sup` literally contained the master nav/panels (→ supervisor login showed the master panel), and `showScreen('screen-master')` threw on a null element (→ master never loaded).
  - **Fix:** restored the supervisor nav + `spanel-live`/`spanel-log`/`spanel-employees` verbatim (unchanged since v37.1), re-closed `screen-sup`, and re-opened a proper `screen-master` wrapper with its header around the (kept-as-is) v38.0 grouped nav and all `mpanel-*`. No JS change needed — the v38.0 `switchMasterTab` is fully null-guarded and all supervisor functions were intact; only the backup-payload version string was bumped.
  - Verified: all 6 `screen-*` containers present and open at the same DOM depth (screen-master is a sibling of screen-sup, not nested); grouped nav (`mtab-overview/manage/reporting/settings`) + both sub-rows (`#msub-manage`/`#msub-reporting`) intact; no duplicate ids; `app.js` syntax clean (node --check).
  - Files changed: `index.html` (structure + version badge), `app.js` (backup payload version only). `styles.css` unchanged.
  - Version → v38.1.
- **v38.0 (this session — admin nav reorg):** Grouped the master admin tab bar from 8 flat tabs into 4 top-level tabs to stop the horizontal scroll/cramping (admins use it on both phone and desktop). New structure: **Overview · Manage · Reporting · Settings**.
  - **Manage** group → Jobsites · Employees · Departments · Activities (opens on **Employees**). **Reporting** group → Submissions · Report (opens on **Report**). Overview and Settings stay single (no sub-row).
  - Tapping a group tab reveals a contextual sub-nav row beneath the main nav (only the active group's row shows); the parent tab shows active whenever any child is active. Pure navigation reorg — all 8 underlying panels (`mpanel-*`) are untouched.
  - **`index.html`:** replaced the flat `.nav-bar` (8 `mtab-*` buttons) with 4 top buttons (`mtab-overview/manage/reporting/settings`) + two `.subnav-bar` rows (`#msub-manage`, `#msub-reporting`) of `.subnav-btn.msub-btn` children carrying a `data-tab`. Version badge → v38.0.
  - **`app.js`:** new `MASTER_TAB_GROUP` / `MASTER_GROUP_DEFAULT` maps + `switchMasterGroup(group)` (jumps to the group's default child). `switchMasterTab` rewritten to also set the parent-group active state, show/hide the correct sub-row, and highlight the active `.msub-btn` — existing panel-show + refresh calls unchanged, so all prior callers (`switchMasterTab('log')` / `('overview')`, Overview stat-card → `('employees')`) still work. Backup payload version → v38.0.
  - **`styles.css`:** new `.subnav-bar` (banded contextual strip) + `.subnav-btn`; active state uses `var(--blue-l)` / `var(--blue-d)` — a matched light-bg/dark-text pair in BOTH themes, so no per-theme override needed (avoids the amber-style contrast inversion).
  - Verified: app.js syntax clean (node --check); no other code referenced the old per-tab `mtab-*` ids.
  - Significant change (3-file nav restructure) → whole-number bump, agreed with Julio. This claims **v38.0**, so the per-shift lunch waive arc moves to **v39.0**.
- **v37.1 (this session — critical bug fix):** Auto-clock was overwriting real clock-outs.
  - **Symptom:** since ~Jun 8–9, employees clocked out normally (saw the green confirmation, write succeeded) but the punch later showed `auto_clocked = true` with an out-time of exactly clock-in + 12h. Jun 9 hit 6/10 auto-clocked. Confirmed real (Julio saw his own punch-out succeed, then revert).
  - **Root cause:** the app is now on personal phones (NOT shared kiosks — every employee runs the PWA). Each device loads ALL open punches company-wide at boot and runs `checkAutoServer` every 30s over that in-memory list, which is never refreshed after boot. The auto-clock UPDATE had no `clock_out is null` guard, so any device still running past an employee's 12h mark would overwrite that employee's already-recorded clock-out with a 12h auto-clock. With ~50–100 phones each holding everyone's open punches, the overwrite surface was huge. NOT caused by v37.0's code (auto-clock logic was untouched) — a latent flaw whose trigger rate spiked around Jun 8–9.
  - **Fix (`app.js`, `checkAutoServer`):** the auto-clock UPDATE is now guarded with `.is('clock_out', null).select()` — it only writes if the punch is still open in the DB, so a stale device can NEVER overwrite a real clock-out. When the guarded write affects 0 rows (already closed elsewhere), it heals the stale in-memory entry from the DB (or drops it if the row was deleted). In-memory state is only marked auto-clocked when the write actually succeeds.
  - **Server-side guard (SQL, run by Julio — essential here):** because personal phones can't be force-refreshed, old cached app versions would keep overwriting until each phone updates. A `before update` trigger on `punches` blocks any update that sets `auto_clocked = true` when `clock_out` is already non-null (returns OLD), preserving the real clock-out regardless of client version. Supervisor edits set `auto_clocked = false`, so corrections are unaffected.
  - **Data cleanup:** free Supabase tier = no backups, so ~11 clock-outs overwritten Jun 8–10 are unrecoverable from backup and are being fixed manually (edit each to the real end time; supervisors distinguish true forgot-to-clock-out from overwritten ones).
  - Verified (node harness): genuinely-open punch still auto-clocks; already-clocked-out punch is preserved (not overwritten); already-auto-clocked is a no-op.
  - Version → v37.1 (`index.html` badge, `app.js` backup payload).
- **v37.0 (prior session):** Manual punch entry — create a complete punch for someone who forgot to clock in/out.
  - **DB:** new column on `punches` (SQL run by Julio): `manual_entry boolean default false`.
  - **`index.html`:** edit modal made dual-mode — added title id (`edit-modal-title`), an add-only employee `<select>` (`add-emp-select` in `add-emp-wrap`, hidden in edit mode), ids on the save button (`edit-save-btn`) and delete row (`edit-delete-wrap`). New "+ Add punch" button in both the supervisor log card and master log filters card.
  - **`app.js`:** `addingPunch` / `addPunchCtx` globals; `openAddPunchModal(ctx)` drives the shared modal in add mode (full active roster sorted by name, blank times, hides delete row, relabels save "Add punch"); `saveEdit` gained an insert branch for add mode (validates employee + clock-in + out-after-in, inserts with `manual_entry:true`, refreshes whichever log opened it); `openEditModal` now resets the modal back to edit-mode UI (shared modal); `closeEditModal` clears the add flag; `dbRowToEntry` maps `manualEntry`; both log renders prepend an amber "✎ Manual" badge when `manualEntry` is true.
  - **Design decisions (with Julio):** button in BOTH logs; supervisor employee picker is the full roster (not scoped to assigned sites); audit badge included; overlap guard skipped (future); manual marker in exports skipped (future); treated as a significant change → whole-number bump.
  - **Badge color:** fixed `#f0a830` bg / `#3a2600` text (not the `--amber` var, which inverts between light/dark themes and would lose contrast). Kept the change to `app.js` + `index.html` only — `styles.css` untouched to avoid overwriting a possibly-stale project copy.
  - Verified: app.js syntax clean; add-flow validation node-tested (blocks no-employee / no-clock-in / out-before-in; valid with both times and in-only both produce `manual_entry:true`).
  - Version → v37.0 (`index.html` badge, `app.js` backup payload).
- **v36.2 (prior session — part 3 of v36):** Automatic unpaid lunch deduction.
  - **DB:** three new columns on `pt_settings` (SQL run by Julio): `lunch_enabled` (bool, default false), `lunch_minutes` (int, default 30), `lunch_threshold_hours` (numeric, default 5).
  - **Engine** (`app.js`): lunch deduction added as the final step in `paidHours` — after credit + round, if lunch is enabled and the punch isn't auto-clocked/estimated and the adjusted elapsed hours are *greater than* the threshold, subtract `lunchMinutes/60` (floored at 0). `APP_SETTINGS` gained `lunchEnabled / lunchMinutes / lunchThresholdHours` defaults; `applySettingsRow` maps the three new columns.
  - **No per-site edits needed:** because every hours total already routes through `paidHours`, the deduction flows automatically to supervisor log, master report, export preview, CSV, and PDF. Displayed in/out times are unchanged (option-B display choice) — only the Hrs number changes.
  - **UI:** new "Unpaid lunch deduction" block in the master admin Settings tab (`set-lunch-enabled` toggle, `set-lunch-minutes`, `set-lunch-threshold` inputs); `refreshSettingsPanel` populates them, `saveSettings` reads + upserts them.
  - Verified math (node harness): 7:00–3:30 (8.5h) → 8.0h; exactly 5h → no deduction (over-threshold, not at); 5.5h → 5.0h; 4h short shift untouched; auto-clocked 12h and estimated 9h left exact; disabled → no change.
  - Threshold uses *over* (`>`) not *at-or-over* — a shift of exactly 5h is not docked. Decided with Julio.
  - Version → v36.2 (`index.html` badge, `app.js` backup payload).
- **v36.1 (prior session — part 2 of v36):** Configurable pay rules — admin-controlled rounding + paid break-in-lieu credit.
  - **DB:** new `pt_settings` table (single row id=1) — namespaced to avoid collision with an unrelated `settings` table already in the project (JEG's Designs). SQL run by Julio. Holds `rounding_enabled / rounding_minutes / sched_end_enabled / sched_end_time / sched_end_window`.
  - **Engine** (`app.js`, near the time helpers): `applySettingsRow`, `roundTime` (local-clock nearest-interval, timezone-safe), `applySchedEnd` (credit up to scheduled end, no clipping), `adjustedTimes` (credit-then-round; skips auto-clocked + estimated), `paidHours`. `APP_SETTINGS` global with safe defaults; loaded in `bootApp` (defaults persist if row/table missing).
  - **Wired `paidHours` / `adjustedTimes` into every hours site:** supervisor log total + per-punch (raw times kept on screen), master report preview + table (raw times on screen), supervisor export preview total, master CSV export (adjusted times + paid hrs), PDF `consolidate` + rows + total (adjusted times + paid hrs). Auto-clock detection, live "elapsed" timer, and estimate-modal preview deliberately stay on RAW time.
  - **UI:** new master admin **Settings** tab (`mtab-settings` / `mpanel-settings`) with both rule toggles + inputs; `refreshSettingsPanel` populates from `APP_SETTINGS`, `saveSettings` upserts the row and updates the device immediately. `switchMasterTab` extended with `'settings'`.
  - Verified math (node harness): 7:00→3:15 credits to 3:30 (8.5h elapsed); 3:45 not clipped; 2:00 early-leave gets no credit; 7/8 rounding boundaries correct; auto-clocked punches unaffected by rules.
  - **Display choice (option B):** on-screen review tables show real punch times with paid hours in the Hrs column; edit modal still edits the true punch. PDF/CSV show adjusted times so the deliverable reconciles.
  - **Known gap by design:** no lunch deduction yet → a normal 7:00–3:30 day reads 8.5h. The 30-min unpaid lunch that brings it to 8.0h is v36.2.
  - Version → v36.1 (`index.html` badge, `app.js` backup payload).
- **v36.0 (prior session — part 1 of v36):** Review gate on supervisor report submission.
  - A supervisor can no longer submit a report (preliminary OR final) while any punch in the selected date range + jobsites is still auto-clocked (`auto_clocked = true`). The gate runs at the very start of the export flow, before the duplicate-check and estimated-clock-out steps.
  - On a blocked attempt, a new modal (`#review-gate-bg`) lists the affected employees and their clock-in times. "Review these now" closes the export and calls `goToSupReport('review')`, dropping the Time log into the needs-review filter so they can fix each one. "Cancel" backs out.
  - Because punches are re-fetched on every export attempt and editing an auto-clock flips `auto_clocked → false`, the gate clears itself as each one is resolved — no new data model.
  - **Master admin export is intentionally not gated** — admin can submit regardless (override).
  - `index.html`: added `#review-gate-bg` modal (after the dup modal); version badge → v36.0.
  - `app.js`: gate block added in `openExportConfirm` after the punch fetch; new `showReviewGate()` / `closeReviewGate()` / `reviewGateGoNow()`; backup payload version → v36.0.
  - **Shipped in v36.1 (part 2):** configurable rounding + paid break-in-lieu credit (see v36.1 entry above).
- **v35.7:** Two contained feature additions ahead of the Monday reporting period.
  - **Supervisor permissions:** supervisors can no longer change *other* supervisors' kiosk PIN or login password — admin only. They can still change their own and manage regular employees.
    - `index.html`: added `id="emp-sup-pass-field"` to the password field wrapper; added `#emp-restrict-note` lock message under the PIN field.
    - `app.js`: `refreshSupEmps` hides Reset PIN for other supervisors; `openEmpModal` locks the PIN field + hides the password field + shows the note when a supervisor edits another supervisor (`ctx==='sup'`); `saveEmployee` preserves the existing PIN/password in that case (DOM-tamper guard).
    - Note: this is a UI-level guard. Supabase anon key still allows direct DB writes — server-side enforcement waits on the RLS work (see short-list).
  - **Clickable Live tiles:** the three supervisor Live tiles are now tappable and jump to the Time log with the matching view.
    - `index.html`: added `onclick="goToSupReport(...)"` + pointer cursor to the three tiles; added the `s-filter-flags` dropdown to the Time log period selector.
    - `app.js`: new `goToSupReport(which)`; `refreshSupLog` now reads `s-filter-flags` — `review` runs a period-independent query for all outstanding auto-clocked+uncorrected punches (matches the tile count), `stillin` filters the date-bounded results to open punches; `setSupPeriod` clears the filter when a period button is clicked. Export preview is untouched (it queries independently by date).
  - Version bumped in `app.js` (backup payload) and `index.html` (version badge).
- **v35.6:** Session persistence improved for personal phone use.
  - Switched `pt_session` from `sessionStorage` → `localStorage` so session survives tab close, app backgrounding, and returning from the kiosk screen.
  - Extended session expiry from 10 minutes → **8 hours** (`SESSION_PERSIST_MS`).
  - Session timestamp now **refreshes on every user interaction** (inside `resetSupTimer` and `resetMasterTimer`) so an active user never hits the wall mid-shift.
  - Explicit logout (back to kiosk button or inactivity timeout) still clears `localStorage` as before.
  - Changes in `app.js`: `tryRestoreSession`, `resetSupTimer`, `resetMasterTimer`, `masterLogin`, `supLogin`.
  - Version bumped in `app.js` (backup payload) and `index.html` (version badge).

- **v35.5:** Master admin Employees tab — removed the Status column. Inactive employees now show "(inactive)" in grey next to their name. The Deactivate/Activate toggle button is now colour-coded: red when active (Deactivate), green when inactive (Activate). Changes in `app.js` (`refreshMasterEmps`) and `index.html` (table header).
- **v35.4:** PanoramaTrack logo is now clickable in the supervisor dashboard header and master admin dashboard header — clicking it navigates back to the kiosk screen.
- Fixed version display: was incorrectly showing `v36` — corrected to `v35.1` in both `index.html` and `app.js`
- Confirmed no material ordering system remnants remain in the codebase
- Version increment rules established and documented above
- **v35.2:** Master admin Report tab now defaults to current pay period on open. Replaced quick-select buttons with supervisor-style period buttons (Today / Yesterday / Current period / Last period / 2 periods ago).
- **v35.3:** Fixed Report tab filter reset behaviour in master admin panel.

**Status:** App fully working.

---

## 🐛 Known Bugs / Open Issues

- [x] **RESOLVED v37.1** — Auto-clock overwriting real clock-outs (see v37.1 task log). Fixed client-side (guarded update) + server-side (trigger). After deploy, employees' PWAs update on their own schedule; the DB trigger protects data in the meantime.
- [ ] **OPEN — Supabase RLS disabled (security).** Supabase flagged `punches` (and likely other tables) as publicly readable/writable because Row-Level Security is off — anyone with the project URL could read/edit/delete data. NOT the cause of the auto-clock bug (ruled out). Do NOT click "Resolve issue" / enable RLS without policies first — with the anon key and no policies it will take the whole app offline. Needs a deliberate pass: enable RLS + add policies (or move writes behind a server function) and rotate keys. Parked until the dust settles on v37.1.
- [ ] Manual cleanup of ~11 clock-outs overwritten Jun 8–10 (no backups on free tier — reconstruct from supervisor/employee knowledge via the edit modal).

---

## 💡 Next Features Planned

_(Full roadmap is in `PanoramaTrack_Future_Features.md`)_

**Priority short-list:**
- [ ] Tighten Supabase RLS policies (anon key currently allows full DB read/write)
- [ ] Kiosk lock screen — return to PIN entry after inactivity
- [ ] Hash employee PINs (currently plaintext in DB)

---

## ⏭ Next Session Agenda

**v44.0 is fully delivered (all 3 builds + the mid-arc schema retrofit).** No build is currently in-flight. Suggested next items, none committed yet:

- **Real-world shakeout of the multi-site paths.** Force Submit, admin override, and the all-or-nothing-per-employee export are new and haven't run against live multi-site data yet — worth watching the first couple of pay periods for any employee who genuinely splits sites.
- **Bank Hours** (shelved from v44.0 scope, see backlog below).
- Standing security items (RLS, kiosk lock screen, PIN hashing) — see the Priority short-list above.
- The Excel Pack filename cosmetic limitation noted in the v44.0 section above, if it turns out to bother Julio in practice.

---

### Post-v44.0 backlog (not committed)
**Per-shift lunch waive — ✅ SHIPPED in v42.0.** The lunch arc is complete: auto-deduction (v36.2) + per-shift waive request/approval (v42.0).

Candidate items:
- **Bank Hours** (shelved from v44.0 scope) — employees over 88 hrs/period request to bank hours in lieu of OT, or draw banked hours to top up a short period; passed to master admin (not supervisor), shown on exported PDFs + an Excel-export notice, with an admin-editable balance under the employee detail panel. Design partially discussed, deliberately deferred.
- **Per-shift lunch waive follow-ups:** surface the waive toggle in the My Timecard self-edit path; a "deny all" bulk action; a visible "waived" annotation on exported timesheets (the paid-hours *effect* already flows through exports).
- **Per-shift lunch waive — possible follow-ups if they come up in use:** surface the waive toggle in the My Timecard self-edit path too (deliberately left out of v42.0); a "deny all" bulk action (deliberately left individual); a waive marker in PDF/CSV/Excel exports (currently the badge is on-screen only — the *effect* on paid hours already flows through exports via `paidHours`, but there's no visible "waived" annotation on the exported timesheet).
- **NFC tag scanning** — explored as a PIN alternative; Web NFC works on Android Chrome, not iOS Safari. Parked, no decision.
- **Codebase file-splitting** — plain `<script>`-tag splitting (no bundler); export functions the natural first candidate. Discussed, not actioned.

See the Security / Priority short-list below for the standing open items (RLS, kiosk lock screen, PIN hashing).

---

## 🔑 Key Code Locations (in app.js)

| Feature | Function / search term |
|---|---|
| Clock-in flow | `clockIn()` |
| Clock-out flow | `clockOut()` |
| Auto-clock logic | `checkAutoServer()` / `AUTO_H=12`; runs every 30s (`setInterval` ~line 163). v37.1: write guarded with `.is('clock_out',null)` so it can't overwrite a real clock-out; also a DB `before update` trigger on `punches` blocks auto_clock writes onto already-closed punches |
| PDF generation | `generatePDF()` |
| Pay period calc | `getPayPeriod()` / `getPeriodByOffset()` |
| Submission tracking | `refreshSubmissionsPanel()` |
| Supervisor login | `activeSup` variable |
| DB init / boot | `bootApp()` |
| Export confirm flow | `openExportConfirm()` |
| Activity code lookup | `actCodeMap` / `formatTaskCode()` |
| Activity full-screen checklist (v39.0, replaces v36–v38 dropdown) | `showActivityScreen()` / `renderActList()` / `toggleAct(name,id)`; `#act-list` (checklist container), `.act-list-item` rows, `#activity-error`; fixed bottom bar `.act-confirm-bar`/`.act-confirm-bar-inner` holding Confirm/Cancel — all in `#screen-activity` in index.html; `.act-list*`/`.act-confirm-bar*` in styles.css |
| Activity screen custom scroll rail + tappable arrows (v39.1) | `updateActScroll()` / `scrollActivityBy(dir)`; `#act-scroll-overlay` (`.act-scroll-rail`/`#act-scroll-thumb`, `#act-arrow-top`/`#act-arrow-bottom`) in index.html; `.act-scroll-*` in styles.css |
| Supabase client | Top of `app.js` — `SUPABASE_URL` / `SUPABASE_KEY` |
| Theme toggle | `applyTheme()` / `setTheme()` / `pt-theme` (localStorage) |
| Backup | `runBackup()` |
| Corfix reminder | `showCorfixReminder()` / `JOBSITE_DATA` |
| Master report period select | `setMasterPeriod(mode)` / `_masterPeriodMode` |
| Supervisor period select | `setSupPeriod(mode)` / `_supPeriodMode` |
| Session persistence | `tryRestoreSession()` / `SESSION_PERSIST_MS` / `pt_session` (localStorage) |
| Supervisor permission gating | `refreshSupEmps()` / `openEmpModal(id,ctx)` / `saveEmployee()` — `restricted` flag; `#emp-sup-pass-field`, `#emp-restrict-note` in index.html |
| Live tile navigation | `goToSupReport(which)` → `setSupPeriod` + `s-filter-flags` + `refreshSupLog` |
| Submit review gate | `openExportConfirm()` (gate block) → `showReviewGate(autoList,waiveList)` / `closeReviewGate()` / `reviewGateGoNow()`; `#review-gate-bg` (two sections: `#review-gate-auto-section`/`#review-gate-list` + `#review-gate-waive-section`/`#review-gate-waive-list`) in index.html. v42.0: gate now also blocks on pending lunch waives, with bulk `approveAllWaivesFor(empId)`. Master path is intentionally not blocking — see "Master export review warning (v40.1)" row below |
| Lunch waive — capture (v42.0) | `#lunch-waive-row`/`#lunch-waive-chk` toggle at top of `#screen-activity` (above `#act-list`) in index.html; `lunchWaiveRequested` global + `toggleLunchWaive()`; reset in `showActivityScreen()`; written in `confirmClockOut()` (`lunch_waive_requested` column) |
| Lunch waive — approval (v42.0) | edit modal `#edit-waive-wrap` (Approve/Deny → `setEditWaive(bool)` / `_renderEditWaive()` / `setupEditWaive(entry)`, `_editWaiveDecision` global); persisted in `saveEdit()` when `_editWaiveDecision!==null` (`lunch_waived` column); hidden in Add-Punch mode. Bulk approve from the gate: `approveAllWaivesFor(empId)` (`_reviewGateWaives`) |
| Lunch waive — engine/surfacing (v42.0) | `paidHours()` skips deduction when `lunchWaived===true`; `isPendingWaive(entry)` = `requested===true && waived==null` (single source for gate/filter/tile); `dbRowToEntry()` maps `lunchWaiveRequested`/`lunchWaived`; supervisor `review` filter `.or(...)` + `refreshSupLive` second count include pending waives; 🍴 status chips in `refreshSupLog`/`refreshMasterLog` |
| Edit punch (existing) | `openEditModal(ref)` / `saveEdit()` / `confirmDeletePunch()` / `deletePunch()`; `#edit-modal-bg` in index.html |
| Manual add punch (v37.0) | `openAddPunchModal(ctx)` + add branch at top of `saveEdit()`; shared edit modal in add mode (`addingPunch` / `addPunchCtx` globals); "+ Add punch" buttons in `#spanel-log` & `#mpanel-log`; `manual_entry` column; amber "✎ Manual" badge in `refreshSupLog`/`refreshMasterLog` |
| Master grouped nav (v38.0) | `switchMasterGroup(group)` / `switchMasterTab(tab)` (rewritten) / `MASTER_TAB_GROUP` + `MASTER_GROUP_DEFAULT`; top tabs `#mtab-overview/manage/reporting/settings`, sub-rows `#msub-manage` / `#msub-reporting` holding `.subnav-btn.msub-btn[data-tab]` in index.html; `.subnav-bar` / `.subnav-btn` in styles.css |
| Pay rules engine | `APP_SETTINGS` (global) / `applySettingsRow()` / `roundTime()` / `applySchedEnd()` / `adjustedTimes()` / `paidHours()` (lunch deduction lives here, v36.2; skipped per-punch when `lunchWaived===true`, v42.0) — near the time helpers (`fmtDt` area) |
| Pay rules settings UI | `refreshSettingsPanel()` / `saveSettings()`; `mtab-settings` + `mpanel-settings` in index.html; `pt_settings` table in Supabase |
| Hours display sites (use paidHours) | `refreshSupLog`, `refreshMasterLog`, `updateExportPreview`, `doMasterExcelZip` (Excel pack), `generatePDF` `consolidate` |
| Excel Pack export (v40.0) | `doMasterExcelZip()` + helpers `_xlB64ToU8` / `_xlSanitize` / `_xlNumericCode` / `_xlRound2`; embedded template in `payroll-template.js` (`window.PAYROLL_TEMPLATE_B64`); ExcelJS+JSZip `<script>` tags in index.html. Replaces the old `doMasterExport` CSV fn. |
| Master export review warning + format picker (v40.1) | `openMasterExportConfirm()` → `showMasterReviewWarning()` / `toggleMasterReviewList()` / `closeMasterReviewModal()` / `masterReviewGoNow()` / `masterReviewExportAnyway()` (`#master-review-modal`) → `showMasterFormatModal()` / `closeMasterFormatModal()` (`#master-format-modal`, holds the 📄 PDF / 📦 Excel Pack buttons). Replaces the old shared `chk1`–`chk4` checklist for the admin path; supervisor's checklist/review-gate unaffected. |
| Quick-set time buttons (v40.1) | `quickSetEditOut(hh,mm)` (Edit Punch — same date as current clock-in) / `quickSetAddTime(fieldId,'today'\|'yesterday',hh,mm)` (Add Manual Punch); button rows `#out-quickset-edit` / `#in-quickset-add` / `#out-quickset-add` in index.html, toggled by `openEditModal()` / `openAddPunchModal()` |
| Needs-review race guard (v40.1) | `_supLogSeq` in `refreshSupLog()`, `_masterLogSeq` in `refreshMasterLog()` — sequence-number guard so a stale, superseded call can't overwrite a newer one's render |
| My Timecard — employee self-edit (v41.0) | `submitTimecardPin()` → `openMyTimecard(emp)` / `closeMyTimecard()` / `renderMyTcList()`; edit & add via shared `openMyTcEdit(dbId)` / `openMyTcAdd()` → `saveMyTcEdit()` (`#mytc-edit-modal-bg`, separate from the supervisor/master `#edit-modal-bg`); `buildMyTcActGrid()`/`toggleMyTcAct()`; "My Timecard" button + `#screen-mytc` in index.html; writes `manual_entry=true` (no new flag); period-lock check queries `submissions` for a `final` row overlapping `getPeriodByOffset(0)`
| Supervisor log filter | `refreshSupLog()` reads `#s-filter-flags` (`''` / `stillin` / `review`) |
| **Timecard stage — data layer (v44.0, schema+signatures changed in Build 3)** | `pt_timecard_status` table (now one row per employee per period **per jobsite**); `TC_STAGE`/`TC_STAGE_RANK` consts; `getTimecardStatus(empId,periodStart,jobsite)` (one site) / `getEmployeeStatusRows(empId,periodStart)` (all of one employee's site-rows, NEW Build 3) / `getAllStatusForPeriod(periodStart)` (→ `{empId:[rows]}`, array-valued since Build 3) / `setTimecardStage(empId,period,stage,jobsite)` (jobsite now REQUIRED) / `stageOf(row)` / `stageAtLeast(stage,target)` / `minStage(rows)` / `maxStage(rows)` (NEW Build 3 aggregate helpers) / `isFullyReadyForExport(rows,sitesWorked)` (NEW Build 3 — sitesWorked param is what makes a worked-but-unsubmitted site correctly block readiness) / `isOutOfSubmission(entry,statusRow)` — all near `isPendingWaive` in app.js |
| **My Timecard submit/pull-back (v44.0, retrofit in Build 3)** | `renderMyTcSubmitBar()` (3 states off `maxStage(myTcStatusRows)`) + `submitMyTimecard()` (auto-clock gate → before/after-period warning → writes `emp_submitted` **per distinct jobsite worked**, `Promise.all`) + `retractMyTimecard()` (resets **every** site-row → `open`); `#mytc-submit-bar` in index.html. Lock in `openMyTimecard()`: `myTcLocked`=`maxStage`≥`sup_submitted`, `myTcEditable`=`myTcStatusRows.length===0`. State: `myTcStatusRows` (array, was `myTcStatus` single row pre-Build-3) / `myTcBusy` / `myTcEditable` |
| **My Timecard running total (v44.0)** | `myTcRunningHours(punches)` → `{hours,pendingWaiveCount}` (completed punches only, optimistic pending-waive, non-mutating); `renderMyTcTotal()` → `#mytc-total` in index.html (with disclaimer line) |
| **Supervisor stage colours + out-of-submission (v44.0, scoped to supervisor's own sites in Build 3)** | `supStatusPeriod()` (log mode → stage period) / `supStageChip(stage)` (grey/amber/green pill) in `refreshSupLog`; per-employee chip now driven by `minStage(mySiteRows)` where `mySiteRows` = that employee's status rows filtered to `activeSup.jobsites`; left-border + "⚠️ After submit" row badges via `isOutOfSubmission` matched per-punch to its own site's row; one `getAllStatusForPeriod` call per refresh (Option A), re-guarded by `_supLogSeq` |
| **Supervisor site-wide submit (v44.0, reworked for per-site pairs in Build 3)** | `submitSiteToOffice()` (period-scoped roster query at `activeSup.jobsites`, builds `{empId,jobsite}` "ready pairs" where that site's row is `emp_submitted`) → confirm → `doSubmitSiteToOffice(readyPairs,...)` (Promise.all `setTimecardStage` per pair); `updateSubmitSummary(empMap,statusMap)` live count (statusMap here is pre-scoped to supervisor's sites, captured as `myStatusMap` during the row-build loop); `#s-submit-site-btn` / `#s-submit-period-label` / `#s-submit-summary` in index.html `#spanel-log` |
| **Supervisor Force Submit (NEW, v44.0 Build 3)** | `forceSubmitEmployee(empId,empName)` — finds this employee's open sites among the supervisor's own jobsites, gates on unresolved auto-clocks/pending waives (alert+block), confirms, writes `emp_submitted` per open site on the employee's behalf. "Force submit" button rendered inline in `refreshSupLog`'s card header when `openSupSites.length>0`. No audit marker. |
| **Supervisor PDF export (now a PREVIEW, v44.0)** | Machinery unchanged (`openExportConfirm`/gate/est/dup/`openChecklist`/`generatePDF`/`doExport` + `submissions` writes) — only wording relabelled to "preview/preliminary". Button `#s-export-btn` demoted to outline; labels set in `setSupPeriod`/`openChecklist`/`closeConfirmModal`; chk3/chk4 reworded in index.html |
| **Admin Submissions panel (REWRITTEN, v44.0 Build 3)** | `refreshSubmissionsPanel()` — jobsite accordions (reuses `emp-card`/`toggleEmpCard`), "X of Y submitted" headers, per-employee failsafe flags + Override button; `setSubPeriod(mode)`/`subStatusPeriod()` (Current/Last selector); `#mpanel-submissions`/`#submissions-list`/`#subbtn-current`/`#subbtn-last`/`#sub-export-all-btn`/`#sub-period-label` in index.html. Replaces the old `submissions`-table-driven list; that old UI + `deleteSubmission()` were removed entirely. |
| **Admin override (NEW, v44.0 Build 3)** | `adminOverrideSite(empId,jobsite,empName)` — same clean-punches gate as Force Submit, pushes one employee's one-site row straight to `sup_submitted` (stands in for both employee + supervisor). No audit marker. |
| **Admin export → stage stamping (NEW, v44.0 Build 3)** | `openSubmissionsExport(scopeType,jobsite)` — eligibility via `isFullyReadyForExport`, scopes `_masterLogs` + Report-tab date fields to the ready employees' full-period punches, opens the shared `#master-format-modal` picker. `_pendingExportStampFn` global — set here, consumed by `doMasterExcelZip()`/`generateMasterPDF()` right after they finish building the file, stamps `exported` on every included employee's site-rows, then refreshes the panel. The ad-hoc Report-tab export never sets this hook, so it never touches `pt_timecard_status`. |
| Version display | `index.html` version badge `<div>` (top-left of `#screen-kiosk`) and `app.js` backup payload (`app_version`) |

---

## 📋 How to Start a New Chat

Paste this at the top of your first message:

> "I'm continuing development on PanoramaTrack. Please read CURRENT_STATE.md and the project files to get up to speed. Here's what I need help with today: [your task]"

---

_Last updated: July 2, 2026 — v44.0 (3-tier submission flow complete — all 3 builds delivered)_
