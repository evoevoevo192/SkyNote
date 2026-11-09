/*
# Add board column to notes

1. Modified Tables
- `notes`
  - add `board` (text, not null, default 'private', CHECK in ('private','public'))
  - distinguishes notes that belong to the owner's personal board ('private')
    from notes shown on the shared public board ('public').
  - Existing rows default to 'private' (they are the owner's personal notes).

2. Security
- RLS unchanged: the table stays open to anon + authenticated (the app uses a
  client-side gate, not Supabase auth). No policy changes needed.
*/

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS board text NOT NULL DEFAULT 'private'
  CHECK (board IN ('private','public'));
