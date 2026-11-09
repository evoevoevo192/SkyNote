/*
# Fix: editing the text of a sticker failed ("Не удалось сохранить заметку")

The editor saves { title, body, color, font, photos } together. `photos` was added in
20261027180832 AFTER the table-wide grants had been replaced by column-level ones
(20261026175809), so the column never got an UPDATE/INSERT grant and every update that
included it was rejected with "permission denied for table notes".

Row-level security is unchanged: only the author (or, on shared boards with edit_mode =
'members', a member - the trigger notes_guard_collab_update still forbids members to touch
`photos`) can update a row.
*/
GRANT INSERT (photos), UPDATE (photos) ON notes TO authenticated;
