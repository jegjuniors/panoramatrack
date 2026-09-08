-- PanoramaTrack v49.12 — Track when a punch was last changed, so the app can flag
-- "new/updated punch data since submission/export".
-- Run this once in the Supabase SQL editor before deploying the v49.12 app.js/index.html.
--
-- IMPORTANT — statement order matters here (learned the hard way; see
-- migration_punch_updated_at_fix.sql if this already ran with the trigger created too early):
-- the backfill UPDATE below MUST run before the trigger is created. The trigger fires on
-- every UPDATE, including the backfill's own statement — creating it first would make the
-- trigger silently override the backfill and stamp every row with "now" instead of its own
-- clock_in, which is the exact false-positive flood this backfill exists to prevent.

-- New column: stamped on every insert (via the column default). Updates are stamped by the
-- trigger created further down — added AFTER the backfill below runs, for the reason above.
ALTER TABLE punches ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- CRITICAL BACKFILL — do not skip this, and do not reorder it below the trigger. A bare
-- `DEFAULT now()` would stamp every EXISTING punch's updated_at as "the moment this migration
-- ran", which would make every already-submitted/already-exported timecard in the system look
-- like it just changed the instant the app ships v49.12 — a false-positive flood on day one.
-- Backfilling to each punch's own clock_in time is the closest available proxy for "last known
-- state" on historical data. Only real edits/inserts going forward (once the trigger below is
-- active) will produce a genuinely newer updated_at than a timecard's
-- sup_submitted_at/exported_at.
UPDATE punches SET updated_at = clock_in;

-- Trigger: stamps every UPDATE going forward. Unconditionally overrides whatever the client
-- sends, so no app.js write path needs to be touched or remembered — every existing
-- insert/update call site (clock-in, clock-out, edits, auto-clock, waive decisions, estimate
-- writes, etc.) is covered automatically. Created LAST, after the backfill above, so it can't
-- intercept and clobber that one-time historical UPDATE.
CREATE OR REPLACE FUNCTION set_punch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_punch_updated_at ON punches;
CREATE TRIGGER trg_punch_updated_at
BEFORE UPDATE ON punches
FOR EACH ROW EXECUTE FUNCTION set_punch_updated_at();
