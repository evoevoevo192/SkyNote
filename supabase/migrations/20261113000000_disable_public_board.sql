/*
  Общая доска отключена (нет модерации). Данные НЕ удаляются.
  * Читать заметки board='public' больше нельзя (видит только автор — свои старые).
  * Создавать и менять такие заметки нельзя.
  * Удалять свои старые заметки автор по-прежнему может (политика notes_delete не меняется).
  * Политика notes_hide_from_blocked (RESTRICTIVE) не затрагивается.
*/
DROP POLICY IF EXISTS "notes_select" ON notes;
CREATE POLICY "notes_select" ON notes FOR SELECT
  TO authenticated USING (
    (board = 'public' AND user_id = auth.uid())
    OR (board = 'private' AND user_id = auth.uid())
    OR (board = 'shared' AND is_board_member(board_id))
  );

DROP POLICY IF EXISTS "notes_insert" ON notes;
CREATE POLICY "notes_insert" ON notes FOR INSERT
  TO authenticated WITH CHECK (
    user_id = auth.uid()
    AND (
      (board = 'private' AND board_id IS NULL)
      OR (board = 'shared' AND is_board_member(board_id))
    )
  );

DROP POLICY IF EXISTS "notes_update" ON notes;
CREATE POLICY "notes_update" ON notes FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() AND board <> 'public' AND (board <> 'shared' OR is_board_member(board_id)))
  WITH CHECK (user_id = auth.uid() AND board <> 'public');
