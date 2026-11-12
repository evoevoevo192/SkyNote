import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MoveToPage } from "./Pages";
import type { PageInfo } from "../lib/pages";
import {
  PHOTO_CAPTION_MAX,
  PHOTO_DEFAULT_W,
  PHOTO_MAX_W,
  PHOTO_MIN_W,
  type Note,
} from "../lib/supabase";

export const PHOTO_SIZE_PRESETS = [
  { label: "Мал", width: 140 },
  { label: "Сред", width: 220 },
  { label: "Большое", width: 360 },
] as const;

/** Random-looking but stable tilt in [-2, 2] degrees derived from the id. */
export function photoTilt(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ((h % 4001) / 1000 - 2);
}

export function ImageIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" fill="currentColor" stroke="none" />
      <path d="M3.5 17l5-4.5 4 3.5 3-2.5 5 4" />
    </svg>
  );
}

// ---------- card content ----------
interface PhotoFrameProps {
  url: string;
  aspect: number;
  caption: string | null | undefined;
}

export function PhotoFrame({ url, aspect, caption }: PhotoFrameProps) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  useEffect(() => setState("loading"), [url]);
  return (
    <>
      <div className="pc-frame" style={{ aspectRatio: String(aspect > 0 ? aspect : 1) }}>
        {state === "loading" && <div className="pc-skeleton" />}
        {state === "error" ? (
          <div className="pc-fallback">
            <ImageIcon size={28} />
            <span>Фото недоступно</span>
          </div>
        ) : (
          <img
            src={url}
            alt={caption || "Фото"}
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setState("ok")}
            onError={() => setState("error")}
            style={{ opacity: state === "ok" ? 1 : 0 }}
          />
        )}
      </div>
      {caption ? <div className="pc-caption">{caption}</div> : null}
    </>
  );
}

// ---------- corner handle: stretch with the aspect ratio kept ----------
export function PhotoResizeHandle({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div
      className="pc-handle"
      aria-label="Растянуть фото"
      title="Потяните, чтобы изменить размер"
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
      }}
      onPointerMove={(e) => {
        if (start.current) onWidth(start.current.w + (e.clientX - start.current.x));
      }}
      onPointerUp={(e) => {
        start.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onClick={stop}
      onDoubleClick={stop}
    />
  );
}

// ---------- control panel ----------
interface PhotoPanelProps {
  note: Note;
  confirming: boolean;
  onConfirming: (v: boolean) => void;
  onWidth: (w: number) => void;
  onCaption: (c: string | null) => void;
  onReplace: () => void;
  onOpen: () => void;
  onDelete: () => void;
  /** false for someone else's photo on a shared board: only open / delete (owner) */
  canEdit?: boolean;
  canDelete?: boolean;
  pages?: PageInfo[];
  onMovePage?: (page: number) => void;
}

