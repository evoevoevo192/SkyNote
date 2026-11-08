/*
# Multi-photo support for sticky notes

1. Purpose
- Replace the single fixed image strip with up to 4 freely positioned,
  resizable, rotatable photos per sticky note (Canva/Google Keep style).
- Each photo stores: url (public URL), path (storage path for deletion),
  x and y (center in % of sticker width/height), width (% of sticker width),
  rotation (degrees), zIndex, aspect (original width/height), and frame style.

2. Schema changes
- Add `photos jsonb` column to public.notes, default '[]'::jsonb, NOT NULL.
- Existing single-image columns (image_path, image_fit, image_height,
  image_align) are NOT removed or altered — old notes keep working and are
  converted to the new array representation in the app on first view.

3. Security
- No changes to RLS policies or grants: photos lives on the same notes
  table, which is already locked to authenticated owner-scoped CRUD.
- The new column is writable through the existing UPDATE policy; no extra
  grant is needed because column-level privileges already allow updating
  notes columns for the owner.
*/

ALTER TABLE public.notes
  ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb;
