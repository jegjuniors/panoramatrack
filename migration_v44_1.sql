-- ============================================================================
-- PanoramaTrack — v44.1 migration
-- ============================================================================
-- Adds DB-level UNIQUE constraints on employee PIN and supervisor password.
-- Matches the app-side uniqueness checks in saveEmployee() so a duplicate can't
-- slip through even via direct SQL edits in Supabase.
--
-- ASSUMED CLEAN: no pre-migration audit was run (per Julio's call). If either
-- ALTER TABLE below fails with a duplicate-key error, run the audit query in
-- the comment below the failing statement, resolve the duplicates by hand in
-- the Supabase table editor, then re-run this migration.
--
-- Rollback: DROP CONSTRAINT employees_pin_unique;
--           DROP CONSTRAINT employees_supervisor_password_unique;
-- ============================================================================

-- 1. Employee PIN uniqueness (kiosk clock-in / My Timecard login)
--    PIN is NOT NULL in practice (app requires it), so a plain UNIQUE constraint
--    covers every row.
ALTER TABLE employees
  ADD CONSTRAINT employees_pin_unique UNIQUE (pin);
-- If this fails, run:
--   SELECT pin, count(*) FROM employees GROUP BY pin HAVING count(*) > 1;

-- 2. Supervisor password uniqueness (supervisor login — v44.1 dropped the name
--    dropdown, so password alone must identify the supervisor)
--    supervisor_password is NULL for non-supervisor employees. PostgreSQL treats
--    NULLs as DISTINCT in a UNIQUE constraint by default, so all the non-supervisor
--    NULLs coexist without conflict — only the actual passwords need to be unique
--    among themselves.
ALTER TABLE employees
  ADD CONSTRAINT employees_supervisor_password_unique UNIQUE (supervisor_password);
-- If this fails, run:
--   SELECT supervisor_password, count(*)
--   FROM employees
--   WHERE supervisor_password IS NOT NULL
--   GROUP BY supervisor_password
--   HAVING count(*) > 1;
