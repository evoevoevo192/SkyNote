/*
  # Блокировка стикера кодом (4–6 цифр)

  Для кого: личные стикеры и стикеры автора на общих досках (type = 'sticker').

  ## Как устроено
  - notes.locked (boolean) — публичный флаг «стикер закрыт». Клиент меняет его только через функции.
  - note_locks — закрытая таблица (RLS включён, прав у клиентов нет, в Realtime не входит):
      lock_hash  — bcrypt-хэш кода с солью (crypt + gen_salt('bf')); сам код нигде не хранится;
      title / body / photos / image_path — настоящее содержимое стикера;
      failed / rounds / wait_until — счётчик неверных попыток.
    Когда стикер блокируется, содержимое переносится из notes в note_locks, а в notes остаются пустые
    title, body, photos и image_path. Поэтому текст и фото не уходят клиенту ни через запрос, ни через Realtime,
    пока не проверен код.
  - Хэш лежит не в notes, а в note_locks: к notes у клиентов есть SELECT на всю таблицу и Realtime отдаёт
    строки целиком, значит хэш утёк бы, и короткий код подобрали бы перебором на своём компьютере.

  ## Функции (SECURITY DEFINER, только для authenticated)
  - lock_note(p_id, p_code)                     — поставить блокировку (только автор)
  - unlock_note(p_id, p_code) → jsonb           — вернуть содержимое при верном коде (автор и участники доски)
  - save_locked_note(p_id, p_code, p_patch)     — сохранить правки заблокированного стикера (только автор)
  - change_note_lock(p_id, p_old, p_new)        — сменить код (нужен текущий)
  - remove_note_lock(p_id, p_code)              — снять блокировку, содержимое возвращается в notes
  Ответ unlock_note / save_locked_note — jsonb: {"ok":true,...} или
  {"ok":false,"reason":"bad_code","left":N} / {"ok":false,"reason":"wait","seconds":N}.

  ## Неверные коды
  5 неверных попыток подряд → пауза 30 секунд (на сервере, на стикер, а не на человека, чтобы нельзя было
  обойти несколькими аккаунтами). Каждая следующая серия удваивает паузу, максимум 15 минут.
  Верный код сбрасывает счётчики.

  ## Защита от записи в обход
  Триггер notes_keep_locked_content: у заблокированного стикера title, body, photos, image_path и locked
  нельзя изменить обычным UPDATE (даже участнику с правом «Я и участники»).

  Забытый код восстановить нельзя: содержимое хранится только за этим кодом.
*/

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE notes ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS note_locks (
  note_id    uuid PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  lock_hash  text NOT NULL,
  title      text NOT NULL DEFAULT '',
  body       text NOT NULL DEFAULT '',
  photos     jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_path text,
  failed     integer NOT NULL DEFAULT 0,
  rounds     integer NOT NULL DEFAULT 0,
  wait_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE note_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON note_locks FROM PUBLIC, anon, authenticated;

-- ---------- locked content cannot be changed by a plain UPDATE ----------
CREATE OR REPLACE FUNCTION notes_keep_locked_content()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.note_lock_bypass', true) = '1' THEN
    RETURN NEW;
  END IF;
  IF OLD.locked THEN
    NEW.locked := true;
    NEW.title := OLD.title;
    NEW.body := OLD.body;
    NEW.photos := OLD.photos;
    NEW.image_path := OLD.image_path;
  ELSE
    NEW.locked := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_keep_locked_content ON notes;
CREATE TRIGGER notes_keep_locked_content
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION notes_keep_locked_content();

-- ---------- internal: who may try a code, and the check with the attempt counter ----------
CREATE OR REPLACE FUNCTION note_lock_verify(p_id uuid, p_code text, p_author_only boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  n notes%ROWTYPE;
  l note_locks%ROWTYPE;
  secs integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT * INTO n FROM notes WHERE id = p_id AND deleted_at IS NULL;
  IF n.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF p_author_only THEN
    IF n.user_id <> auth.uid() THEN RAISE EXCEPTION 'NOT_ALLOWED'; END IF;
  ELSE
    IF NOT (n.user_id = auth.uid()
            OR (n.board = 'shared' AND is_board_member(n.board_id) AND NOT is_blocked_by(n.user_id))) THEN
      RAISE EXCEPTION 'NOT_ALLOWED';
    END IF;
  END IF;

  SELECT * INTO l FROM note_locks WHERE note_id = p_id FOR UPDATE;
  IF l.note_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_locked');
  END IF;

  IF l.wait_until IS NOT NULL AND l.wait_until > now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wait',
      'seconds', ceil(extract(epoch FROM (l.wait_until - now())))::integer);
  END IF;

  IF p_code ~ '^[0-9]{4,6}$' AND l.lock_hash = crypt(p_code, l.lock_hash) THEN
    UPDATE note_locks SET failed = 0, rounds = 0, wait_until = NULL WHERE note_id = p_id;
    RETURN jsonb_build_object('ok', true);
  END IF;

  IF l.failed + 1 >= 5 THEN
    secs := LEAST(900, 30 * (2 ^ LEAST(l.rounds, 5))::integer);
    UPDATE note_locks SET failed = 0, rounds = l.rounds + 1, wait_until = now() + make_interval(secs => secs)
      WHERE note_id = p_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'wait', 'seconds', secs);
  END IF;

  UPDATE note_locks SET failed = l.failed + 1 WHERE note_id = p_id;
  RETURN jsonb_build_object('ok', false, 'reason', 'bad_code', 'left', 5 - (l.failed + 1));
