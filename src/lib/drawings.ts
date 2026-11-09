import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

export type StrokeTool = "pen" | "marker";

/** One vector stroke. p = [x1, y1, x2, y2, ...], both axes divided by the canvas width. */
export interface Stroke {
  id: string;
  t: StrokeTool;
  c: string;
  w: number;
  p: number[];
}

export const DRAW_COLORS = ["#1f2430", "#e5484d", "#f76808", "#f5c518", "#30a46c", "#0090ff", "#8e4ec6", "#ffffff"];
export const DRAW_COLOR_NAMES = ["Чёрный", "Красный", "Оранжевый", "Жёлтый", "Зелёный", "Синий", "Фиолетовый", "Белый"];
export const DRAW_WIDTHS = [2, 5, 10];
export const MARKER_FACTOR = 3;
export const MARKER_ALPHA = 0.4;
export const SAVE_DELAY_MS = 800;
const HISTORY_LIMIT = 60;
export const MAX_POINTS_PUBLIC = 90000; // ~1.3 MB of JSON, safely under the 2 MB DB limit

export function countPoints(strokes: Stroke[]): number {
  let n = 0;
  for (const s of strokes) n += s.p.length / 2;
  return n;
}

function sanitize(raw: unknown): Stroke[] {
  if (!Array.isArray(raw)) return [];
  const out: Stroke[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const r = s as Partial<Stroke>;
    if (typeof r.id !== "string" || (r.t !== "pen" && r.t !== "marker") || typeof r.c !== "string" || typeof r.w !== "number") continue;
    if (!Array.isArray(r.p) || r.p.length < 2 || r.p.length % 2 !== 0 || !r.p.every((v) => typeof v === "number" && isFinite(v))) continue;
    out.push({ id: r.id, t: r.t, c: r.c, w: r.w, p: r.p });
  }
  return out;
}

export type SaveState = "idle" | "saving" | "saved" | "error";

/** Strokes of the private board: undo/redo history, debounced autosave (800 ms), reload on focus. */
export function useDrawings(userId: string) {
  const [strokes, setStrokesState] = useState<Stroke[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [, setTick] = useState(0);
  const cur = useRef<Stroke[]>([]);
  const hist = useRef<{ stack: Stroke[][]; idx: number }>({ stack: [[]], idx: 0 });
  const timer = useRef<number | null>(null);
  const dirty = useRef(false);
  const saving = useRef(false);

  const save = useCallback(async () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    if (saving.current) {
      timer.current = window.setTimeout(save, 300);
      return;
    }
    dirty.current = false;
    saving.current = true;
    setSaveState("saving");
    const { error } = await supabase
      .from("drawings")
      .upsert({ user_id: userId, board: "private", strokes: cur.current, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    saving.current = false;
    if (error) {
      console.error("Стикеры: не удалось сохранить рисунок", error);
      dirty.current = true;
      setSaveState("error");
    } else {
      setSaveState(dirty.current ? "saving" : "saved");
    }
  }, [userId]);

  const schedule = useCallback(() => {
    dirty.current = true;
    setSaveState("saving");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, SAVE_DELAY_MS);
  }, [save]);

  const apply = (next: Stroke[]) => {
    cur.current = next;
    setStrokesState(next);
    setTick((t) => t + 1);
    schedule();
  };

  /** Records a new state as one undo step. */
  const commit = useCallback(
    (next: Stroke[]) => {
      const h = hist.current;
      h.stack = h.stack.slice(0, h.idx + 1).concat([next]).slice(-HISTORY_LIMIT);
      h.idx = h.stack.length - 1;
      apply(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schedule]
  );
  const undo = useCallback(() => {
    const h = hist.current;
    if (h.idx > 0) {
      h.idx -= 1;
      apply(h.stack[h.idx]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule]);
  const redo = useCallback(() => {
    const h = hist.current;
    if (h.idx < h.stack.length - 1) {
      h.idx += 1;
      apply(h.stack[h.idx]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule]);

  const load = useCallback(async () => {
    if (dirty.current || saving.current) return;
    const { data, error } = await supabase.from("drawings").select("strokes").eq("user_id", userId).maybeSingle();
    if (error) {
      console.error("Стикеры: не удалось загрузить рисунок", error);
      setLoaded(true);
      return;
    }
    if (dirty.current || saving.current) return;
    const remote = sanitize((data as { strokes?: unknown } | null)?.strokes);
    if (JSON.stringify(remote) !== JSON.stringify(cur.current)) {
      cur.current = remote;
      setStrokesState(remote);
      hist.current = { stack: [remote], idx: 0 };
    }
    setLoaded(true);
  }, [userId]);

  useEffect(() => {
    load();
    const onFocus = () => load();
    const onHide = () => {
      if (dirty.current) void save();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      if (dirty.current) void save();
    };
  }, [load, save]);

  const h = hist.current;
  return {
    strokes,
    loaded,
    saveState,
    commit,
    undo,
    redo,
    flush: save,
    canUndo: h.idx > 0,
    canRedo: h.idx < h.stack.length - 1,
  };
}

export type DrawingsApi = ReturnType<typeof useDrawings>;
