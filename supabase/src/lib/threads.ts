import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
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

/** Threads of the current board (private or one shared board), kept live with Realtime. */
export function useConnections(view: Board, boardId: string | null, userId: string) {
  const enabled = view === "private" || (view === "shared" && !!boardId);
  const [items, setItems] = useState<Connection[]>([]);
  const alive = useRef(true);

  const matches = useCallback(
    (c: Partial<Connection>) => (view === "shared" ? c.board === "shared" && c.board_id === boardId : c.board === "private"),
    [view, boardId]
  );

  const load = useCallback(async () => {
    if (!enabled) {
      setItems([]);
      return;
    }
    let q = supabase.from("connections").select("*");
    q = view === "shared" ? q.eq("board_id", boardId as string) : q.eq("board", "private");
    const { data, error } = await q;
    if (error) {
      console.error("Стикеры: не удалось загрузить нити", error);
      return;
    }
    if (alive.current) setItems((data ?? []) as Connection[]);
  }, [enabled, view, boardId]);

  useEffect(() => {
    alive.current = true;
    setItems([]);
    load();
    if (!enabled) return () => void (alive.current = false);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    const channel = supabase
      .channel(`threads-${view}-${boardId ?? "own"}-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "connections" }, (payload) => {
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string }).id;
          if (id) setItems((prev) => (prev.some((c) => c.id === id) ? prev.filter((c) => c.id !== id) : prev));
          return;
        }
        const row = payload.new as Connection;
        if (!row || !matches(row)) return;
        setItems((prev) => {
          const i = prev.findIndex((c) => c.id === row.id);
          if (i === -1) return [...prev, row];
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
  }, [enabled, view, boardId, userId, load, matches]);

  const find = useCallback((a: string, b: string) => items.find((c) => pairKey(c.a_id, c.b_id) === pairKey(a, b)) ?? null, [items]);

  /** One thread per pair: returns the existing one instead of creating a duplicate. */
  const create = useCallback(
    async (x: string, y: string): Promise<{ conn: Connection | null; existed: boolean; error: string | null }> => {
      const old = find(x, y);
      if (old) return { conn: old, existed: true, error: null };
      const [a, b] = x < y ? [x, y] : [y, x];
      const { data, error } = await supabase.from("connections").insert({ a_id: a, b_id: b }).select().single();
      if (error || !data) {
        console.error(error);
        if (error && String((error as { message?: string }).message).includes("duplicate key")) {
          await load();
          return { conn: null, existed: true, error: null };
        }
        return { conn: null, existed: false, error: threadErrorText(error) };
      }
      const row = data as Connection;
      setItems((prev) => (prev.some((c) => c.id === row.id) ? prev : [...prev, row]));
      return { conn: row, existed: false, error: null };
    },
    [find, load]
  );

  const update = useCallback(async (id: string, patch: Partial<Pick<Connection, "color" | "dashed" | "label">>) => {
    setItems((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    const { error } = await supabase.from("connections").update(patch).eq("id", id);
    if (error) {
      console.error(error);
      return threadErrorText(error);
    }
    return null;
  }, []);

  const remove = useCallback(async (id: string) => {
    const { error } = await supabase.from("connections").delete().eq("id", id);
    if (error) {
      console.error(error);
      return threadErrorText(error);
    }
    setItems((prev) => prev.filter((c) => c.id !== id));
    return null;
  }, []);

  return { items, create, update, remove, find, reload: load };
}

export type ThreadsApi = ReturnType<typeof useConnections>;
