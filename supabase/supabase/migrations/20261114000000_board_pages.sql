/*
# Страницы на досках

У личной доски и у каждой доски с друзьями — свои страницы (до 10).

* `notes.page`, `drawings.page`, `connections.page` — номер страницы 1..10 (по умолчанию 1).
  Существующие данные остаются на странице 1.
* `drawings`: теперь один рисунок на (пользователь, страница) — первичный ключ (user_id, page).
* `connections`: триггер сам берёт page из стикеров и запрещает нить между разными страницами.
  Если стикер переносят на другую страницу, его нити удаляются (они были бы между страницами).
* `board_pages`: список страниц и их названия.
  - личная доска: user_id = владелец, board_id = NULL
  - доска с друзьями: board_id = доска, user_id = NULL (управляют все участники)
  Страница 1 существует всегда «виртуально», пока на доске нет других строк.
  Удалить можно только пустую страницу (триггер проверяет стикеры, нити и рисунок).
* Realtime включён для board_pages.
*/

-- ---------- notes ----------
ALTER TABLE notes ADD COLUMN IF NOT EXISTS page smallint NOT NULL DEFAULT 1;
ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_page_range;
ALTER TABLE notes ADD CONSTRAINT notes_page_range CHECK (page BETWEEN 1 AND 10);
GRANT INSERT (page), UPDATE (page) ON notes TO authenticated;
CREATE INDEX IF NOT EXISTS notes_page_idx ON notes (board_id, page);

-- ---------- drawings ----------
ALTER TABLE drawings ADD COLUMN IF NOT EXISTS page smallint NOT NULL DEFAULT 1;
ALTER TABLE drawings DROP CONSTRAINT IF EXISTS drawings_page_range;
ALTER TABLE drawings ADD CONSTRAINT drawings_page_range CHECK (page BETWEEN 1 AND 10);
ALTER TABLE drawings DROP CONSTRAINT IF EXISTS drawings_pkey;
ALTER TABLE drawings ADD PRIMARY KEY (user_id, page);
-- upsert (ON CONFLICT DO UPDATE) ставит все вставляемые колонки, поэтому UPDATE нужен на каждую
GRANT INSERT (user_id, board, strokes, updated_at, page) ON drawings TO authenticated;
GRANT UPDATE (user_id, board, strokes, updated_at, page) ON drawings TO authenticated;

-- ---------- connections ----------
ALTER TABLE connections ADD COLUMN IF NOT EXISTS page smallint NOT NULL DEFAULT 1;
ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_page_range;
ALTER TABLE connections ADD CONSTRAINT connections_page_range CHECK (page BETWEEN 1 AND 10);

CREATE OR REPLACE FUNCTION connections_set_scope()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  na notes%ROWTYPE;
  nb notes%ROWTYPE;
BEGIN
  SELECT * INTO na FROM notes WHERE id = NEW.a_id;
  SELECT * INTO nb FROM notes WHERE id = NEW.b_id;
  IF na.id IS NULL OR nb.id IS NULL THEN RAISE EXCEPTION 'NOTE_NOT_FOUND'; END IF;
  IF na.board <> nb.board OR na.board_id IS DISTINCT FROM nb.board_id THEN
    RAISE EXCEPTION 'DIFFERENT_BOARDS';
  END IF;
  IF na.page <> nb.page THEN RAISE EXCEPTION 'DIFFERENT_PAGES'; END IF;
  IF na.board = 'public' THEN RAISE EXCEPTION 'NOT_ON_PUBLIC_BOARD'; END IF;
  IF na.board = 'private' AND (na.user_id <> auth.uid() OR nb.user_id <> auth.uid()) THEN
    RAISE EXCEPTION 'NOT_YOUR_NOTES';
  END IF;
  NEW.board := na.board;
  NEW.board_id := na.board_id;
  NEW.page := na.page;
  NEW.user_id := coalesce(auth.uid(), NEW.user_id);
  RETURN NEW;
END;
$$;

