import { useCallback, useEffect, useRef, useState } from "react";
import { local, useTable, usePendingOps } from "./localdb";
import { useOnline } from "./sync";
import { drawingSave, drawKey } from "./data";

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

/**
 * Strokes of the private board page: undo/redo history; the drawing lives in the local database,
 * every change is saved there at once and sent to the server by the sync queue.
 */
export function useDrawings(userId: string, page = 1) {
  useTable(local.drawings); // re-render when the drawing changes (also when it arrives from another device)
  const ops = usePendingOps();
  const online = useOnline();
  const key = drawKey(userId, page);
  const row = local.drawings.get(key);
  const cur = useRef<Stroke[]>([]);
  const hist = useRef<{ stack: Stroke[][]; idx: number }>({ stack: [[]], idx: 0 });
  const mineAt = useRef<string | null>(null);
  const shownKey = useRef<string | null>(null);
  const touched = useRef(false);
  const [, setTick] = useState(0);

  if (shownKey.current !== key) {
    shownKey.current = key;
    cur.current = sanitize(row?.strokes);
    hist.current = { stack: [cur.current], idx: 0 };
    mineAt.current = row?.updated_at ?? null;
    touched.current = false;
  } else if (row && row.updated_at !== mineAt.current) {
    // came from the server / another tab
    cur.current = sanitize(row.strokes);
    hist.current = { stack: [cur.current], idx: 0 };
    mineAt.current = row.updated_at;
  }

  const apply = useCallback(
    (next: Stroke[]) => {
      cur.current = next;
      touched.current = true;
      mineAt.current = drawingSave(userId, page, next);
      setTick((t) => t + 1);
    },
    [userId, page]
  );

  /** Records a new state as one undo step. */
  const commit = useCallback(
    (next: Stroke[]) => {
      const h = hist.current;
      h.stack = h.stack.slice(0, h.idx + 1).concat([next]).slice(-HISTORY_LIMIT);
      h.idx = h.stack.length - 1;
      apply(next);
    },
    [apply]
  );
  const undo = useCallback(() => {
    const h = hist.current;
    if (h.idx > 0) {
      h.idx -= 1;
      apply(h.stack[h.idx]);
    }
  }, [apply]);
  const redo = useCallback(() => {
    const h = hist.current;
    if (h.idx < h.stack.length - 1) {
      h.idx += 1;
      apply(h.stack[h.idx]);
    }
  }, [apply]);

  const flush = useCallback(async () => {
    await local.flush();
  }, []);

  useEffect(() => {
    const onHide = () => void local.flush();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  const waiting = ops.some((o) => o.table === "drawings" && o.id === key);
  const saveState = (!touched.current ? "idle" : waiting && online ? "saving" : "saved") as SaveState;

  const h = hist.current;
  return {
    strokes: cur.current,
    loaded: true,
    saveState,
    commit,
    undo,
    redo,
    flush,
    canUndo: h.idx > 0,
    canRedo: h.idx < h.stack.length - 1,
  };
}

export type DrawingsApi = ReturnType<typeof useDrawings>;
