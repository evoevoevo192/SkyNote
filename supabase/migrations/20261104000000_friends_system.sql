/*
# Friends system

1. Public IDs
- `profiles.public_id` (text, unique, NOT NULL) — short public ID `XXXX-XXXX`.
  Alphabet: letters A–Z without I and O, digits 2–9 (32 symbols).
- `generate_public_id()` creates a free ID; it is the column default, so new
  profiles get one automatically (register_profile is unchanged).
- Existing profiles are backfilled in this migration.
- The column is NOT readable through the table by clients (column-level SELECT
  grant on profiles excludes it), so IDs cannot be scraped. A user reads only
  their own ID via `get_my_public_id()`.

2. New tables
- `friendships` (id, requester_id, addressee_id, status pending|accepted|blocked,
  created_at). One row per pair in either direction (unique index on
  least/greatest), no self-links. For status = 'blocked', requester_id is the
  user who blocked.
- `friend_request_log` — server-side log used for the 10-requests-per-24h limit
  (no client access; survives cancel/decline so the limit cannot be bypassed).

3. Functions (SECURITY DEFINER unless noted)
- `get_my_public_id()` — caller's own public ID.
- `send_friend_request(p_public_id)` — exact-match lookup; returns only
  {status, id, username}. Errors: USER_NOT_FOUND, SELF, ALREADY_SENT,
  ALREADY_FRIENDS, YOU_BLOCKED, RATE_LIMIT. If the other user already sent
  you a request, it is accepted instead.
- `block_user(p_user)` — replaces any link with a 'blocked' row.
- `is_blocked_by(p_author)` — true if p_author blocked the caller (used by the
  notes policy; needed because the blocked side cannot read the block row).
- `friends_last_activity()` (SECURITY INVOKER) — last update time of each
  friend's notes on the public board (respects notes RLS).

4. Security
- friendships RLS: SELECT own rows (the blocked side does not see the block);
  UPDATE only by the addressee, only pending -> accepted, only the status column;
  DELETE by participants (a block row only by the blocker). No client INSERT —
  requests go through send_friend_request.
- notes: one RESTRICTIVE SELECT policy hides a user's notes from people who
  are blocked by that user. Existing notes policies are untouched.
*/

-- ---------- public id ----------
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS public_id text;

CREATE OR REPLACE FUNCTION generate_public_id()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_id text;
  i int;
BEGIN
  LOOP
    v_id := '';
    FOR i IN 1..8 LOOP
      v_id := v_id || substr(v_alphabet, 1 + floor(random() * 32)::int, 1);
    END LOOP;
    v_id := substr(v_id, 1, 4) || '-' || substr(v_id, 5, 4);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM profiles WHERE public_id = v_id);
  END LOOP;
  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION generate_public_id() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM profiles WHERE public_id IS NULL LOOP
    UPDATE profiles SET public_id = generate_public_id() WHERE id = r.id;
  END LOOP;
END;
$$;