export function PhotoPanel({ note, confirming, onConfirming, onWidth, onCaption, onReplace, onOpen, onDelete, canEdit = true, canDelete = true, pages = [], onMovePage }: PhotoPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [captionOpen, setCaptionOpen] = useState(false);
  const [draft, setDraft] = useState(note.caption ?? "");
  const width = note.width ?? PHOTO_DEFAULT_W;

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia("(min-width: 640px)").matches) {
      el.style.left = "";
      el.style.top = "";
      return;
    }
    const card = document.querySelector<HTMLElement>(`[data-photo-id="${note.id}"]`);
    if (!card) return;
    const r = card.getBoundingClientRect();
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    let top = r.bottom + 16;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 16);
    const left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [note.id]);

  // re-place after every render (card moves/resizes while dragging)
  useLayoutEffect(() => {
    place();
  });

  useEffect(() => {
    const board = document.querySelector(".board");
    window.addEventListener("resize", place);
    board?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      board?.removeEventListener("scroll", place);
    };
  }, [place]);

  const commitCaption = () => {
    const next = draft.trim().slice(0, PHOTO_CAPTION_MAX);
    if (next !== (note.caption ?? "")) onCaption(next || null);
  };

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <div
      ref={ref}
      className="photo-panel"
      role="dialog"
      aria-label="Параметры фото"
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
    >
      {canEdit && (
      <>
      <div className="pp-row pp-size">
        <label className="pp-label" htmlFor="pp-range">Размер</label>
        <input
          id="pp-range"
          className="pp-range"
          type="range"
          min={PHOTO_MIN_W}
          max={PHOTO_MAX_W}
          step={5}
          value={width}
          onChange={(e) => onWidth(Number(e.target.value))}
          aria-label="Размер фото"
        />
        <span className="pp-value">{width}px</span>
      </div>
      <div className="pp-row pp-size pp-presets">
        {PHOTO_SIZE_PRESETS.map((p) => (
          <button key={p.label} className={`pp-btn ${width === p.width ? "active" : ""}`} onClick={() => onWidth(p.width)}>
            {p.label}
          </button>
        ))}
      </div>
      </>
      )}

      {canEdit && captionOpen && (
        <div className="pp-row">
          <input
            className="pp-caption"
            value={draft}
            maxLength={PHOTO_CAPTION_MAX}
            placeholder="Подпись к фото"
            aria-label="Подпись к фото"
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitCaption}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitCaption();
                setCaptionOpen(false);
              }
              e.stopPropagation();
            }}
          />
          <span className="pp-value">{draft.length}/{PHOTO_CAPTION_MAX}</span>
        </div>
      )}

      {confirming && canDelete ? (
        <div className="pp-row pp-confirm" role="alertdialog" aria-label="Подтверждение удаления">
          <span>Удалить фото?</span>
          <button className="pp-btn" onClick={() => onConfirming(false)}>Отмена</button>
          <button className="pp-btn danger" onClick={onDelete}>Удалить</button>
        </div>
      ) : (
        <>
        {canEdit && onMovePage && pages.length > 1 && (
          <div className="pp-row">
            <MoveToPage pages={pages} current={note.page ?? 1} onMove={onMovePage} className="in-panel" />
          </div>
        )}
        <div className="pp-row pp-actions">
          {canEdit && <button className={`pp-btn ${captionOpen ? "active" : ""}`} onClick={() => setCaptionOpen((v) => !v)}>Подпись</button>}
          {canEdit && <button className="pp-btn" onClick={onReplace}>Заменить</button>}
          <button className="pp-btn" onClick={onOpen}>Открыть</button>
          {canDelete && <button className="pp-btn danger" onClick={() => onConfirming(true)} aria-label="Удалить фото">Удалить</button>}
        </div>
        </>
      )}
    </div>
  );
}

// ---------- full-screen viewer ----------
export interface ViewerPhoto {
  id: string;
  url: string;
  caption: string | null;
}

interface PhotoViewerProps {
  photos: ViewerPhoto[];
  startId: string;
  onClose: () => void;
}

const MAX_SCALE = 6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface View {
  s: number;
  x: number;
  y: number;
}

