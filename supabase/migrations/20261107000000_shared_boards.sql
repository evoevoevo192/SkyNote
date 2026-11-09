/*
# Shared boards with friends

1. New tables
- `boards`        id, owner_id, name (1..40 chars), created_at
- `board_members` (board_id, user_id) — the owner is stored as a member too,
                  so "is a member" is the only check RLS needs. At most 8 rows
                  per board = the owner + up to 7 friends.

2. Modified table `notes`
- `board` now also accepts 'shared'.
- `board_id` uuid -> boards (ON DELETE CASCADE). board = 'shared' <=> board_id is set.
- the old "photos only on the private board" constraint is relaxed:
  photos are allowed on 'private' and 'shared'.

3. Functions (SECURITY DEFINER, search_path = public)
- is_board_member(board) / is_board_owner(board) — used by the policies.
- create_board(name, friend_ids[]) — creates the board, adds the owner and the chosen
  friends (accepted friendships only, up to 7) in one transaction.
- add_board_member(board, user) — owner only, user must be an accepted friend, 7-friend cap.

4. RLS
- boards: members read; owner renames (UPDATE name only) and deletes. Creation via create_board.
- board_members: members of the board read the member list; the owner removes anyone,
  a member removes only himself (leave). Adding goes through the RPCs.
- notes (SELECT / INSERT / UPDATE / DELETE rewritten):
  * private: owner only (unchanged); public: everybody (unchanged);
  * shared: only members read and create; the author edits (while still a member);
    the author or the board owner deletes. Global admins keep delete rights on
    private/public notes only, not on shared boards.
  * the RESTRICTIVE "notes_hide_from_blocked" policy from the friends system is kept.

5. Realtime
- notes, boards and board_members are added to the supabase_realtime publication.
- board_members has REPLICA IDENTITY FULL so DELETE events carry board_id and user_id.
*/