END;
$$;
REVOKE EXECUTE ON FUNCTION note_lock_verify(uuid, text, boolean) FROM PUBLIC, anon, authenticated;

-- ---------- lock ----------
CREATE OR REPLACE FUNCTION lock_note(p_id uuid, p_code text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  n notes%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF p_code IS NULL OR p_code !~ '^[0-9]{4,6}$' THEN RAISE EXCEPTION 'BAD_CODE_FORMAT'; END IF;
  SELECT * INTO n FROM notes WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF n.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF n.user_id <> auth.uid() OR n.type <> 'sticker' OR n.board NOT IN ('private', 'shared') THEN
    RAISE EXCEPTION 'NOT_ALLOWED';
  END IF;
  IF n.board = 'shared' AND NOT is_board_member(n.board_id) THEN RAISE EXCEPTION 'NOT_ALLOWED'; END IF;
  IF n.locked THEN RAISE EXCEPTION 'ALREADY_LOCKED'; END IF;

  INSERT INTO note_locks (note_id, lock_hash, title, body, photos, image_path)
  VALUES (p_id, crypt(p_code, gen_salt('bf', 10)), n.title, n.body, COALESCE(n.photos, '[]'::jsonb), n.image_path);

  PERFORM set_config('app.note_lock_bypass', '1', true);
  UPDATE notes SET locked = true, title = '', body = '', photos = '[]'::jsonb, image_path = NULL WHERE id = p_id;
END;
$$;

-- ---------- open (read the content) ----------
CREATE OR REPLACE FUNCTION unlock_note(p_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  res jsonb;
  l note_locks%ROWTYPE;
BEGIN
  res := note_lock_verify(p_id, p_code, false);
  IF (res->>'ok')::boolean IS NOT TRUE THEN RETURN res; END IF;
  SELECT * INTO l FROM note_locks WHERE note_id = p_id;
  RETURN jsonb_build_object('ok', true, 'title', l.title, 'body', l.body, 'photos', l.photos, 'image_path', l.image_path);
END;
$$;

-- ---------- save edits of a locked sticker (author) ----------
CREATE OR REPLACE FUNCTION save_locked_note(p_id uuid, p_code text, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  res jsonb;
BEGIN
  res := note_lock_verify(p_id, p_code, true);
  IF (res->>'ok')::boolean IS NOT TRUE THEN RETURN res; END IF;
  UPDATE note_locks SET
    title = CASE WHEN p_patch ? 'title' THEN left(COALESCE(p_patch->>'title', ''), 200) ELSE title END,
    body = CASE WHEN p_patch ? 'body' THEN left(COALESCE(p_patch->>'body', ''), 20000) ELSE body END,
    photos = CASE WHEN p_patch ? 'photos' AND jsonb_typeof(p_patch->'photos') = 'array' THEN p_patch->'photos' ELSE photos END,
    image_path = CASE WHEN p_patch ? 'image_path' THEN p_patch->>'image_path' ELSE image_path END
  WHERE note_id = p_id;
  PERFORM set_config('app.note_lock_bypass', '1', true);
  UPDATE notes SET updated_at = now() WHERE id = p_id; -- other devices see that something changed
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------- change the code ----------
CREATE OR REPLACE FUNCTION change_note_lock(p_id uuid, p_old text, p_new text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  res jsonb;
BEGIN
  IF p_new IS NULL OR p_new !~ '^[0-9]{4,6}$' THEN RAISE EXCEPTION 'BAD_CODE_FORMAT'; END IF;
  res := note_lock_verify(p_id, p_old, true);
  IF (res->>'ok')::boolean IS NOT TRUE THEN RETURN res; END IF;
  UPDATE note_locks SET lock_hash = crypt(p_new, gen_salt('bf', 10)), failed = 0, rounds = 0, wait_until = NULL
    WHERE note_id = p_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------- remove the lock ----------
CREATE OR REPLACE FUNCTION remove_note_lock(p_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  res jsonb;
  l note_locks%ROWTYPE;
BEGIN
  res := note_lock_verify(p_id, p_code, true);
  IF (res->>'ok')::boolean IS NOT TRUE THEN RETURN res; END IF;
  SELECT * INTO l FROM note_locks WHERE note_id = p_id;
  PERFORM set_config('app.note_lock_bypass', '1', true);
  UPDATE notes SET locked = false, title = l.title, body = l.body, photos = l.photos, image_path = l.image_path
    WHERE id = p_id;
  DELETE FROM note_locks WHERE note_id = p_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION lock_note(uuid, text), unlock_note(uuid, text), save_locked_note(uuid, text, jsonb),
  change_note_lock(uuid, text, text), remove_note_lock(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION lock_note(uuid, text), unlock_note(uuid, text), save_locked_note(uuid, text, jsonb),
  change_note_lock(uuid, text, text), remove_note_lock(uuid, text) TO authenticated;
