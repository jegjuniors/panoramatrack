-- PanoramaTrack v44.0 Build 3 migration
-- Moves pt_timecard_status from ONE ROW PER EMPLOYEE PER PERIOD to
-- ONE ROW PER EMPLOYEE PER PERIOD PER JOBSITE.
-- Safe to run on live data: the new constraint is strictly LOOSER than the old one
-- (adds a column to the unique key rather than removing one), so no existing rows
-- can conflict and no backfill/data changes are needed.

-- 1) Drop the old unique constraint (employee_id, period_start).
--    Looked up dynamically in case it was ever renamed from the default Postgres name.
DO $$
DECLARE cname text;
BEGIN
  SELECT tc.constraint_name INTO cname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
  WHERE tc.table_name = 'pt_timecard_status' AND tc.constraint_type = 'UNIQUE'
  GROUP BY tc.constraint_name
  HAVING array_agg(kcu.column_name::text ORDER BY kcu.column_name) = ARRAY['employee_id','period_start']
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE pt_timecard_status DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- 2) Add the new unique constraint including jobsite.
ALTER TABLE pt_timecard_status
  ADD CONSTRAINT pt_timecard_status_employee_period_jobsite_key
  UNIQUE (employee_id, period_start, jobsite);

-- Note: jobsite stays nullable at the DB level (no existing-data risk either way), but the
-- app now REQUIRES it on every write going forward (setTimecardStage() refuses to write
-- without one). No RLS changes needed — this only touches the unique constraint.
