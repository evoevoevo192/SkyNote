/*
# Photos as board objects

A photo is the same kind of object as a sticker: a row in `notes`, only with
type = 'photo'. Position (pos_x / pos_y), board, author, RLS, updated_at and
deletion all work exactly as for stickers.

1. Modified table `notes`
- `type` text, default 'sticker', one of 'sticker' | 'photo'. Existing rows stay stickers.
- `image_url` text — public URL of the photo (photos only).
- `width` int, default 220, 100..600 — photo width on the desktop board in px.
- `aspect` double precision, > 0 — original width / height; the card height is
  always derived from it.
- `caption` text, up to 60 characters, optional.
- A photo must have image_url and aspect, and may live only on the private board.
- Old columns (image_path, image_fit, image_height, image_align, photos) are left
  untouched.

2. Security
- RLS policies on notes are unchanged (owner-scoped).
- Column grants: clients may INSERT type, image_url, width, aspect, caption and
  UPDATE image_url, width, aspect, caption. `type` can not be changed afterwards.

3. Storage
- New public-read bucket `photos` (10 MB limit, jpeg/png/webp). Files live in
  a folder named after the user id; only that user can write, update or delete
  them.
*/

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'sticker'
    CHECK (type IN ('sticker', 'photo')),
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS width int NOT NULL DEFAULT 220
    CHECK (width BETWEEN 100 AND 600),
  ADD COLUMN IF NOT EXISTS aspect double precision
    CHECK (aspect IS NULL OR aspect > 0),
  ADD COLUMN IF NOT EXISTS caption text
    CHECK (caption IS NULL OR char_length(caption) <= 60);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_photo_has_image') THEN
    ALTER TABLE notes ADD CONSTRAINT notes_photo_has_image
      CHECK (type <> 'photo' OR (image_url IS NOT NULL AND aspect IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_photo_private_only') THEN
    ALTER TABLE notes ADD CONSTRAINT notes_photo_private_only
      CHECK (type <> 'photo' OR board = 'private');
  END IF;
END;
$$;

GRANT INSERT (type, image_url, width, aspect, caption) ON notes TO authenticated;
GRANT UPDATE (image_url, width, aspect, caption) ON notes TO authenticated;

-- ---------- storage: photos bucket ----------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('photos', 'photos', true, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "photos_read" ON storage.objects;
CREATE POLICY "photos_read" ON storage.objects FOR SELECT
  TO public USING (bucket_id = 'photos');

DROP POLICY IF EXISTS "photos_insert_own" ON storage.objects;
CREATE POLICY "photos_insert_own" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (
    bucket_id = 'photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "photos_update_own" ON storage.objects;
CREATE POLICY "photos_update_own" ON storage.objects FOR UPDATE
  TO authenticated USING (
    bucket_id = 'photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "photos_delete_own" ON storage.objects;
CREATE POLICY "photos_delete_own" ON storage.objects FOR DELETE
  TO authenticated USING (
    bucket_id = 'photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
