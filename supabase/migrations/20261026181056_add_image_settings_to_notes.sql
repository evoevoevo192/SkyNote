/*
# Add image settings to notes

Stores the user's chosen photo layout so it survives reloads:
- image_fit: 'cover' (fill, crop) or 'contain' (show whole image)
- image_height: pixel height of the image inside the note (40..400)
- image_align: 'left' | 'center' | 'right' horizontal alignment within the note

All three default to sensible values and are user-editable through the
note editor. RLS unchanged: these are content columns added to the
existing UPDATE/INSERT grants.
*/

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS image_fit text NOT NULL DEFAULT 'cover'
    CHECK (image_fit IN ('cover','contain')),
  ADD COLUMN IF NOT EXISTS image_height int NOT NULL DEFAULT 120
    CHECK (image_height BETWEEN 40 AND 400),
  ADD COLUMN IF NOT EXISTS image_align text NOT NULL DEFAULT 'center'
    CHECK (image_align IN ('left','center','right'));

GRANT UPDATE (image_fit, image_height, image_align) ON notes TO authenticated;
GRANT INSERT (image_fit, image_height, image_align) ON notes TO authenticated;