-- ---------- tables ----------
CREATE TABLE IF NOT EXISTS boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS board_members (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS board_members_user_idx ON board_members (user_id);

ALTER TABLE boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_members REPLICA IDENTITY FULL;

-- ---------- notes columns / constraints ----------
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS board_id uuid REFERENCES boards(id) ON DELETE CASCADE;

ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_board_check;
ALTER TABLE notes ADD CONSTRAINT notes_board_check
  CHECK (board IN ('private', 'public', 'shared'));

ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_shared_board_id;
ALTER TABLE notes ADD CONSTRAINT notes_shared_board_id
  CHECK ((board = 'shared') = (board_id IS NOT NULL));

ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_photo_private_only;
ALTER TABLE notes ADD CONSTRAINT notes_photo_boards
  CHECK (type <> 'photo' OR board IN ('private', 'shared'));

CREATE INDEX IF NOT EXISTS notes_board_id_idx ON notes (board_id) WHERE board_id IS NOT NULL;

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION is_board_member(p_board uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM board_members WHERE board_id = p_board AND user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION is_board_owner(p_board uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM boards WHERE id = p_board AND owner_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION are_friends(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM friendships f
    WHERE f.status = 'accepted'
      AND ((f.requester_id = p_a AND f.addressee_id = p_b)
        OR (f.requester_id = p_b AND f.addressee_id = p_a))
  );
$$;

REVOKE EXECUTE ON FUNCTION is_board_member(uuid), is_board_owner(uuid), are_friends(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_board_member(uuid), is_board_owner(uuid) TO authenticated;
-- are_friends is only used inside other SECURITY DEFINER functions.

-- ---------- RPC: create_board ----------
CREATE OR REPLACE FUNCTION create_board(p_name text, p_friends uuid[] DEFAULT '{}')
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_friends uuid[];
  v_id uuid;
  v_f uuid;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF v_name = '' OR char_length(v_name) > 40 THEN RAISE EXCEPTION 'BAD_NAME'; END IF;

  SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_friends
  FROM unnest(coalesce(p_friends, '{}')) AS x WHERE x <> v_me;

  IF coalesce(array_length(v_friends, 1), 0) > 7 THEN RAISE EXCEPTION 'TOO_MANY_MEMBERS'; END IF;

  FOREACH v_f IN ARRAY v_friends LOOP
    IF NOT are_friends(v_me, v_f) THEN RAISE EXCEPTION 'NOT_FRIEND'; END IF;
  END LOOP;

  INSERT INTO boards (owner_id, name) VALUES (v_me, v_name) RETURNING id INTO v_id;
  INSERT INTO board_members (board_id, user_id) VALUES (v_id, v_me);
  FOREACH v_f IN ARRAY v_friends LOOP
    INSERT INTO board_members (board_id, user_id) VALUES (v_id, v_f);
  END LOOP;
  RETURN v_id;
END;
$$;

-- ---------- RPC: add_board_member ----------
CREATE OR REPLACE FUNCTION add_board_member(p_board uuid, p_user uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT is_board_owner(p_board) THEN RAISE EXCEPTION 'NOT_OWNER'; END IF;
  IF NOT are_friends(v_me, p_user) THEN RAISE EXCEPTION 'NOT_FRIEND'; END IF;
  IF EXISTS (SELECT 1 FROM board_members WHERE board_id = p_board AND user_id = p_user) THEN
    RAISE EXCEPTION 'ALREADY_MEMBER';
  END IF;
  IF (SELECT count(*) FROM board_members WHERE board_id = p_board) >= 8 THEN
    RAISE EXCEPTION 'TOO_MANY_MEMBERS';
  END IF;
  INSERT INTO board_members (board_id, user_id) VALUES (p_board, p_user);
END;
$$;

REVOKE EXECUTE ON FUNCTION create_board(text, uuid[]), add_board_member(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_board(text, uuid[]), add_board_member(uuid, uuid) TO authenticated;

-- ---------- grants ----------
REVOKE ALL ON boards, board_members FROM anon, authenticated;
GRANT SELECT ON boards, board_members TO authenticated;
GRANT UPDATE (name) ON boards TO authenticated;
GRANT DELETE ON boards, board_members TO authenticated;

GRANT INSERT (board_id) ON notes TO authenticated;

-- ---------- policies: boards ----------
DROP POLICY IF EXISTS "boards_select" ON boards;
CREATE POLICY "boards_select" ON boards FOR SELECT
  TO authenticated USING (is_board_member(id));

DROP POLICY IF EXISTS "boards_update_owner" ON boards;
CREATE POLICY "boards_update_owner" ON boards FOR UPDATE
  TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "boards_delete_owner" ON boards;
CREATE POLICY "boards_delete_owner" ON boards FOR DELETE
  TO authenticated USING (owner_id = auth.uid());

-- ---------- policies: board_members ----------
DROP POLICY IF EXISTS "board_members_select" ON board_members;
CREATE POLICY "board_members_select" ON board_members FOR SELECT
  TO authenticated USING (is_board_member(board_id));

DROP POLICY IF EXISTS "board_members_delete" ON board_members;
CREATE POLICY "board_members_delete" ON board_members FOR DELETE
  TO authenticated USING (
    is_board_owner(board_id)
    OR (user_id = auth.uid() AND NOT is_board_owner(board_id))
  );

-- ---------- policies: notes ----------
DROP POLICY IF EXISTS "notes_select" ON notes;
CREATE POLICY "notes_select" ON notes FOR SELECT
  TO authenticated USING (
    board = 'public'
    OR (board = 'private' AND user_id = auth.uid())
    OR (board = 'shared' AND is_board_member(board_id))
  );

DROP POLICY IF EXISTS "notes_insert" ON notes;
CREATE POLICY "notes_insert" ON notes FOR INSERT
  TO authenticated WITH CHECK (
    user_id = auth.uid()
    AND (
      (board IN ('private', 'public') AND board_id IS NULL)
      OR (board = 'shared' AND is_board_member(board_id))
    )
  );

DROP POLICY IF EXISTS "notes_update" ON notes;
CREATE POLICY "notes_update" ON notes FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() AND (board <> 'shared' OR is_board_member(board_id)))
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "notes_delete" ON notes;
CREATE POLICY "notes_delete" ON notes FOR DELETE
  TO authenticated USING (
    CASE
      WHEN board = 'shared' THEN
        is_board_owner(board_id) OR (user_id = auth.uid() AND is_board_member(board_id))
      ELSE
        user_id = auth.uid()
        OR EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.is_admin)
    END
  );

-- ---------- realtime ----------
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['notes', 'boards', 'board_members'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END;
$$;