ALTER TABLE profiles ALTER COLUMN public_id SET DEFAULT generate_public_id();
ALTER TABLE profiles ALTER COLUMN public_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_public_id_format') THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_public_id_format
      CHECK (public_id ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$');
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_public_id_key ON profiles (public_id);

-- keep the ID private: clients may read every column except public_id
REVOKE SELECT ON profiles FROM authenticated;
GRANT SELECT (id, username, is_admin, created_at) ON profiles TO authenticated;

CREATE OR REPLACE FUNCTION get_my_public_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = public
AS $$
  SELECT public_id FROM profiles WHERE id = auth.uid();
$$;

REVOKE EXECUTE ON FUNCTION get_my_public_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_my_public_id() TO authenticated;

-- ---------- friendships ----------
CREATE TABLE IF NOT EXISTS friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT friendships_no_self CHECK (requester_id <> addressee_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_key
  ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
CREATE INDEX IF NOT EXISTS friendships_requester_idx ON friendships (requester_id);
CREATE INDEX IF NOT EXISTS friendships_addressee_idx ON friendships (addressee_id);

ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON friendships FROM anon, authenticated;
GRANT SELECT, DELETE ON friendships TO authenticated;
GRANT UPDATE (status) ON friendships TO authenticated;

DROP POLICY IF EXISTS "friendships_select_own" ON friendships;
CREATE POLICY "friendships_select_own" ON friendships FOR SELECT
  TO authenticated USING (
    requester_id = auth.uid()
    OR (addressee_id = auth.uid() AND status <> 'blocked')
  );

DROP POLICY IF EXISTS "friendships_accept_by_addressee" ON friendships;
CREATE POLICY "friendships_accept_by_addressee" ON friendships FOR UPDATE
  TO authenticated
  USING (addressee_id = auth.uid() AND status = 'pending')
  WITH CHECK (addressee_id = auth.uid() AND status = 'accepted');

DROP POLICY IF EXISTS "friendships_delete_participants" ON friendships;
CREATE POLICY "friendships_delete_participants" ON friendships FOR DELETE
  TO authenticated USING (
    requester_id = auth.uid()
    OR (addressee_id = auth.uid() AND status <> 'blocked')
  );

-- ---------- request log (rate limit) ----------
CREATE TABLE IF NOT EXISTS friend_request_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requester_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS friend_request_log_idx
  ON friend_request_log (requester_id, created_at);

ALTER TABLE friend_request_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON friend_request_log FROM anon, authenticated;

-- ---------- send_friend_request ----------
CREATE OR REPLACE FUNCTION send_friend_request(p_public_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_code text;
  v_target_id uuid;
  v_target_name text;
  v_row friendships%ROWTYPE;
  v_count int;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  v_code := upper(regexp_replace(coalesce(p_public_id, ''), '[^A-Za-z0-9]', '', 'g'));
  IF length(v_code) <> 8 THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;
  v_code := substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4);

  SELECT id, username INTO v_target_id, v_target_name
  FROM profiles WHERE public_id = v_code;
  IF v_target_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;
  IF v_target_id = v_me THEN
    RAISE EXCEPTION 'SELF';
  END IF;

  SELECT * INTO v_row FROM friendships
  WHERE LEAST(requester_id, addressee_id) = LEAST(v_me, v_target_id)
    AND GREATEST(requester_id, addressee_id) = GREATEST(v_me, v_target_id);

  IF FOUND THEN
    IF v_row.status = 'blocked' THEN
      IF v_row.requester_id = v_me THEN
        RAISE EXCEPTION 'YOU_BLOCKED';
      END IF;
      -- they blocked me: do not reveal it
      RAISE EXCEPTION 'USER_NOT_FOUND';
    ELSIF v_row.status = 'accepted' THEN
      RAISE EXCEPTION 'ALREADY_FRIENDS';
    ELSIF v_row.requester_id = v_me THEN
      RAISE EXCEPTION 'ALREADY_SENT';
    ELSE
      -- they already asked me: accept instead of creating a second row
      UPDATE friendships SET status = 'accepted' WHERE id = v_row.id;
      RETURN jsonb_build_object('status', 'accepted', 'id', v_target_id, 'username', v_target_name);
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('friend_request:' || v_me::text));
  SELECT count(*) INTO v_count FROM friend_request_log
  WHERE requester_id = v_me AND created_at > now() - interval '24 hours';
  IF v_count >= 10 THEN
    RAISE EXCEPTION 'RATE_LIMIT';
  END IF;

  INSERT INTO friendships (requester_id, addressee_id, status)
  VALUES (v_me, v_target_id, 'pending');
  INSERT INTO friend_request_log (requester_id) VALUES (v_me);

  RETURN jsonb_build_object('status', 'sent', 'id', v_target_id, 'username', v_target_name);
END;
$$;

REVOKE EXECUTE ON FUNCTION send_friend_request(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION send_friend_request(text) TO authenticated;

-- ---------- block_user ----------
CREATE OR REPLACE FUNCTION block_user(p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_row friendships%ROWTYPE;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF p_user IS NULL OR p_user = v_me THEN
    RAISE EXCEPTION 'SELF';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_user) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  SELECT * INTO v_row FROM friendships
  WHERE LEAST(requester_id, addressee_id) = LEAST(v_me, p_user)
    AND GREATEST(requester_id, addressee_id) = GREATEST(v_me, p_user);

  IF FOUND THEN
    IF v_row.status = 'blocked' THEN
      -- already blocked by me (nothing to do) or by them (keep their block)
      RETURN;
    END IF;
    DELETE FROM friendships WHERE id = v_row.id;
  END IF;

  INSERT INTO friendships (requester_id, addressee_id, status)
  VALUES (v_me, p_user, 'blocked');
END;
$$;

REVOKE EXECUTE ON FUNCTION block_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION block_user(uuid) TO authenticated;

-- ---------- blocked users cannot see the blocker's notes ----------
CREATE OR REPLACE FUNCTION is_blocked_by(p_author uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM friendships
    WHERE status = 'blocked'
      AND requester_id = p_author
      AND addressee_id = auth.uid()
  );
$$;

REVOKE EXECUTE ON FUNCTION is_blocked_by(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_blocked_by(uuid) TO authenticated;

DROP POLICY IF EXISTS "notes_hide_from_blocked" ON notes;
CREATE POLICY "notes_hide_from_blocked" ON notes AS RESTRICTIVE FOR SELECT
  TO authenticated USING (NOT is_blocked_by(user_id));

-- ---------- friends' last activity on the public board ----------
CREATE OR REPLACE FUNCTION friends_last_activity()
RETURNS TABLE (user_id uuid, last_active timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT n.user_id, max(n.updated_at)
  FROM notes n
  WHERE n.board = 'public'
    AND n.user_id IN (
      SELECT CASE WHEN f.requester_id = auth.uid() THEN f.addressee_id ELSE f.requester_id END
      FROM friendships f
      WHERE f.status = 'accepted'
        AND (f.requester_id = auth.uid() OR f.addressee_id = auth.uid())
    )
  GROUP BY n.user_id;
$$;

REVOKE EXECUTE ON FUNCTION friends_last_activity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION friends_last_activity() TO authenticated;
