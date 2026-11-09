/*
# "Detective" mode: red threads between board objects

New table `connections`: one thread between two objects (stickers or photos, both are rows of
`notes`) on the SAME board.

- `a_id`, `b_id`  -> notes(id) ON DELETE CASCADE (deleting an object removes its threads).
                    CHECK (a_id < b_id) keeps the pair canonical and UNIQUE (a_id, b_id)
                    guarantees one thread per pair (the app sorts the two ids before inserting).
- `board`, `board_id` are copied from the notes by the trigger `connections_set_scope`
  (never trusted from the client): 'private' or 'shared'. The trigger also rejects threads
  between objects of different boards, on the public board, and on the private board
  between objects of different owners.
- `user_id`       author of the thread (default auth.uid()).
- `color` '#rrggbb' (default red), `dashed` boolean, `label` up to 60 chars.

RLS
- SELECT: private -> the author; shared -> board members.
- INSERT: the author, on the private board, or as a member on a shared board.
- UPDATE (color, dashed, label only): the author of the thread.
- DELETE: the author, or the owner of the shared board.

Realtime: `connections` is added to the supabase_realtime publication.
*/

CREATE TABLE IF NOT EXISTS connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  board text NOT NULL DEFAULT 'private' CHECK (board IN ('private', 'shared')),
  board_id uuid REFERENCES boards(id) ON DELETE CASCADE,
  a_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  b_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  color text NOT NULL DEFAULT '#d62828' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  dashed boolean NOT NULL DEFAULT false,
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (a_id < b_id),
  CHECK ((board = 'shared') = (board_id IS NOT NULL)),
  UNIQUE (a_id, b_id)
);
CREATE INDEX IF NOT EXISTS connections_board_idx ON connections (board_id) WHERE board_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS connections_user_idx ON connections (user_id);
CREATE INDEX IF NOT EXISTS connections_b_idx ON connections (b_id);

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION connections_set_scope()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  na notes%ROWTYPE;
  nb notes%ROWTYPE;
BEGIN
  SELECT * INTO na FROM notes WHERE id = NEW.a_id;
  SELECT * INTO nb FROM notes WHERE id = NEW.b_id;
  IF na.id IS NULL OR nb.id IS NULL THEN RAISE EXCEPTION 'NOTE_NOT_FOUND'; END IF;
  IF na.board <> nb.board OR na.board_id IS DISTINCT FROM nb.board_id THEN
    RAISE EXCEPTION 'DIFFERENT_BOARDS';
  END IF;
  IF na.board = 'public' THEN RAISE EXCEPTION 'NOT_ON_PUBLIC_BOARD'; END IF;
  IF na.board = 'private' AND (na.user_id <> auth.uid() OR nb.user_id <> auth.uid()) THEN
    RAISE EXCEPTION 'NOT_YOUR_NOTES';
  END IF;
  NEW.board := na.board;
  NEW.board_id := na.board_id;
  NEW.user_id := coalesce(auth.uid(), NEW.user_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS connections_set_scope ON connections;
CREATE TRIGGER connections_set_scope
  BEFORE INSERT ON connections
  FOR EACH ROW EXECUTE FUNCTION connections_set_scope();

REVOKE ALL ON connections FROM anon, authenticated;
GRANT SELECT, DELETE ON connections TO authenticated;
GRANT INSERT (a_id, b_id, color, dashed, label) ON connections TO authenticated;
GRANT UPDATE (color, dashed, label) ON connections TO authenticated;

DROP POLICY IF EXISTS "connections_select" ON connections;
CREATE POLICY "connections_select" ON connections FOR SELECT
  TO authenticated USING (
    (board = 'private' AND user_id = auth.uid())
    OR (board = 'shared' AND is_board_member(board_id))
  );

DROP POLICY IF EXISTS "connections_insert" ON connections;
CREATE POLICY "connections_insert" ON connections FOR INSERT
  TO authenticated WITH CHECK (
    user_id = auth.uid()
    AND (board = 'private' OR (board = 'shared' AND is_board_member(board_id)))
  );

DROP POLICY IF EXISTS "connections_update" ON connections;
CREATE POLICY "connections_update" ON connections FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() AND (board = 'private' OR is_board_member(board_id)))
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "connections_delete" ON connections;
CREATE POLICY "connections_delete" ON connections FOR DELETE
  TO authenticated USING (
    user_id = auth.uid()
    OR (board = 'shared' AND is_board_owner(board_id))
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'connections') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.connections;
  END IF;
END;
$$;
