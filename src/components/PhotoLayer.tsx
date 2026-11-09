import { useCallback, useEffect, useRef, useState } from "react";
import type { NotePhoto } from "../lib/supabase";

const ACCENT = "#5B5BF0";
const MIN_W = 20;
const MAX_W = 100;

export interface PhotoLayerProps {
  photo: NotePhoto;
  selected: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onDeselect: () => void;
  onChange: (patch: Partial<NotePhoto>) => void;
  onDelete: () => void;
  onReplace: () => void;
  onFullscreen: () => void;
}

type Drag = {
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  mode: "move" | "resize";
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function PhotoLayer({
  photo,
  selected,
  canEdit,
  onSelect,
  onDeselect,
  onChange,
  onDelete,
  onReplace,
  onFullscreen,
}: PhotoLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const rectFor = useCallback(() => {
    const r = layerRef.current?.parentElement?.getBoundingClientRect();
    return r ?? { width: 1, height: 1, left: 0, top: 0 };
  }, []);

  const startMove = useCallback(
    (e: React.PointerEvent) => {
      if (!canEdit) return;
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      setDrag({
        startX: e.clientX,
        startY: e.clientY,
        origX: photo.x,
        origY: photo.y,
        origW: photo.width,
        mode: "move",
      });
    },
    [canEdit, photo.x, photo.y, photo.width]
  );

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      if (!canEdit) return;
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      setDrag({
        startX: e.clientX,
        startY: e.clientY,
        origX: photo.x,
        origY: photo.y,
        origW: photo.width,
        mode: "resize",
      });
    },
    [canEdit, photo.x, photo.y, photo.width]
  );

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const r = rectFor();
      if (drag.mode === "move") {
        const dx = ((e.clientX - drag.startX) / r.width) * 100;
        const dy = ((e.clientY - drag.startY) / r.height) * 100;
        // keep photo top-left within sticker bounds
        const nx = clamp(drag.origX + dx, 0, 100 - drag.origW);
        const ny = clamp(drag.origY + dy, 0, 100);
        onChange({ x: Math.round(nx), y: Math.round(ny) });
      } else if (drag.mode === "resize") {
        // width is percentage of sticker width
        const dx = ((e.clientX - drag.startX) / r.width) * 100;
        const nw = clamp(drag.origW + dx, MIN_W, Math.min(MAX_W, 100 - drag.origX));
        onChange({ width: Math.round(nw) });
      }
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, onChange, rectFor]);

  // keyboard
  useEffect(() => {
    if (!selected || !canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDeselect();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onDelete();
        return;
      }
      const step = e.shiftKey ? 5 : 1;
      let dx = 0, dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else return;
      e.preventDefault();
      onChange({
        x: clamp(photo.x + dx, 0, 100 - photo.width),
        y: clamp(photo.y + dy, 0, 100),
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, canEdit, photo.x, photo.y, photo.width, onDeselect, onDelete, onChange]);

  return (
    <>
      <div
        className="photo-layer"
        ref={layerRef}
        onPointerDown={(e) => {
          if (e.target === layerRef.current) onDeselect();
        }}
      >
        <div
          className={`photo-object ${selected ? "selected" : ""}`}
          style={{
            left: `${photo.x}%`,
            top: `${photo.y}%`,
            width: `${photo.width}%`,
          }}
          onPointerDown={(e) => {
            if (!selected) onSelect();
            startMove(e);
          }}
        >
          <img src={photo.url} alt="" draggable={false} className="photo-img" style={{ touchAction: "none" }} />
          {selected && canEdit && (
            <>
              <button
                className="photo-handle handle-br"
                onPointerDown={startResize}
                aria-label="Изменить размер"
              />
              <div className="photo-toolbar" onPointerDown={(e) => e.stopPropagation()}>
                <button onClick={onReplace} title="Заменить">Заменить</button>
                <button onClick={onDelete} className="danger" title="Удалить">Удалить</button>
                <button onClick={onFullscreen} title="На весь экран">На весь экран</button>
              </div>
            </>
          )}
        </div>
      </div>
      <style>{`
        .photo-layer { position: absolute; inset: 0; z-index: 2; }
        .photo-object { position: absolute; cursor: move; user-select: none; box-sizing: border-box; }
        .photo-object.selected { outline: 2px solid ${ACCENT}; outline-offset: 1px; }
        .photo-img { display: block; width: 100%; height: auto; border-radius: 4px; pointer-events: none; }
        .photo-handle { position: absolute; bottom: -4px; right: -4px; width: 14px; height: 14px; border: 2px solid ${ACCENT}; background: #fff; border-radius: 50%; padding: 0; cursor: nwse-resize; box-shadow: 0 1px 4px rgba(0,0,0,0.2); }
        .photo-handle::before { content: ""; position: absolute; inset: -9px; }
        .photo-toolbar { position: absolute; top: -38px; left: 50%; transform: translateX(-50%); display: flex; gap: 2px; padding: 3px 4px; border-radius: 999px; background: rgba(28,30,40,0.86); color: #fff; font-size: 11px; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,0.22); }
        .photo-toolbar button { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; min-width: 28px; padding: 3px 7px; border-radius: 999px; color: #fff; background: transparent; font-size: 11px; font-weight: 600; }
        .photo-toolbar button:hover { background: rgba(255,255,255,0.16); }
        .photo-toolbar button.danger:hover { background: rgba(220,40,40,0.3); }
      `}</style>
    </>
  );
}
