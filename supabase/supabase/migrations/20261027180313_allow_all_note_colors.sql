/*
# Complete registration flow and color constraint compatibility

1. Database compatibility
- Expand the existing `notes_color_check` constraint to include all ten colors
  already offered by the application: purple, teal, red, mint, and lavender.
- Existing notes and their data are preserved; this only permits the values the
  current interface already presents.

2. Registration behavior
- Keep the existing `register_profile(text)` RPC and its security model.
- No auth users, profiles, roles, or notes are deleted or rewritten.
- The frontend handles projects with email confirmation enabled: it reports
  that the user must verify email, then creates the profile after the first
  successful sign-in.
*/

ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_color_check;
ALTER TABLE notes ADD CONSTRAINT notes_color_check CHECK (
  color IN ('yellow', 'pink', 'green', 'blue', 'orange', 'purple', 'teal', 'red', 'mint', 'lavender')
);
