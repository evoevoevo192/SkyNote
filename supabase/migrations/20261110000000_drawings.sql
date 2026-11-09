/*
# Drawing on the private board

New table `drawings` — one row per user (the private board has one drawing layer).

- `user_id`    uuid PK -> auth.users (default auth.uid())
- `board`      text, only 'private' for now (CHECK), room to grow
- `strokes`    jsonb array of vector strokes, at most 2 MB:
               { id, t: 'pen' | 'marker', c: '#rrggbb', w: line width in px,
                 p: [x1, y1, x2, y2, ...] }
               Coordinates are normalised by the canvas width: x = px / width,
               y = px / width (so shapes keep their proportions on every screen).
- `updated_at` timestamptz

RLS: the owner only (select / insert / update / delete). Nobody else can read the drawing.
*/

CREATE TABLE IF NOT EXISTS drawings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  board text NOT NULL DEFAULT 'private' CHECK (board = 'private'),
  strokes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(strokes) = 'array' AND octet_length(strokes::text) <= 2097152),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE drawings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON drawings FROM anon, authenticated;
GRANT SELECT, DELETE ON drawings TO authenticated;
GRANT INSERT (user_id, board, strokes, updated_at) ON drawings TO authenticated;
-- upsert (INSERT ... ON CONFLICT DO UPDATE) also SETs the columns it inserts, so they all need UPDATE.
-- Changing user_id is still impossible: the RLS WITH CHECK requires user_id = auth.uid().
GRANT UPDATE (user_id, board, strokes, updated_at) ON drawings TO authenticated;

DROP POLICY IF EXISTS "drawings_select_own" ON drawings;
CREATE POLICY "drawings_select_own" ON drawings FOR SELECT
  TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "drawings_insert_own" ON drawings;
CREATE POLICY "drawings_insert_own" ON drawings FOR INSERT
  TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "drawings_update_own" ON drawings;
CREATE POLICY "drawings_update_own" ON drawings FOR UPDATE
  TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "drawings_delete_own" ON drawings;
CREATE POLICY "drawings_delete_own" ON drawings FOR DELETE
  TO authenticated USING (user_id = auth.uid());
