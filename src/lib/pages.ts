import { useCallback, useMemo, useState } from "react";
import { local, useTable } from "./localdb";
import { useOnline } from "./sync";
import { pageInsert, pageRename, pageDelete } from "./data";
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

const NOT_EMPTY = "Страница не пустая: сначала уберите стикеры, нити и рисунок";
const NO_NET = "Нет сети: доска открыта только для чтения";

/**
 * Pages of the current board (personal, or one shared board), kept in the local database.
 * A page exists if it has a row in board_pages or if any object lives on it; with nothing at all there is page 1.
 */
export function useBoardPages(view: Board, boardId: string | null, userId: string, objectPages: number[]) {
  const enabled = view === "private" || (view === "shared" && !!boardId);
  const key = view === "shared" ? (boardId ?? "none") : "private";
  const all = useTable(local.pages);
  const online = useOnline();
  const readOnly = view === "shared" && !online;
  const [current, setCurrent] = useState<Record<string, number>>({});

  const rows = useMemo(
    () => (enabled ? all.filter((r) => (view === "shared" ? r.board_id === boardId : !r.board_id && r.user_id === userId)) : []),
    [all, enabled, view, boardId, userId]
  ) as PageRow[];

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

  const scope = useMemo(
    () => (view === "shared" ? { user_id: null, board_id: boardId as string } : { user_id: userId, board_id: null }),
    [view, boardId, userId]
  );

  /** Make sure every page that exists only "virtually" (page 1, or via objects) also has a row. */
  const ensureRows = useCallback(
    (list: number[]) => {
      for (const p of list) if (!rows.some((r) => r.page === p)) pageInsert(scope, p, "");
    },
    [rows, scope]
  );

  const add = useCallback(async (): Promise<string | null> => {
    if (!enabled) return null;
    if (readOnly) return NO_NET;
    if (pages.length >= MAX_PAGES) return `Можно создать не больше ${MAX_PAGES} страниц`;
    const used = new Set(pages.map((p) => p.page));
    const max = Math.max(...used);
    let n = max < MAX_PAGES ? max + 1 : 0;
    if (!n) for (let i = 1; i <= MAX_PAGES; i++) if (!used.has(i)) { n = i; break; }
    ensureRows(pages.map((p) => p.page));
    pageInsert(scope, n, "");
    setPage(n);
    return null;
  }, [enabled, readOnly, pages, ensureRows, scope, setPage]);

  const rename = useCallback(
    async (p: number, name: string): Promise<string | null> => {
      if (readOnly) return NO_NET;
      const clean = name.trim().slice(0, PAGE_NAME_MAX);
      const row = rows.find((r) => r.page === p);
      if (row) pageRename(row.id, clean);
      else pageInsert(scope, p, clean);
      return null;
    },
    [rows, scope, readOnly]
  );

  const remove = useCallback(
    async (p: number): Promise<string | null> => {
      if (readOnly) return NO_NET;
      const inScope = (n: { board?: string; board_id?: string | null; user_id?: string | null }) =>
        view === "shared" ? n.board_id === boardId : n.board === "private" && n.user_id === userId;
      const busy =
        local.notes.all().some((n) => (n.page ?? 1) === p && inScope(n)) ||
        local.connections.all().some((c) => (c.page ?? 1) === p && inScope(c)) ||
        (view === "private" && (local.drawings.get(`${userId}|${p}`)?.strokes.length ?? 0) > 0);
      if (busy) return NOT_EMPTY;
      const row = rows.find((r) => r.page === p);
      if (!row) return NOT_EMPTY;
      pageDelete(row.id);
      return null;
    },
    [rows, readOnly, view, boardId, userId]
  );

  const reload = useCallback(async () => undefined, []);

  return { pages, page, index, setPage, go, add, rename, remove, reload };
}

export type PagesApi = ReturnType<typeof useBoardPages>;