export function PhotoViewer({ photos, startId, onClose }: PhotoViewerProps) {
  const [index, setIndex] = useState(() => Math.max(0, photos.findIndex((p) => p.id === startId)));
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [dragY, setDragY] = useState(0);
  const [active, setActive] = useState(false);

  const viewRef = useRef(view);
  viewRef.current = view;
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({
    mode: "none" as "none" | "pan" | "pinch" | "swipe",
    startX: 0,
    startY: 0,
    ox: 0,
    oy: 0,
    startDist: 1,
    startScale: 1,
    moved: false,
  });
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const dragYRef = useRef(0);

  const photo = photos[index];
  const last = photos.length - 1;

  const clampPan = useCallback((s: number, x: number, y: number): View => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage || s <= 1) return { s, x: 0, y: 0 };
    const maxX = Math.max(0, (img.offsetWidth * s - stage.clientWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * s - stage.clientHeight) / 2);
    return { s, x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  }, []);

  const zoomAt = useCallback(
    (nextScale: number, cx: number, cy: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const px = cx - (rect.left + rect.width / 2);
      const py = cy - (rect.top + rect.height / 2);
      const cur = viewRef.current;
      const s = clamp(nextScale, 1, MAX_SCALE);
      const ratio = s / cur.s;
      setView(clampPan(s, px - (px - cur.x) * ratio, py - (py - cur.y) * ratio));
    },
    [clampPan]
  );

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => clamp(i + delta, 0, last));
    },
    [last]
  );

  useEffect(() => {
    setView({ s: 1, x: 0, y: 0 });
    setDragY(0);
    dragYRef.current = 0;
  }, [index]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  // wheel zoom (needs a non-passive listener to prevent page scroll)
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(viewRef.current.s * Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const dist = () => {
    const [a, b] = Array.from(pointers.current.values());
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    setActive(true);
    if (pointers.current.size === 2) {
      g.mode = "pinch";
      g.startDist = dist();
      g.startScale = viewRef.current.s;
      g.moved = true;
      dragYRef.current = 0;
      setDragY(0);
    } else {
      g.mode = viewRef.current.s > 1 ? "pan" : "swipe";
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.ox = viewRef.current.x;
      g.oy = viewRef.current.y;
      g.moved = false;
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g.mode === "pinch" && pointers.current.size >= 2) {
      const [a, b] = Array.from(pointers.current.values());
      zoomAt(g.startScale * (dist() / g.startDist), (a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (g.mode === "pan") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) g.moved = true;
      setView(clampPan(viewRef.current.s, g.ox + dx, g.oy + dy));
    } else if (g.mode === "swipe") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (Math.abs(dx) + Math.abs(dy) > 8) g.moved = true;
      if (dy > 0 && dy > Math.abs(dx)) {
        dragYRef.current = dy;
        setDragY(dy);
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;

    if (g.mode === "pinch") {
      // one finger stays down -> continue as pan from where it is
      const rest = Array.from(pointers.current.values())[0];
      if (rest) {
        g.mode = viewRef.current.s > 1 ? "pan" : "none";
        g.startX = rest.x;
        g.startY = rest.y;
        g.ox = viewRef.current.x;
        g.oy = viewRef.current.y;
      } else {
        g.mode = "none";
        setActive(false);
      }
      return;
    }

    setActive(false);
    if (g.mode === "swipe" && dragYRef.current > 110) {
      g.mode = "none";
      onClose();
      return;
    }
    dragYRef.current = 0;
    setDragY(0);

    if (!g.moved) {
      // the stage holds pointer capture, so e.target is always the stage: hit-test the photo by its box
      const box = imgRef.current?.getBoundingClientRect();
      const onImage =
        !!box && e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
      const now = Date.now();
      const lt = lastTap.current;
      if (onImage && now - lt.t < 320 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 30) {
        // double tap / double click: toggle zoom
        if (viewRef.current.s > 1) setView({ s: 1, x: 0, y: 0 });
        else zoomAt(2.5, e.clientX, e.clientY);
        lastTap.current = { t: 0, x: 0, y: 0 };
      } else if (!onImage) {
        // tap outside the photo; closed after the click so it cannot fall through to the page underneath
        window.setTimeout(onClose, 0);
      } else {
        lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      }
    }
    g.mode = "none";
  };

  if (!photo) return null;

  const fade = Math.min(dragY, 320) / 520;

  return (
    <div
      className="pv-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр фото"
      style={{ background: `rgba(8, 10, 14, ${0.88 - fade})` }}
    >
      <div
        className="pv-stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          ref={imgRef}
          className="pv-img"
          src={photo.url}
          alt={photo.caption || "Фото"}
          draggable={false}
          style={{
            transform: `translate(${view.x}px, ${view.y + dragY}px) scale(${view.s})`,
            transition: active ? "none" : "transform 180ms ease-out",
          }}
        />
      </div>

      {photo.caption && <div className="pv-caption">{photo.caption}</div>}

      <button className="pv-btn pv-close" onClick={onClose} aria-label="Закрыть просмотр">✕</button>
      {index > 0 && (
        <button className="pv-btn pv-nav pv-prev" onClick={() => go(-1)} aria-label="Предыдущее фото">‹</button>
      )}
      {index < last && (
        <button className="pv-btn pv-nav pv-next" onClick={() => go(1)} aria-label="Следующее фото">›</button>
      )}
      {photos.length > 1 && <div className="pv-count">{index + 1} / {photos.length}</div>}
    </div>
  );
}
