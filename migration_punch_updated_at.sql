-- PanoramaTrack v49.12 — Track when a punch was last changed, so the app can flag
-- "new/updated punch data since submission/export".
-- Run this once in the Supabase SQL editor before deploying the v49.12 app.js/index.html.

-- New column: stamped on every insert (via the column default) and every update (via the
-- trigger below). The trigger unconditionally overrides whatever the client sends, so no
-- app.js write path needs to be touched or remembered — every existing insert/update call
-- site (clock-in, clock-out, edits, auto-clock, waive decisions, estimate writes, etc.)
-- is covered automatically.
ALTER TABLE punches ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

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

-- CRITICAL BACKFILL — do not skip this. A bare `DEFAULT now()` would stamp every EXISTING
-- punch's updated_at as "the moment this migration ran", which would make every
-- already-submitted/already-exported timecard in the system look like it just changed the
-- instant the app ships v49.12 — a false-positive flood on day one. Run this immediately
-- after the ALTER TABLE above so it catches every pre-existing row, backfilling to each
-- punch's own clock_in time (the closest available proxy for "last known state" on
-- historical data). Only real edits/inserts going forward will produce a genuinely newer
-- updated_at than a timecard's sup_submitted_at/exported_at.
UPDATE punches SET updated_at = clock_in;
