import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { THREAD_COLORS, THREAD_COLOR_NAMES, THREAD_LABEL_MAX, type Connection, type ThreadsApi } from "../lib/threads";

export function ThreadIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="6" r="2.2" fill="currentColor" />
      <circle cx="19" cy="7" r="2.2" fill="currentColor" />
      <path d="M5 8.2C6 20 18 20 19 9.2" />
    </svg>
  );
}

interface Pt { x: number; y: number }

/** Sagging cubic Bezier between two pins. Returns path and the point at t = 0.5. */
export function threadGeometry(a: Pt, b: Pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const sag = Math.min(140, 22 + dist * 0.2);
  const c1 = { x: a.x + dx * 0.22, y: a.y + dy * 0.22 + sag };
  const c2 = { x: b.x - dx * 0.22, y: b.y - dy * 0.22 + sag };
  const t = 0.5;
  const mt = 1 - t;
  const mid = {
    x: mt ** 3 * a.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * b.x,
    y: mt ** 3 * a.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * b.y,
  };
  return { d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} C${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`, mid };
}

interface Props {
  api: ThreadsApi;
  active: boolean;
  visibleIds: Set<string>;
  userId: string;
  isBoardOwner: boolean;
  openId: string | null;
  pinFirst: string | null;
  onPin: (id: string) => void;
  onOpen: (id: string | null) => void;
  notify: (text: string, kind?: "success" | "error") => void;
}

/** Draws the threads over the board; positions are read from the pins in the DOM every frame,
 *  so threads follow dragging, scrolling, window resizes and layout changes. */
export function ThreadLayer({ api, active, visibleIds, userId, isBoardOwner, openId, pinFirst, onPin, onOpen, notify }: Props) {
  const [pos, setPos] = useState<Record<string, Pt>>({});
  const sig = useRef("");
  const list = useMemo(() => api.items.filter((c) => visibleIds.has(c.a_id) && visibleIds.has(c.b_id)), [api.items, visibleIds]);

  // Positions are polled every frame only while there is something to draw or edit;
  // with no threads the board costs nothing (this matters on phones).
  const needLoop = active || list.length > 0;
  useEffect(() => {
    if (!needLoop) {
      sig.current = "";
      setPos((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    let raf = 0;
    const tick = () => {
      if (!document.hidden) {
        const next: Record<string, Pt> = {};
        let s = "";
        document.querySelectorAll<HTMLElement>("[data-pin-id]").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          const id = el.dataset.pinId as string;
          const x = Math.round((r.left + r.width / 2) * 2) / 2;
          const y = Math.round((r.top + r.height / 2) * 2) / 2;
          next[id] = { x, y };
          s += `${id}:${x},${y};`;
        });
        if (s !== sig.current) {
          sig.current = s;
          setPos(next);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [needLoop]);

  const open = openId ? list.find((c) => c.id === openId) ?? null : null;
  useEffect(() => {
    if (openId && !open) onOpen(null);
  }, [openId, open, onOpen]);

  return (
    <>
      <svg className={`thread-layer${active ? " active" : ""}`} aria-hidden={!active}>
        {list.map((c) => {
          const a = pos[c.a_id];
          const b = pos[c.b_id];
          if (!a || !b) return null;
          const g = threadGeometry(a, b);
          const sel = c.id === openId;
          return (
            <g key={c.id} className={`thread${sel ? " selected" : ""}`} data-thread-id={c.id}>
              <path d={g.d} className="thread-shadow" />
              <path
                d={g.d}
                className="thread-line"
                stroke={c.color}
                strokeDasharray={c.dashed ? "2 9" : undefined}
                strokeLinecap="round"
              />
              <path
                d={g.d}
                className="thread-hit"
                onClick={(e) => {
                  if (!active) return;
                  e.stopPropagation();
                  onOpen(c.id);
                }}
              />
              {c.label && (
                <g className="thread-label" transform={`translate(${g.mid.x.toFixed(1)} ${g.mid.y.toFixed(1)})`}>
                  <rect x={-(Math.min(c.label.length, 30) * 3.8 + 10)} y="-11" width={Math.min(c.label.length, 30) * 7.6 + 20} height="22" rx="6" />
                  <text textAnchor="middle" dominantBaseline="central">{c.label.length > 30 ? c.label.slice(0, 29) + "…" : c.label}</text>
                </g>
              )}
            </g>
          );
        })}
        {active &&
          Array.from(visibleIds).map((id) => {
            const q = pos[id];
            if (!q) return null;
            return (
              <g key={`pin-${id}`} className={`pin-hot${pinFirst === id ? " first" : ""}`} transform={`translate(${q.x} ${q.y})`} data-pin-hot={id} onClick={(e) => { e.stopPropagation(); onPin(id); }}>
                <circle r="18" className="pin-hot-area" />
                <circle r={pinFirst === id ? 9 : 7} className="pin-hot-head" />
              </g>
            );
          })}
      </svg>
      {active && open && pos[open.a_id] && pos[open.b_id] && (
        <ThreadPopover
          key={open.id}
          conn={open}
          anchor={threadGeometry(pos[open.a_id], pos[open.b_id]).mid}
          canEdit={open.user_id === userId}
          canDelete={open.user_id === userId || isBoardOwner}
          api={api}
          onClose={() => onOpen(null)}
          notify={notify}
        />
      )}
    </>
  );
}

function ThreadPopover({
  conn,
  anchor,
  canEdit,
  canDelete,
  api,
  onClose,
  notify,
}: {
  conn: Connection;
  anchor: Pt;
  canEdit: boolean;
  canDelete: boolean;
  api: ThreadsApi;
  onClose: () => void;
  notify: Props["notify"];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [label, setLabel] = useState(conn.label);
  const [box, setBox] = useState({ w: 280, h: 190 });
  useLayoutEffect(() => {
    if (ref.current) setBox({ w: ref.current.offsetWidth, h: ref.current.offsetHeight });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(8, Math.min(vw - box.w - 8, anchor.x - box.w / 2));
  let top = anchor.y + 22;
  if (top + box.h > vh - 8) top = Math.max(8, anchor.y - box.h - 22);

  const run = async (p: Promise<string | null>) => {
    const err = await p;
    if (err) notify(err, "error");
  };
  const saveLabel = () => {
    const v = label.trim().slice(0, THREAD_LABEL_MAX);
    if (v !== conn.label) run(api.update(conn.id, { label: v }));
  };

  return (
    <div className="thread-pop-wrap" onPointerDown={(e) => e.target === e.currentTarget && (saveLabel(), onClose())}>
      <div ref={ref} className="thread-pop" role="dialog" aria-label="Нить" style={{ left, top }}>
        <div className="thread-pop-colors" role="radiogroup" aria-label="Цвет нити">
          {THREAD_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={conn.color.toLowerCase() === c}
              aria-label={THREAD_COLOR_NAMES[i]}
              title={THREAD_COLOR_NAMES[i]}
              className={`thread-swatch${conn.color.toLowerCase() === c ? " on" : ""}`}
              style={{ background: c }}
              disabled={!canEdit}
              onClick={() => run(api.update(conn.id, { color: c }))}
            />
          ))}
        </div>
        <label className="thread-dash">
          <input type="checkbox" checked={conn.dashed} disabled={!canEdit} onChange={(e) => run(api.update(conn.id, { dashed: e.target.checked }))} />
          <span>Пунктир</span>
        </label>
        <input
          className="thread-label-input"
          value={label}
          maxLength={THREAD_LABEL_MAX}
          placeholder="Подпись"
          disabled={!canEdit}
          aria-label="Подпись нити"
          onChange={(e) => setLabel(e.target.value)}
          onBlur={saveLabel}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              saveLabel();
              onClose();
            }
          }}
        />
        <div className="thread-pop-actions">
          {canDelete && (
            <button
              type="button"
              className="thread-del"
              onClick={async () => {
                const err = await api.remove(conn.id);
                if (err) notify(err, "error");
                else onClose();
              }}
            >
              Удалить нить
            </button>
          )}
          <button type="button" className="thread-ok" onClick={() => (saveLabel(), onClose())}>Готово</button>
        </div>
        {!canEdit && <div className="thread-note">Нить протянул другой участник</div>}
      </div>
    </div>
  );
}
