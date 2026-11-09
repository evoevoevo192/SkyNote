/*
# Edit rights for stickers on shared boards (notes.edit_mode)

- `notes.edit_mode`: 'author' (default, "Только я") | 'members' ("Я и участники").
  'members' is allowed only on shared boards and never on photos.
- RLS "notes_update": the author edits as before (while still a member of a shared board);
  any other member may edit a sticker only when board = 'shared', edit_mode = 'members',
  type <> 'photo' and they are a member of that board.
- Trigger `notes_guard_collab_update` (BEFORE UPDATE): when the editor is not the author, only
  title, body, color, font, pos_x, pos_y may change. Everything else, including edit_mode,
  photos and image fields, must stay identical, so only the author can change access.
- DELETE policy is unchanged: author or board owner only. Collaborators can never delete.
*/

ALTER TABLE notes ADD COLUMN IF NOT EXISTS edit_mode text NOT NULL DEFAULT 'author';

ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_edit_mode_check;
ALTER TABLE notes ADD CONSTRAINT notes_edit_mode_check
  CHECK (edit_mode IN ('author', 'members'));

ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_edit_mode_scope;
ALTER TABLE notes ADD CONSTRAINT notes_edit_mode_scope
  CHECK (edit_mode = 'author' OR (board = 'shared' AND type <> 'photo'));

GRANT INSERT (edit_mode), UPDATE (edit_mode) ON notes TO authenticated;

DROP POLICY IF EXISTS "notes_update" ON notes;
CREATE POLICY "notes_update" ON notes FOR UPDATE
  TO authenticated
  USING (
    (user_id = auth.uid() AND (board <> 'shared' OR is_board_member(board_id)))
    OR (board = 'shared' AND edit_mode = 'members' AND type <> 'photo' AND is_board_member(board_id))
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (board = 'shared' AND edit_mode = 'members' AND type <> 'photo' AND is_board_member(board_id))
  );

CREATE OR REPLACE FUNCTION notes_guard_collab_update()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM OLD.user_id THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.board IS DISTINCT FROM OLD.board
       OR NEW.board_id IS DISTINCT FROM OLD.board_id
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.edit_mode IS DISTINCT FROM OLD.edit_mode
       OR NEW.photos IS DISTINCT FROM OLD.photos
       OR NEW.image_path IS DISTINCT FROM OLD.image_path
       OR NEW.image_fit IS DISTINCT FROM OLD.image_fit
       OR NEW.image_height IS DISTINCT FROM OLD.image_height
       OR NEW.image_align IS DISTINCT FROM OLD.image_align
       OR NEW.image_url IS DISTINCT FROM OLD.image_url
       OR NEW.width IS DISTINCT FROM OLD.width
       OR NEW.aspect IS DISTINCT FROM OLD.aspect
       OR NEW.caption IS DISTINCT FROM OLD.caption THEN
      RAISE EXCEPTION 'ONLY_AUTHOR_CAN_CHANGE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_guard_collab_update ON notes;
CREATE TRIGGER notes_guard_collab_update
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION notes_guard_collab_update();
