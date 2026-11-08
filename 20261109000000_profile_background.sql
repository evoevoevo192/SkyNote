/*
# Personal board background

- `profiles.settings` (jsonb, default '{}'): personal UI settings. Today it holds
  `{ "background": { kind, id, path, dim, blur } }`.
  The column is NOT in the column-level SELECT grant on profiles (only id, username,
  is_admin, created_at are readable), so nobody can read anybody's settings through the
  table; the owner reads/writes them through two SECURITY DEFINER functions.
- `get_my_settings()`       returns the caller's settings.
- `update_my_settings(p)`   merges the given top-level keys into the caller's settings
                            (object only, max 4 KB).
- Storage bucket `backgrounds` (private, 8 MB, jpeg/png/webp). Each user can read, upload,
  replace and delete only files under their own folder `<user id>/...`; the app shows them
  through short-lived signed URLs.
*/

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION get_my_settings()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT coalesce((SELECT settings FROM profiles WHERE id = auth.uid()), '{}'::jsonb);
$$;

CREATE OR REPLACE FUNCTION update_my_settings(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN RAISE EXCEPTION 'BAD_SETTINGS'; END IF;
  IF octet_length(p_patch::text) > 4096 THEN RAISE EXCEPTION 'BAD_SETTINGS'; END IF;
  UPDATE profiles SET settings = settings || p_patch WHERE id = auth.uid() RETURNING settings INTO v;
  IF v IS NOT NULL AND octet_length(v::text) > 8192 THEN RAISE EXCEPTION 'BAD_SETTINGS'; END IF;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_my_settings(), update_my_settings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_my_settings(), update_my_settings(jsonb) TO authenticated;

-- ---------- storage ----------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('backgrounds', 'backgrounds', false, 8388608, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = 8388608, allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

DROP POLICY IF EXISTS "backgrounds_select_own" ON storage.objects;
CREATE POLICY "backgrounds_select_own" ON storage.objects FOR SELECT
  TO authenticated USING (bucket_id = 'backgrounds' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "backgrounds_insert_own" ON storage.objects;
CREATE POLICY "backgrounds_insert_own" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (bucket_id = 'backgrounds' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "backgrounds_update_own" ON storage.objects;
CREATE POLICY "backgrounds_update_own" ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'backgrounds' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'backgrounds' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "backgrounds_delete_own" ON storage.objects;
CREATE POLICY "backgrounds_delete_own" ON storage.objects FOR DELETE
  TO authenticated USING (bucket_id = 'backgrounds' AND (storage.foldername(name))[1] = auth.uid()::text);
