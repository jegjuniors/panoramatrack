-- ============================================================================
-- PanoramaTrack v47.4 — One-time cleanup of orphaned pt_timecard_status rows
-- ============================================================================
-- Deletes status rows for (employee, period, jobsite) combos where the employee
-- has ZERO punches at that jobsite in that period — the stale rows left behind
-- when a punch's jobsite was edited away (or the punch deleted) before v47.4's
-- automatic cleanup existed.
--
-- SAFETY:
--   * Only touches rows at 'open' or 'emp_submitted' — never sup_submitted/exported
--     (anything a supervisor or the office already acted on is left alone).
--   * The "does a punch exist" check is padded by ±1 day so no timezone edge case
--     at a period boundary can remove a row that still has a legitimate punch.
--
-- HOW TO USE:
--   1. Run STEP 1 (SELECT) first and eyeball the rows it lists — these are exactly
--      what STEP 2 will delete. Anthony's Block 22 / T1 Conversion rows should appear.
--   2. If it looks right, run STEP 2 (DELETE).
-- ============================================================================


-- ── STEP 1: PREVIEW — rows that WOULD be deleted (run this first) ────────────
SELECT s.employee_id, s.jobsite, s.period_start, s.period_end, s.stage
FROM pt_timecard_status s
WHERE s.stage IN ('open', 'emp_submitted')
  AND NOT EXISTS (
    SELECT 1 FROM punches p
    WHERE p.employee_id = s.employee_id
      AND p.jobsite     = s.jobsite
      AND p.clock_in >= (s.period_start::date - INTERVAL '1 day')
      AND p.clock_in <  (s.period_end::date   + INTERVAL '2 days')
  )
ORDER BY s.period_start DESC, s.employee_id, s.jobsite;


-- ── STEP 2: DELETE — run only after the preview looks correct ────────────────
-- DELETE FROM pt_timecard_status s
-- WHERE s.stage IN ('open', 'emp_submitted')
--   AND NOT EXISTS (
--     SELECT 1 FROM punches p
--     WHERE p.employee_id = s.employee_id
--       AND p.jobsite     = s.jobsite
--       AND p.clock_in >= (s.period_start::date - INTERVAL '1 day')
--       AND p.clock_in <  (s.period_end::date   + INTERVAL '2 days')
--   );
