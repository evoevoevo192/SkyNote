/*
# Lock down profiles table

The previous migration created `profiles` with only a SELECT grant, but the
project's default grants on the public schema still gave anon + authenticated
full INSERT/UPDATE/DELETE on it. That lets any client create or rewrite a
profile row — including setting is_admin=true — bypassing register_profile.

This migration revokes those defaults on `profiles` so the only write path is
the SECURITY DEFINER `register_profile(text)` function, which derives the id
from auth.uid() and sets is_admin only for the first user.
*/

REVOKE INSERT, UPDATE, DELETE ON profiles FROM anon, authenticated;
REVOKE SELECT ON profiles FROM anon;

GRANT SELECT ON profiles TO authenticated;
