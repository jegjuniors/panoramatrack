# CLAUDE.md

Guidance for Claude Code (and any AI assistant) working in this repository.

## Project snapshot

**PanoramaTrack** is a single-page timekeeping / payroll app for Panorama Building Systems.
Employees clock in/out on their personal phones (PWA); supervisors review and submit
timecards; a master admin exports payroll (PDF + Excel pack).

- **No build step, no bundler, no framework.** The app is plain static files served as-is:
  - `index.html` — all UI markup, modals, screens
  - `app.js` — all logic, state, Supabase calls (one big file)
  - `styles.css` — all styling
  - `payroll-template.js` — auto-generated base64 Excel template; **never hand-edit**
- **Backend:** Supabase (Postgres + Edge Functions). Tables: `employees`, `jobsites`,
  `departments`, `activities`, `punches`, `submissions`, `pt_settings`, `pt_timecard_status`.
- **Deploy:** static files → Netlify. Edge Functions are pasted into the Supabase Dashboard
  by hand (e.g. `submission-notify-edge-function.ts`), not deployed from this repo.
- **Migrations:** hand-written `.sql` files in the repo root, run by the maintainer (Julio) in
  the Supabase SQL editor. Always call out when a change needs one.

## Verification

There is no test runner or CI. Before handing work back:

- `node --check app.js` after any `app.js` edit.
- For non-trivial logic, write a small throwaway assertion harness against the extracted
  function (this is the established pattern — see `needsStartTimeConfirm`, `notifySubmission`).
- The app itself can't be rendered/screenshotted here — flag anything that needs a real
  device or browser check (safe-area/CSS, PWA behaviour, live Supabase/DOM paths).

## Standing build rules (full text in HANDOFF.md → "Standing Build Rules / Gotchas")

- **Dark mode:** the app defaults to a near-black background with no global text color. Every
  new text element must get an explicit theme-aware color (`var(--txt)` / `--txt2` / `--txt3`) —
  never a hard-coded hex, never nothing.
- Keep `#app` free of `transform` / `filter` / `contain` — `position:fixed` bars depend on it.
- On mobile/PWA, native scrollbars are invisible — use the JS scroll-rail pattern, not CSS.
- Guard async log refreshers with a sequence number (`_supLogSeq`, `_masterLogSeq`).
- Don't delete the `const` lines (`color`, `si`, `idx`, `hrs`…) declared just above the
  `return` template literal in `refreshMasterLog` / `refreshSupLog` — a missing one throws
  inside `.map()` and silently blanks the whole table.
- Bump the version badge in `index.html` and the `app_version` in the `app.js` backup payload
  together.

---

# Development Workflow & Handoffs

- **Handoff File:** Always check for the presence of a `HANDOFF.md` file at the start of a task
  to understand the current state, recent blockages, and next steps.
- **Session Continuity:** At the end of a major task, when wrapping up a feature, or when
  explicitly asked to prepare a handoff, automatically update or create the `HANDOFF.md` file.
- **Handoff Structure:** The file must strictly include:
  1. **Current Status:** What was just completed.
  2. **Active State:** Current branch, modified files, and compilation/test status.
  3. **Next Steps:** The immediate 2–3 items that need to be tackled next.
  4. **Blockers/Notes:** Any known bugs, architectural decisions, or flags to watch out for.

## Stage gating: plan → code → push

Three separate gates, each requiring its own explicit go-ahead — finishing one is not permission
to start the next:

1. **Plan first.** When asked to plan, investigate and design a change (design decisions, files
   to touch, the mechanism) without editing `app.js`/`index.html`/`styles.css` or any other
   shipped file. Ask clarifying questions before finalizing the plan when the design forks on
   something the user hasn't specified (e.g. "should this value persist or just gate the action").
2. **Code only when told to.** Don't start implementing a planned change until the user
   explicitly says to (e.g. "let's build it," "implement this," "yes, fix it now"). A plan being
   agreed on isn't itself the go-ahead to write code, unless the user's message doing the
   agreeing also asks for the code.
3. **Push only when told to, and only once all of this session's coding is done.** Finishing and
   verifying one fix (`node --check`, a harness) is not permission to commit/push it — keep it
   staged in the working tree and say so. Commit + push only on an explicit instruction (e.g.
   "let's submit these changes," "commit and push"), and treat that as covering everything coded
   so far in the session, not just the most recent fix — don't push mid-session after each
   individual fix unless asked to.

## How this maps to `HANDOFF.md`

`HANDOFF.md` keeps the four required sections at the **top** of the file, in order, under a
`# Reference & History` divider that holds the architecture notes, DB schema, standing build
rules, key code locations, and the full version-by-version changelog. When updating the
handoff:

- Rewrite Sections 1–4 to reflect the new current state — don't just append.
- Move the previous "Current Status" bullets into the changelog under `# Reference & History`
  if they represent a shipped version.
- Update the `**Version:**` and `**Last handoff update:**` lines at the top.
- Keep Sections 1–4 tight (a screenful). Detail belongs in the changelog entry.
