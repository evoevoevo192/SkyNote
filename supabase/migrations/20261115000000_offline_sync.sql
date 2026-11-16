/*
# Offline-first: мягкое удаление, версии и клиентские id

* ИСПРАВЛЕНИЕ: миграция 20261113000000 по ошибке сделала notes_update «только автор» и сняла
  совместное редактирование («Я и участники»). Политика возвращена здесь (и исправлена в самом файле 20261113).
* `notes.deleted_at`, `connections.deleted_at` — мягкое удаление. Строки не стираются, а помечаются;
  клиенты синхронизируют пометку, как обычное изменение. Удаляют через функции
  `soft_delete_note(id)` / `soft_delete_connection(id)` с теми же правами, что были у DELETE:
  - стикер/фото: автор; на доске с друзьями — владелец доски или автор-участник; админ — на личных.
  - нить: автор или владелец доски.
* `connections.updated_at` (+ триггер) — нужен для синхронизации «побеждает более поздняя версия».
* Уникальность пары (a_id, b_id) теперь только среди неудалённых нитей (можно заново соединить объекты).
* Клиент сам создаёт id (uuid) и created_at, поэтому без сети можно создавать объекты:
  GRANT INSERT (id, created_at) на notes, GRANT INSERT (id) на connections и board_pages.
* `purge_deleted(days)` — окончательно стирает старые помеченные строки (запускать вручную или по cron).
*/

-- ---------- fix: collaborative editing ----------
DROP POLICY IF EXISTS "notes_update" ON notes;
CREATE POLICY "notes_update" ON notes FOR UPDATE
  TO authenticated
  USING (
    board <> 'public'
    AND (
      (user_id = auth.uid() AND (board <> 'shared' OR is_board_member(board_id)))
      OR (board = 'shared' AND edit_mode = 'members' AND type <> 'photo' AND is_board_member(board_id))
    )
  )
  WITH CHECK (
    board <> 'public'
    AND (
      user_id = auth.uid()
      OR (board = 'shared' AND edit_mode = 'members' AND type <> 'photo' AND is_board_member(board_id))
    )
  );

-- ---------- columns ----------
ALTER TABLE notes ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS notes_updated_idx ON notes (updated_at);
CREATE INDEX IF NOT EXISTS connections_updated_idx ON connections (updated_at);

DROP TRIGGER IF EXISTS connections_touch_updated_at ON connections;
CREATE TRIGGER connections_touch_updated_at
  BEFORE UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_a_id_b_id_key;
DROP INDEX IF EXISTS connections_pair_live_idx;
CREATE UNIQUE INDEX connections_pair_live_idx ON connections (a_id, b_id) WHERE deleted_at IS NULL;

-- ---------- client-generated ids ----------
GRANT INSERT (id, created_at) ON notes TO authenticated;
GRANT INSERT (id) ON connections TO authenticated;
GRANT INSERT (id) ON board_pages TO authenticated;

-- ---------- soft delete ----------
CREATE OR REPLACE FUNCTION soft_delete_note(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  n notes%ROWTYPE;
  allowed boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT * INTO n FROM notes WHERE id = p_id;
  IF n.id IS NULL OR n.deleted_at IS NOT NULL THEN RETURN; END IF;
  IF n.board = 'shared' THEN
    allowed := is_board_owner(n.board_id) OR (n.user_id = auth.uid() AND is_board_member(n.board_id));
  ELSE
    allowed := n.user_id = auth.uid()
      OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin);
  END IF;
  IF NOT allowed THEN RAISE EXCEPTION 'NOT_ALLOWED'; END IF;
  UPDATE connections SET deleted_at = now() WHERE (a_id = p_id OR b_id = p_id) AND deleted_at IS NULL;
  UPDATE notes SET deleted_at = now() WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION soft_delete_connection(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c connections%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT * INTO c FROM connections WHERE id = p_id;
  IF c.id IS NULL OR c.deleted_at IS NOT NULL THEN RETURN; END IF;
  IF NOT (c.user_id = auth.uid() OR (c.board = 'shared' AND is_board_owner(c.board_id))) THEN
    RAISE EXCEPTION 'NOT_ALLOWED';
  END IF;
  UPDATE connections SET deleted_at = now() WHERE id = p_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION soft_delete_note(uuid), soft_delete_connection(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION soft_delete_note(uuid), soft_delete_connection(uuid) TO authenticated;

-- ---------- purge old tombstones (manual / cron) ----------
CREATE OR REPLACE FUNCTION purge_deleted(p_days integer DEFAULT 30)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  DELETE FROM connections WHERE deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => p_days);
  DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => p_days);
$$;
REVOKE EXECUTE ON FUNCTION purge_deleted(integer) FROM PUBLIC, anon, authenticated;

-- ---------- pages trigger: soft-deleted objects do not block page deletion ----------
CREATE OR REPLACE FUNCTION board_pages_before_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF OLD.board_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM boards WHERE id = OLD.board_id) THEN RETURN OLD; END IF;
  IF OLD.board_id IS NULL AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN RETURN OLD; END IF;
  IF OLD.board_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM notes WHERE board = 'private' AND user_id = OLD.user_id AND page = OLD.page AND deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM connections WHERE board = 'private' AND user_id = OLD.user_id AND page = OLD.page AND deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM drawings WHERE user_id = OLD.user_id AND page = OLD.page AND jsonb_array_length(strokes) > 0) THEN
      RAISE EXCEPTION 'PAGE_NOT_EMPTY';
    END IF;
    DELETE FROM drawings WHERE user_id = OLD.user_id AND page = OLD.page;
  ELSE
    IF EXISTS (SELECT 1 FROM notes WHERE board = 'shared' AND board_id = OLD.board_id AND page = OLD.page AND deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM connections WHERE board = 'shared' AND board_id = OLD.board_id AND page = OLD.page AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'PAGE_NOT_EMPTY';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;
