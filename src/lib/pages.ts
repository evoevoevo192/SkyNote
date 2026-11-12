import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import type { Board } from "./supabase";

export const MAX_PAGES = 10;
export const PAGE_NAME_MAX = 40;

export interface PageRow {
  id: string;
  user_id: string | null;
  board_id: string | null;
  page: number;
  name: string;
}

export interface PageInfo {
  page: number;
  name: string;
}

export function pagesErrorText(error: unknown): string {
  const m = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  if (m.includes("PAGE_NOT_EMPTY")) return "Страница не пустая: сначала уберите стикеры, нити и рисунок";
  return "Не удалось выполнить действие со страницей";
}

/**
 * Pages of the current board (personal, or one shared board).
 * A page exists if it has a row in board_pages or if any object lives on it; with nothing at all there is page 1.
 */
export function useBoardPages(view: Board, boardId: string | null, userId: string, objectPages: number[]) {
  const enabled = view === "private" || (view === "shared" && !!boardId);
  const key = view === "shared" ? (boardId ?? "none") : "private";
  const [rows, setRows] = useState<PageRow[]>([]);
  const [current, setCurrent] = useState<Record<string, number>>({});
  const alive = useRef(true);

  const isMine = useCallback(
    (r: Partial<PageRow>) => (view === "shared" ? r.board_id === boardId : !r.board_id && r.user_id === userId),
    [view, boardId, userId]
  );

  const load = useCallback(async () => {
    if (!enabled) {
      setRows([]);
      return;
    }
    let q = supabase.from("board_pages").select("id, user_id, board_id, page, name");
    q = view === "shared" ? q.eq("board_id", boardId as string) : q.is("board_id", null).eq("user_id", userId);
    const { data, error } = await q;
    if (error) {
      console.error("Стикеры: не удалось загрузить страницы", error);
      return;
    }
    if (alive.current) setRows((data ?? []) as PageRow[]);
  }, [enabled, view, boardId, userId]);

  useEffect(() => {
    alive.current = true;
    setRows([]);
    load();
    if (!enabled) return () => void (alive.current = false);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    const channel = supabase
      .channel(`pages-${key}-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "board_pages" }, (payload) => {
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string }).id;
          if (id) setRows((prev) => (prev.some((r) => r.id === id) ? prev.filter((r) => r.id !== id) : prev));
          return;
        }
        const row = payload.new as PageRow;
        if (!row || !isMine(row)) return;
        setRows((prev) => {
          const i = prev.findIndex((r) => r.id === row.id);
          if (i === -1) return prev.some((r) => r.page === row.page) ? prev.map((r) => (r.page === row.page ? row : r)) : [...prev, row];
          const next = prev.slice();
          next[i] = { ...prev[i], ...row };
          return next;
        });
      })
      .subscribe();
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
      supabase.removeChannel(channel);
    };
  }, [enabled, key, userId, load, isMine]);

  const objectKey = objectPages.join(",");
  const pages: PageInfo[] = useMemo(() => {
    const names = new Map<number, string>();
    rows.forEach((r) => names.set(r.page, r.name));
    objectPages.forEach((p) => {
      if (!names.has(p)) names.set(p, "");
    });
    if (names.size === 0) names.set(1, "");
    return Array.from(names.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([page, name]) => ({ page, name }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, objectKey]);

  const wanted = current[key] ?? 1;
  const page = pages.some((p) => p.page === wanted) ? wanted : (pages.find((p) => p.page > wanted) ?? pages[pages.length - 1]).page;
  const index = pages.findIndex((p) => p.page === page);

  const setPage = useCallback((p: number) => setCurrent((c) => (c[key] === p ? c : { ...c, [key]: p })), [key]);
  const go = useCallback(
    (delta: number) => {
      const i = pages.findIndex((p) => p.page === page) + delta;
      if (i >= 0 && i < pages.length) setPage(pages[i].page);
    },
    [pages, page, setPage]
  );

  const scope = useCallback(
    (p: number) => (view === "shared" ? { board_id: boardId as string, page: p } : { user_id: userId, page: p }),
    [view, boardId, userId]
  );

  /** Make sure every page that exists only "virtually" (page 1, or via objects) also has a row. */
  const ensureRows = useCallback(
    async (list: number[]) => {
      for (const p of list) {
        if (rows.some((r) => r.page === p)) continue;
        const { data, error } = await supabase.from("board_pages").insert({ ...scope(p), name: "" }).select("id, user_id, board_id, page, name").single();
        if (error) {
          if (!String(error.message).includes("duplicate key")) throw error;
        } else if (data && alive.current) {
          setRows((prev) => (prev.some((r) => r.page === p) ? prev : [...prev, data as PageRow]));
        }
      }
    },
    [rows, scope]
  );

  const add = useCallback(async (): Promise<string | null> => {
    if (!enabled) return null;
    if (pages.length >= MAX_PAGES) return `Можно создать не больше ${MAX_PAGES} страниц`;
    const used = new Set(pages.map((p) => p.page));
    const max = Math.max(...used);
    let n = max < MAX_PAGES ? max + 1 : 0;
    if (!n) for (let i = 1; i <= MAX_PAGES; i++) if (!used.has(i)) { n = i; break; }
    try {
      await ensureRows(pages.map((p) => p.page));
      const { data, error } = await supabase.from("board_pages").insert({ ...scope(n), name: "" }).select("id, user_id, board_id, page, name").single();
      if (error) throw error;
      if (data && alive.current) setRows((prev) => (prev.some((r) => r.page === n) ? prev : [...prev, data as PageRow]));
      setPage(n);
      return null;
    } catch (e) {
      console.error(e);
      return pagesErrorText(e);
    }
  }, [enabled, pages, ensureRows, scope, setPage]);

  const rename = useCallback(
    async (p: number, name: string): Promise<string | null> => {
      const clean = name.trim().slice(0, PAGE_NAME_MAX);
      try {
        const row = rows.find((r) => r.page === p);
        if (row) {
          setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, name: clean } : r)));
          const { error } = await supabase.from("board_pages").update({ name: clean }).eq("id", row.id);
          if (error) throw error;
        } else {
          const { data, error } = await supabase.from("board_pages").insert({ ...scope(p), name: clean }).select("id, user_id, board_id, page, name").single();
          if (error) throw error;
          if (data) setRows((prev) => [...prev.filter((r) => r.page !== p), data as PageRow]);
        }
        return null;
      } catch (e) {
        console.error(e);
        load();
        return pagesErrorText(e);
      }
    },
    [rows, scope, load]
  );

  const remove = useCallback(
    async (p: number): Promise<string | null> => {
      const row = rows.find((r) => r.page === p);
      if (!row) return "Страница не пустая: сначала уберите стикеры, нити и рисунок";
      const { error } = await supabase.from("board_pages").delete().eq("id", row.id);
      if (error) {
        console.error(error);
        return pagesErrorText(error);
      }
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      return null;
    },
    [rows]
  );

  return { pages, page, index, setPage, go, add, rename, remove, reload: load };
}

export type PagesApi = ReturnType<typeof useBoardPages>;