-- перенос стикера на другую страницу удаляет его нити
CREATE OR REPLACE FUNCTION notes_page_moved()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM connections WHERE a_id = NEW.id OR b_id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_page_moved ON notes;
CREATE TRIGGER notes_page_moved
  AFTER UPDATE OF page ON notes
  FOR EACH ROW WHEN (OLD.page IS DISTINCT FROM NEW.page)
  EXECUTE FUNCTION notes_page_moved();

-- ---------- board_pages ----------
CREATE TABLE IF NOT EXISTS board_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  board_id uuid REFERENCES boards(id) ON DELETE CASCADE,
  page smallint NOT NULL CHECK (page BETWEEN 1 AND 10),
  name text NOT NULL DEFAULT '' CHECK (char_length(name) <= 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (board_id IS NULL)),
  UNIQUE (user_id, page),
  UNIQUE (board_id, page)
);

ALTER TABLE board_pages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON board_pages FROM anon, authenticated;
GRANT SELECT, DELETE ON board_pages TO authenticated;
GRANT INSERT (user_id, board_id, page, name) ON board_pages TO authenticated;
GRANT UPDATE (name) ON board_pages TO authenticated;

DROP POLICY IF EXISTS "board_pages_select" ON board_pages;
CREATE POLICY "board_pages_select" ON board_pages FOR SELECT
  TO authenticated USING (
    (board_id IS NULL AND user_id = auth.uid())
    OR (board_id IS NOT NULL AND is_board_member(board_id))
  );

DROP POLICY IF EXISTS "board_pages_insert" ON board_pages;
CREATE POLICY "board_pages_insert" ON board_pages FOR INSERT
  TO authenticated WITH CHECK (
    (board_id IS NULL AND user_id = auth.uid())
    OR (board_id IS NOT NULL AND user_id IS NULL AND is_board_member(board_id))
  );

DROP POLICY IF EXISTS "board_pages_update" ON board_pages;
CREATE POLICY "board_pages_update" ON board_pages FOR UPDATE
  TO authenticated
  USING (
    (board_id IS NULL AND user_id = auth.uid())
    OR (board_id IS NOT NULL AND is_board_member(board_id))
  )
  WITH CHECK (
    (board_id IS NULL AND user_id = auth.uid())
    OR (board_id IS NOT NULL AND is_board_member(board_id))
  );

DROP POLICY IF EXISTS "board_pages_delete" ON board_pages;
CREATE POLICY "board_pages_delete" ON board_pages FOR DELETE
  TO authenticated USING (
    (board_id IS NULL AND user_id = auth.uid())
    OR (board_id IS NOT NULL AND is_board_member(board_id))
  );

-- удалить можно только пустую страницу
CREATE OR REPLACE FUNCTION board_pages_before_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- каскад при удалении доски / пользователя не блокируем
  IF OLD.board_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM boards WHERE id = OLD.board_id) THEN RETURN OLD; END IF;
  IF OLD.board_id IS NULL AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN RETURN OLD; END IF;
  IF OLD.board_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM notes WHERE board = 'private' AND user_id = OLD.user_id AND page = OLD.page)
       OR EXISTS (SELECT 1 FROM connections WHERE board = 'private' AND user_id = OLD.user_id AND page = OLD.page)
       OR EXISTS (SELECT 1 FROM drawings WHERE user_id = OLD.user_id AND page = OLD.page AND jsonb_array_length(strokes) > 0) THEN
      RAISE EXCEPTION 'PAGE_NOT_EMPTY';
    END IF;
    DELETE FROM drawings WHERE user_id = OLD.user_id AND page = OLD.page;
  ELSE
    IF EXISTS (SELECT 1 FROM notes WHERE board = 'shared' AND board_id = OLD.board_id AND page = OLD.page)
       OR EXISTS (SELECT 1 FROM connections WHERE board = 'shared' AND board_id = OLD.board_id AND page = OLD.page) THEN
      RAISE EXCEPTION 'PAGE_NOT_EMPTY';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS board_pages_before_delete ON board_pages;
CREATE TRIGGER board_pages_before_delete
  BEFORE DELETE ON board_pages
  FOR EACH ROW EXECUTE FUNCTION board_pages_before_delete();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'board_pages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.board_pages;
  END IF;
END;
$$;
