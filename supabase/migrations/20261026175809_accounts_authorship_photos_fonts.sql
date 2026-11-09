/*
# Accounts, authorship, photos, fonts, admin delete

1. New Tables
- `profiles`
  - `id` (uuid, primary key, references auth.users) — one row per account
  - `username` (text, unique) — nickname shown on the public board
  - `is_admin` (boolean, default false) — admins can delete any note
  - `created_at` (timestamptz)
  The first account to register becomes admin automatically (see register_profile).

2. Modified Tables
- `notes`
  - add `user_id` (uuid, references auth.users, default auth.uid()) — the author
  - add `font` (text, default 'default') — font family key
  - add `image_path` (text, nullable) — storage object path for a photo
  - existing private notes (no user_id) become invisible under the new
    owner-scoped policy; they are not deleted.

3. Functions
- `register_profile(p_username)` (SECURITY DEFINER) — creates the profile row
  for the signed-in user and makes the very first user an admin. The caller
  is derived from auth.uid(); p_username is validated.
- `touch_updated_at()` trigger function — sets notes.updated_at on every UPDATE
  so the client never controls that column.

4. Storage
- create public-read bucket `note-images` for note photos.
- policies: anyone can read; only the owner (folder = auth.uid()) can write/
  update/delete their own objects.

5. Security
- notes RLS rewritten: authenticated only (anon removed).
  - SELECT: public board notes are visible to everyone signed in; private
    board notes only to their owner.
  - INSERT: only your own row (user_id = auth.uid()); board must be private/public.
  - UPDATE: only the owner, on content columns (user_id/board/created_at/updated_at
    are revoked from UPDATE).
  - DELETE: the owner, OR an admin (checked via profiles.is_admin).
- profiles RLS: authenticated can read all profiles (id, username, is_admin)
  so author nicks and admin status are available; writes go through
  register_profile only (no direct client INSERT/UPDATE on profiles).
- Storage policies enforce owner-scoped writes.
- anon role is revoked on notes and profiles — registration is required.
*/

-- ---------- profiles ----------
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- unique username (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_key
  ON profiles (lower(username));

GRANT SELECT ON profiles TO authenticated;
-- no INSERT/UPDATE/DELETE grant to clients; mutations go through register_profile.

DROP POLICY IF EXISTS "profiles_select_all" ON profiles;
CREATE POLICY "profiles_select_all" ON profiles FOR SELECT
  TO authenticated USING (true);

-- ---------- register_profile ----------
CREATE OR REPLACE FUNCTION register_profile(p_username text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_is_admin boolean;
  v_clean text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_clean := btrim(p_username);
  IF v_clean = '' THEN
    RAISE EXCEPTION 'Имя пользователя не может быть пустым';
  END IF;
  IF length(v_clean) > 24 THEN
    RAISE EXCEPTION 'Имя пользователя слишком длинное';
  END IF;

  -- first registered user becomes admin
  SELECT NOT EXISTS (SELECT 1 FROM profiles) INTO v_is_admin;

  INSERT INTO profiles (id, username, is_admin)
  VALUES (auth.uid(), v_clean, v_is_admin)
  ON CONFLICT (id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION register_profile(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION register_profile(text) TO authenticated;

-- ---------- notes: new columns ----------
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS font text NOT NULL DEFAULT 'default'
    CHECK (font IN ('default','serif','mono','hand','rounded')),
  ADD COLUMN IF NOT EXISTS image_path text;

-- ---------- notes: updated_at trigger ----------
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_touch_updated_at ON notes;
CREATE TRIGGER notes_touch_updated_at
BEFORE UPDATE ON notes
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------- notes: grants ----------
REVOKE SELECT, INSERT, UPDATE, DELETE ON notes FROM anon, authenticated;

GRANT SELECT ON notes TO authenticated;
GRANT INSERT (title, body, color, pos_x, pos_y, board, font, image_path) ON notes TO authenticated;
GRANT UPDATE (title, body, color, pos_x, pos_y, font, image_path) ON notes TO authenticated;
GRANT DELETE ON notes TO authenticated;

-- ---------- notes: policies (authenticated only) ----------
DROP POLICY IF EXISTS "anon_select_notes" ON notes;
DROP POLICY IF EXISTS "anon_insert_notes" ON notes;
DROP POLICY IF EXISTS "anon_update_notes" ON notes;
DROP POLICY IF EXISTS "anon_delete_notes" ON notes;

DROP POLICY IF EXISTS "notes_select" ON notes;
CREATE POLICY "notes_select" ON notes FOR SELECT
  TO authenticated USING (
    board = 'public'
    OR (board = 'private' AND user_id = auth.uid())
  );

DROP POLICY IF EXISTS "notes_insert" ON notes;
CREATE POLICY "notes_insert" ON notes FOR INSERT
  TO authenticated WITH CHECK (
    user_id = auth.uid()
    AND board IN ('private','public')
  );

DROP POLICY IF EXISTS "notes_update" ON notes;
CREATE POLICY "notes_update" ON notes FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "notes_delete" ON notes;
CREATE POLICY "notes_delete" ON notes FOR DELETE
  TO authenticated USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.is_admin)
  );

-- ---------- indexes ----------
CREATE INDEX IF NOT EXISTS notes_board_user_idx ON notes (board, user_id);
CREATE INDEX IF NOT EXISTS notes_public_idx ON notes (board) WHERE board = 'public';

-- ---------- storage: note-images bucket ----------
INSERT INTO storage.buckets (id, name, public)
VALUES ('note-images', 'note-images', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "note_images_read" ON storage.objects;
CREATE POLICY "note_images_read" ON storage.objects FOR SELECT
  TO public USING (bucket_id = 'note-images');

DROP POLICY IF EXISTS "note_images_insert_own" ON storage.objects;
CREATE POLICY "note_images_insert_own" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (
    bucket_id = 'note-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "note_images_update_own" ON storage.objects;
CREATE POLICY "note_images_update_own" ON storage.objects FOR UPDATE
  TO authenticated USING (
    bucket_id = 'note-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'note-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "note_images_delete_own" ON storage.objects;
CREATE POLICY "note_images_delete_own" ON storage.objects FOR DELETE
  TO authenticated USING (
    bucket_id = 'note-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
