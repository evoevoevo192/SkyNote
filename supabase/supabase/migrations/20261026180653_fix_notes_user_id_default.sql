/*
# Fix: default notes.user_id to the signed-in user

The notes INSERT policy requires user_id = auth.uid(), but the column had no
default, so a client insert (which omits user_id) wrote NULL and failed the
WITH CHECK. This migration backfills NULL rows and sets the default so inserts
succeed without the client threading user_id through every call.
*/

UPDATE notes SET user_id = auth.uid() WHERE user_id IS NULL;

ALTER TABLE notes
  ALTER COLUMN user_id SET DEFAULT auth.uid();
