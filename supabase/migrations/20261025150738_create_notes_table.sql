/*
# Create notes table (single-tenant, no auth)

1. New Tables
- `notes`
  - `id` (uuid, primary key)
  - `title` (text, the heading written on the sticky note)
  - `body` (text, the full content of the note; defaults to empty)
  - `color` (text, the sticky note color; one of yellow/pink/green/blue/orange; defaults to yellow)
  - `pos_x` (double precision, horizontal position on the board; defaults to 0)
  - `pos_y` (double precision, vertical position on the board; defaults to 0)
  - `created_at` (timestamptz, defaults to now())
  - `updated_at` (timestamptz, defaults to now())

2. Security
- Enable RLS on `notes`.
- Grant CRUD to `anon` + `authenticated` so the Data API can reach the table.
- Allow anon + authenticated CRUD because the app is intentionally shared/public (no sign-in).
*/

CREATE TABLE IF NOT EXISTS notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT 'yellow'
    CHECK (color IN ('yellow','pink','green','blue','orange')),
  pos_x double precision NOT NULL DEFAULT 0,
  pos_y double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_notes" ON notes;
CREATE POLICY "anon_select_notes" ON notes FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_notes" ON notes;
CREATE POLICY "anon_insert_notes" ON notes FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_notes" ON notes;
CREATE POLICY "anon_update_notes" ON notes FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_notes" ON notes;
CREATE POLICY "anon_delete_notes" ON notes FOR DELETE
  TO anon, authenticated USING (true);
