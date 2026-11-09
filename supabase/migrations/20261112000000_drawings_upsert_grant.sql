/*
# Fix: drawings were not saved

The app saves with upsert (INSERT ... ON CONFLICT DO UPDATE). PostgreSQL requires the UPDATE
privilege on every column that the DO UPDATE branch sets, and the earlier migration granted
UPDATE only on (strokes, updated_at). The save failed with "permission denied for table drawings".

Changing user_id stays impossible: the policy WITH CHECK requires user_id = auth.uid().
*/
GRANT UPDATE (user_id, board, strokes, updated_at) ON drawings TO authenticated;
