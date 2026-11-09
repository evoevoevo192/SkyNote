import { useCallback, useEffect, useRef, useState } from "react";
import {
  DRAW_COLORS,
  DRAW_COLOR_NAMES,
  DRAW_WIDTHS,
  MARKER_ALPHA,
  MARKER_FACTOR,
  MAX_POINTS_PUBLIC,
  countPoints,
  type DrawingsApi,
  type Stroke,
} from "../lib/drawings";

type Tool = "pen" | "marker" | "eraser";

export function PencilIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
const Ico = ({ d, size = 22 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** Strokes are stored divided by the canvas width, so px = value * width. */
function paint(ctx: CanvasRenderingContext2D, s: Stroke, W: number) {
  const width = s.t === "marker" ? s.w * MARKER_FACTOR : s.w;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  ctx.globalAlpha = s.t === "marker" ? MARKER_ALPHA : 1;
  const n = s.p.length / 2;
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(s.p[0] * W, s.p[1] * W, width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // smoothing: quadratic curves through the midpoints of neighbouring points
    ctx.beginPath();
    ctx.moveTo(s.p[0] * W, s.p[1] * W);
    for (let i = 1; i < n - 1; i++) {
      const x = s.p[i * 2] * W;
      const y = s.p[i * 2 + 1] * W;
      const nx = s.p[i * 2 + 2] * W;
      const ny = s.p[i * 2 + 3] * W;
      ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    ctx.lineTo(s.p[(n - 1) * 2] * W, s.p[(n - 1) * 2 + 1] * W);
    ctx.stroke();
  }
  ctx.restore();
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hits(s: Stroke, x: number, y: number, W: number, radius: number): boolean {
  const reach = radius + (s.t === "marker" ? s.w * MARKER_FACTOR : s.w) / 2;
  const n = s.p.length / 2;
  if (n === 1) return Math.hypot(x - s.p[0] * W, y - s.p[1] * W) <= reach;
  for (let i = 0; i < n - 1; i++) {
    if (distToSegment(x, y, s.p[i * 2] * W, s.p[i * 2 + 1] * W, s.p[i * 2 + 2] * W, s.p[i * 2 + 3] * W) <= reach) return true;
  }
  return false;
}

let strokeSeq = 0;
const newId = () => `s${Date.now().toString(36)}${(strokeSeq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

interface Props {
  api: DrawingsApi;
  editing: boolean;
  onDone: () => void;
  notify: (text: string, kind?: "success" | "error") => void;
}

export function DrawingLayer({ api, editing, onDone, notify }: Props) {
  const [tool, setTool] = useState<Tool>("pen");
  const [colorIdx, setColorIdx] = useState(0);
  const [widthIdx, setWidthIdx] = useState(1);
  const [confirmClear, setConfirmClear] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const live = useRef<{ id: number; pts: number[]; erased: Set<string> } | null>(null);
  const penSeen = useRef(false);
  const raf = useRef(0);
  const strokesRef = useRef(api.strokes);
  strokesRef.current = api.strokes;
  const toolRef = useRef({ tool, colorIdx, widthIdx });
  toolRef.current = { tool, colorIdx, widthIdx };

  // ---- drawing ----
  const redrawBase = useCallback(() => {
    const base = baseRef.current;
    const { w, h, dpr } = sizeRef.current;
    if (!base || !w) return;
    const ctx = base.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const hidden = live.current?.erased;
    for (const s of strokesRef.current) {
      if (hidden?.has(s.id)) continue;
      paint(ctx, s, w);
    }
  }, []);

  const frame = useCallback(() => {
    raf.current = 0;
    const canvas = canvasRef.current;
    const base = baseRef.current;
    const { w, h, dpr } = sizeRef.current;
    if (!canvas || !base || !w) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    const l = live.current;
    if (l && l.pts.length >= 2 && toolRef.current.tool !== "eraser") {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const t = toolRef.current;
      paint(ctx, { id: "live", t: t.tool as "pen" | "marker", c: DRAW_COLORS[t.colorIdx], w: DRAW_WIDTHS[t.widthIdx], p: l.pts.map((v) => v / w) }, w);
    }
  }, []);
  const requestFrame = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(frame);
  }, [frame]);

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = window.innerWidth;
    const h = window.innerHeight;
    sizeRef.current = { w, h, dpr };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (!baseRef.current) baseRef.current = document.createElement("canvas");
    baseRef.current.width = canvas.width;
    baseRef.current.height = canvas.height;
    redrawBase();
    requestFrame();
  }, [redrawBase, requestFrame]);

  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [resize]);
  useEffect(() => {
    redrawBase();
    requestFrame();
  }, [api.strokes, redrawBase, requestFrame]);

  // ---- pointer input (mouse, finger, stylus) ----
  const pos = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect();
    return [e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0)] as const;
  };
  const eraseAt = (x: number, y: number) => {
    const l = live.current;
    if (!l) return;
    const W = sizeRef.current.w;
    let changed = false;
    for (const s of strokesRef.current) {
      if (!l.erased.has(s.id) && hits(s, x, y, W, 10)) {
        l.erased.add(s.id);
        changed = true;
      }
    }
    if (changed) {
      redrawBase();
      requestFrame();
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editing) return;
    if (e.pointerType === "pen") penSeen.current = true;
    // palm rejection: once a stylus was used, ignore finger touches
    if (e.pointerType === "touch" && penSeen.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (live.current) return; // another pointer is already drawing
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = pos(e);
    live.current = { id: e.pointerId, pts: [x, y], erased: new Set() };
    if (toolRef.current.tool === "eraser") eraseAt(x, y);
    else requestFrame();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = live.current;
    if (!l || l.id !== e.pointerId) return;
    e.preventDefault();
    const native = e.nativeEvent as PointerEvent;
    const events = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    const list = events.length ? events : [native];
    for (const ev of list) {
      const [x, y] = pos(ev);
      if (toolRef.current.tool === "eraser") {
        eraseAt(x, y);
        continue;
      }
      const n = l.pts.length;
      if (Math.hypot(x - l.pts[n - 2], y - l.pts[n - 1]) >= 1.5) l.pts.push(x, y);
    }
    requestFrame();
  };

  const finish = (e: React.PointerEvent<HTMLCanvasElement>, cancel: boolean) => {
    const l = live.current;
    if (!l || l.id !== e.pointerId) return;
    live.current = null;
    const W = sizeRef.current.w;
    const t = toolRef.current;
    if (!cancel) {
      if (t.tool === "eraser") {
        if (l.erased.size) api.commit(strokesRef.current.filter((s) => !l.erased.has(s.id)));
      } else if (l.pts.length >= 2) {
        const p = l.pts.map((v) => Math.round((v / W) * 10000) / 10000);
        const stroke: Stroke = { id: newId(), t: t.tool, c: DRAW_COLORS[t.colorIdx], w: DRAW_WIDTHS[t.widthIdx], p };
        if (countPoints(strokesRef.current) + p.length / 2 > MAX_POINTS_PUBLIC) {
          notify("Рисунок слишком большой. Сотрите часть линий или очистите всё", "error");
        } else {
          api.commit([...strokesRef.current, stroke]);
        }
      }
    }
    redrawBase();
    requestFrame();
  };

  // ---- keyboard ----
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (confirmClear) setConfirmClear(false);
        else onDone();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) {
          e.preventDefault();
          api.undo();
        } else if ((k === "z" && e.shiftKey) || k === "y") {
          e.preventDefault();
          api.redo();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, confirmClear, onDone, api]);

  useEffect(() => {
    if (!editing) {
      setConfirmClear(false);
      void api.flush();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => {
    if (!confirmClear) return;
    const t = window.setTimeout(() => setConfirmClear(false), 5000);
    return () => window.clearTimeout(t);
  }, [confirmClear]);

  const status =
    api.saveState === "saving" ? "Сохранение…" : api.saveState === "saved" ? "Сохранено" : api.saveState === "error" ? "Не сохранено" : "";

  return (
    <>
      <canvas
        ref={canvasRef}
        className={`draw-canvas ${editing ? "editing" : ""} tool-${tool}`}
        aria-label="Холст для рисования"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onContextMenu={(e) => editing && e.preventDefault()}
      />
      {editing && (
        <div className="draw-dock" role="toolbar" aria-label="Инструменты рисования">
          <div className="draw-group" role="radiogroup" aria-label="Инструмент">
            <button className={`draw-btn ${tool === "pen" ? "on" : ""}`} role="radio" aria-checked={tool === "pen"} onClick={() => setTool("pen")} title="Ручка" aria-label="Ручка">
              <Ico d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
            </button>
            <button className={`draw-btn ${tool === "marker" ? "on" : ""}`} role="radio" aria-checked={tool === "marker"} onClick={() => setTool("marker")} title="Маркер" aria-label="Маркер">
              <Ico d="M9 11l6 6M4 20l4-1 11-11a2.1 2.1 0 00-3-3L5 16zM14 6l4 4" />
            </button>
            <button className={`draw-btn ${tool === "eraser" ? "on" : ""}`} role="radio" aria-checked={tool === "eraser"} onClick={() => setTool("eraser")} title="Ластик" aria-label="Ластик">
              <Ico d="M20 20H9L3.5 14.5a2 2 0 010-2.8L12 3.2a2 2 0 012.8 0L20 8.4a2 2 0 010 2.8L11 20M7 11l6 6" />
            </button>
          </div>

          <div className="draw-group" role="radiogroup" aria-label="Толщина">
            {DRAW_WIDTHS.map((w, i) => (
              <button key={w} className={`draw-btn ${widthIdx === i ? "on" : ""}`} role="radio" aria-checked={widthIdx === i} onClick={() => setWidthIdx(i)} title={`Толщина ${i + 1}`} aria-label={`Толщина ${i + 1}`}>
                <span className="draw-w" style={{ width: 8 + i * 5, height: 8 + i * 5 }} />
              </button>
            ))}
          </div>

          <div className={`draw-group draw-colors ${tool === "eraser" ? "dim" : ""}`} role="radiogroup" aria-label="Цвет">
            {DRAW_COLORS.map((c, i) => (
              <button key={c} className={`draw-color ${colorIdx === i ? "on" : ""}`} role="radio" aria-checked={colorIdx === i} disabled={tool === "eraser"} onClick={() => setColorIdx(i)} title={DRAW_COLOR_NAMES[i]} aria-label={DRAW_COLOR_NAMES[i]}>
                <span style={{ background: c }} />
              </button>
            ))}
          </div>

          {confirmClear ? (
            <div className="draw-group draw-confirm" role="alertdialog">
              <span>Очистить всё?</span>
              <button className="draw-text" onClick={() => setConfirmClear(false)}>Отмена</button>
              <button
                className="draw-text danger"
                onClick={() => {
                  setConfirmClear(false);
                  api.commit([]);
                }}
              >
                Очистить
              </button>
            </div>
          ) : (
            <div className="draw-group">
              <button className="draw-btn" onClick={api.undo} disabled={!api.canUndo} title="Отменить" aria-label="Отменить">
                <Ico d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" />
              </button>
              <button className="draw-btn" onClick={api.redo} disabled={!api.canRedo} title="Повторить" aria-label="Повторить">
                <Ico d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" />
              </button>
              <button className="draw-btn danger" onClick={() => setConfirmClear(true)} disabled={api.strokes.length === 0} title="Очистить всё" aria-label="Очистить всё">
                <Ico d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
              </button>
            </div>
          )}

          <span className={`draw-status ${api.saveState}`} aria-live="polite">{status}</span>
          <button className="draw-done" onClick={onDone} title="Готово" aria-label="Готово">
            <Ico d="M5 12.5l4.5 4.5L19 7.5" size={26} />
          </button>
        </div>
      )}
    </>
  );
}
