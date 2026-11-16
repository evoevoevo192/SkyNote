import { useCallback, useMemo } from "react";
import { local, useTable } from "./localdb";
import { useOnline } from "./sync";
import { connCreate, connPatch, connDelete } from "./data";
import type { Board } from "./supabase";

export interface Connection {
  id: string;
  user_id: string;
  board: "private" | "shared";
  board_id: string | null;
  page?: number;
  a_id: string;
  b_id: string;
  color: string;
  dashed: boolean;
  label: string;
  created_at: string;
}

export const THREAD_COLORS = ["#d62828", "#1f2430", "#e9a100", "#2b7de9", "#2a9d5c", "#8e4ec6"];
export const THREAD_COLOR_NAMES = ["Красный", "Чёрный", "Жёлтый", "Синий", "Зелёный", "Фиолетовый"];
export const THREAD_LABEL_MAX = 60;

export function threadErrorText(error: unknown): string {
  const m = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  if (m.includes("duplicate key")) return "Между этими объектами уже есть нить";
  if (m.includes("DIFFERENT_BOARDS")) return "Нить можно протянуть только между объектами одной доски";
  if (m.includes("DIFFERENT_PAGES")) return "Нить можно протянуть только между объектами одной страницы";
  if (m.includes("NOT_ON_PUBLIC_BOARD")) return "На общей доске нити не поддерживаются";
  return "Не удалось выполнить действие с нитью";
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export const NO_NET_TEXT = "Нет сети: доска открыта только для чтения";

/** Threads of the current board (private or one shared board): read from and written to the local database. */
export function useConnections(view: Board, boardId: string | null, userId: string) {
  const enabled = view === "private" || (view === "shared" && !!boardId);
  const all = useTable(local.connections);
  const online = useOnline();
  const readOnly = view === "shared" && !online;
  void userId;

  const items = useMemo(
    () => (enabled ? all.filter((c) => (view === "shared" ? c.board === "shared" && c.board_id === boardId : c.board === "private")) : []),
    [all, enabled, view, boardId]
  ) as Connection[];

  const find = useCallback((a: string, b: string) => items.find((c) => pairKey(c.a_id, c.b_id) === pairKey(a, b)) ?? null, [items]);

  /** One thread per pair: returns the existing one instead of creating a duplicate. */
  const create = useCallback(
    async (x: string, y: string): Promise<{ conn: Connection | null; existed: boolean; error: string | null }> => {
      const old = find(x, y);
      if (old) return { conn: old, existed: true, error: null };
      if (readOnly) return { conn: null, existed: false, error: NO_NET_TEXT };
      const na = local.notes.get(x);
      const nb = local.notes.get(y);
      if (!na || !nb) return { conn: null, existed: false, error: threadErrorText(null) };
      if ((na.page ?? 1) !== (nb.page ?? 1)) return { conn: null, existed: false, error: threadErrorText({ message: "DIFFERENT_PAGES" }) };
      if (na.board !== nb.board || (na.board_id ?? null) !== (nb.board_id ?? null)) return { conn: null, existed: false, error: threadErrorText({ message: "DIFFERENT_BOARDS" }) };
      const [a, b] = x < y ? [x, y] : [y, x];
      const row = connCreate({
        a_id: a,
        b_id: b,
        board: na.board === "shared" ? "shared" : "private",
        board_id: na.board_id ?? null,
        page: na.page ?? 1,
      });
      return { conn: row as Connection, existed: false, error: null };
    },
    [find, readOnly]
  );

  const update = useCallback(
    async (id: string, patch: Partial<Pick<Connection, "color" | "dashed" | "label">>) => {
      if (readOnly) return NO_NET_TEXT;
      connPatch(id, patch);
      return null;
    },
    [readOnly]
  );

  const remove = useCallback(
    async (id: string) => {
      if (readOnly) return NO_NET_TEXT;
      connDelete(id);
      return null;
    },
    [readOnly]
  );

  const reload = useCallback(async () => undefined, []);

  return { items, create, update, remove, find, reload };
}

export type ThreadsApi = ReturnType<typeof useConnections>;
