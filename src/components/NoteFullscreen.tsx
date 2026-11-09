import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  FONT_STACK,
  NOTE_COLORS,
  NOTE_COLOR_HEX,
  NOTE_FONTS,
  NOTE_FONT_LABEL,
  type Note,
  type NoteColor,
  type NoteFont,
} from "../lib/supabase";

type Snap = { title: string; body: string; color: NoteColor; font: NoteFont };

export interface NoteFullscreenProps {
  note: Note;
  canEdit: boolean;
  canDelete: boolean;
  onClose: () => void;
  onChange: (patch: Partial<Pick<Note, "title" | "body" | "color" | "font">>) => void;
  onDelete: () => void;
}

const BOX_OFF = "☐ ";
const BOX_ON = "☑ ";
const SWIPE_CLOSE_PX = 110;

const Icon = ({ d, size = 22 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** Full-screen view of one sticker: clean screen in the sticker colour, floating tool panel. */
export function NoteFullscreen({ note, canEdit, canDelete, onClose, onChange, onDelete }: NoteFullscreenProps) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [color, setColor] = useState<NoteColor>(note.color);
  const [font, setFont] = useState<NoteFont>(note.font);
  const [pop, setPop] = useState<null | "color" | "font">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);
  const [dragY, setDragY] = useState(0);
  const [, setTick] = useState(0);

  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const latest = useRef<Snap>({ title, body, color, font });
  latest.current = { title, body, color, font };
  const dirty = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const histTimer = useRef<number | null>(null);
  const hist = useRef<{ stack: Snap[]; idx: number }>({
    stack: [{ title: note.title, body: note.body, color: note.color, font: note.font }],
    idx: 0,
  });
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // someone else's sticker: keep it in sync with live updates
  useEffect(() => {
    // while I have unsent edits keep them; otherwise follow what others changed
    if (canEdit && (dirty.current || saveTimer.current)) return;
    const l = latest.current;
    if (l.title === note.title && l.body === note.body && l.color === note.color && l.font === note.font) return;
    setTitle(note.title);
    setBody(note.body);
    setColor(note.color);
    setFont(note.font);
    hist.current = { stack: [{ title: note.title, body: note.body, color: note.color, font: note.font }], idx: 0 };
  }, [canEdit, note.title, note.body, note.color, note.font]);

  // ---- saving ----
  const flush = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    const s = latest.current;
    onChangeRef.current({ title: s.title, body: s.body, color: s.color, font: s.font });
  }, []);
  const scheduleSave = useCallback(() => {
    dirty.current = true;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, 600);
  }, [flush]);
  useEffect(() => () => flush(), [flush]);

  // ---- undo / redo ----
  const commit = useCallback(() => {
    if (histTimer.current) window.clearTimeout(histTimer.current);
    histTimer.current = null;
    const h = hist.current;
    const s = latest.current;
    const cur = h.stack[h.idx];
    if (cur.title === s.title && cur.body === s.body && cur.color === s.color && cur.font === s.font) return;
    h.stack = h.stack.slice(0, h.idx + 1).concat([{ ...s }]).slice(-100);
    h.idx = h.stack.length - 1;
    setTick((t) => t + 1);
  }, []);
  const typed = useCallback(() => {
    scheduleSave();
    if (histTimer.current) window.clearTimeout(histTimer.current);
    histTimer.current = window.setTimeout(commit, 500);
    setTick((t) => t + 1);
  }, [scheduleSave, commit]);
  const applySnap = (s: Snap) => {
    setTitle(s.title);
    setBody(s.body);
    setColor(s.color);
    setFont(s.font);
    latest.current = { ...s };
    scheduleSave();
    setTick((t) => t + 1);
  };
  const undo = () => {
    commit();
    const h = hist.current;
    if (h.idx > 0) {
      h.idx -= 1;
      applySnap(h.stack[h.idx]);
    }
  };
  const redo = () => {
    commit();
    const h = hist.current;
    if (h.idx < h.stack.length - 1) {
      h.idx += 1;
      applySnap(h.stack[h.idx]);
    }
  };
  const cur0 = hist.current.stack[hist.current.idx];
  const pending = cur0.title !== title || cur0.body !== body || cur0.color !== color || cur0.font !== font;
  const canUndo = canEdit && (hist.current.idx > 0 || pending);
  const canRedo = canEdit && hist.current.idx < hist.current.stack.length - 1 && !pending;

  // ---- close ----
  const close = useCallback(() => {
    commit();
    flush();
    onClose();
  }, [commit, flush, onClose]);
  const closeRef = useRef(close);
  closeRef.current = close;

  // ---- lock page scroll, follow the on-screen keyboard ----
  useLayoutEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const upd = () => setVv({ h: v.height, top: v.offsetTop });
    upd();
    v.addEventListener("resize", upd);
    v.addEventListener("scroll", upd);
    return () => {
      v.removeEventListener("resize", upd);
      v.removeEventListener("scroll", upd);
    };
  }, []);

  // ---- autosize title ----
  useLayoutEffect(() => {
    const t = titleRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  }, [title]);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (pop) setPop(null);
        else if (confirmDelete) setConfirmDelete(false);
        else closeRef.current();
        return;
      }
      if (!canEdit) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) {
          e.preventDefault();
          undo();
        } else if ((k === "z" && e.shiftKey) || k === "y") {
          e.preventDefault();
          redo();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pop, confirmDelete, canEdit]);

  useEffect(() => {
    if (!confirmDelete) return;
    const t = window.setTimeout(() => setConfirmDelete(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmDelete]);

  // ---- swipe down to close (touch only, never while the text is scrolled) ----
  const swipe = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const inBody = e.target === bodyRef.current;
    const scrolled = inBody && (bodyRef.current?.scrollTop ?? 0) > 0;
    const onPanel = (e.target as Element).closest(".fs-panel, .fs-pop");
    swipe.current = scrolled || onPanel ? null : { x: t.clientX, y: t.clientY, active: false };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipe.current;
    if (!s) return;
    const t = e.touches[0];
    const dy = t.clientY - s.y;
    const dx = t.clientX - s.x;
    if (!s.active) {
      if (dy > 14 && dy > Math.abs(dx) * 1.5) s.active = true;
      else if (Math.abs(dx) > 14 || dy < -8) swipe.current = null;
    }
    if (s.active) setDragY(Math.max(0, dy));
  };
  const onTouchEnd = () => {
    const s = swipe.current;
    swipe.current = null;
    if (s?.active && dragY > SWIPE_CLOSE_PX) {
      close();
      return;
    }
    setDragY(0);
  };

  // ---- text helpers ----
  const lineBounds = (text: string, pos: number) => {
    const start = text.lastIndexOf("\n", pos - 1) + 1;
    const nl = text.indexOf("\n", pos);
    return { start, end: nl === -1 ? text.length : nl };
  };
  const setBodyAndCaret = (next: string, a: number, b = a) => {
    setBody(next);
    latest.current = { ...latest.current, body: next };
    typed();
    requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(a, b);
      }
    });
  };

  const toggleChecklist = () => {
    const el = bodyRef.current;
    if (!el || !canEdit) return;
    const selS = el.selectionStart ?? body.length;
    const selE = el.selectionEnd ?? selS;
    const first = lineBounds(body, selS).start;
    const last = lineBounds(body, selE).end;
    const lines = body.slice(first, last).split("\n");
    const isItem = (l: string) => l.startsWith(BOX_OFF) || l.startsWith(BOX_ON);
    const allItems = lines.filter((l) => l.length > 0).every(isItem) && lines.some((l) => l.length > 0);
    const out = lines.map((l) => (allItems ? (isItem(l) ? l.slice(2) : l) : isItem(l) ? l : BOX_OFF + l));
    const replaced = out.join("\n");
    const next = body.slice(0, first) + replaced + body.slice(last);
    setBodyAndCaret(next, first, first + replaced.length);
  };

  const onBodyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!canEdit || e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const pos = el.selectionStart;
    if (pos !== el.selectionEnd) return;
    const { start, end } = lineBounds(body, pos);
    const line = body.slice(start, end);
    if (!(line.startsWith(BOX_OFF) || line.startsWith(BOX_ON))) return;
    e.preventDefault();
    if (line.length <= 2) {
      // empty item: finish the list
      setBodyAndCaret(body.slice(0, start) + body.slice(end), start);
      return;
    }
    const ins = "\n" + BOX_OFF;
    setBodyAndCaret(body.slice(0, pos) + ins + body.slice(pos), pos + ins.length);
  };

  // tap on ☐ / ☑ toggles it
  const onBodyClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    if (!canEdit) return;
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) return;
    const pos = el.selectionStart;
    const { start } = lineBounds(body, pos);
    const head = body.slice(start, start + 2);
    if ((head === BOX_OFF || head === BOX_ON) && pos - start <= 1) {
      const swapped = (head === BOX_OFF ? BOX_ON : BOX_OFF) + body.slice(start + 2);
      const lineEnd = lineBounds(body, pos).end;
      const next = body.slice(0, start) + swapped.slice(0, lineEnd - start) + body.slice(lineEnd);
      setBodyAndCaret(next, start + 2);
    }
  };

  const pickColor = (c: NoteColor) => {
    setColor(c);
    latest.current = { ...latest.current, color: c };
    typed();
    commit();
  };
  const pickFont = (f: NoteFont) => {
    setFont(f);
    latest.current = { ...latest.current, font: f };
    typed();
    commit();
  };

  const style: React.CSSProperties = {
    background: NOTE_COLOR_HEX[color],
    fontFamily: FONT_STACK[font],
    ...(vv ? { height: vv.h, top: vv.top, bottom: "auto" } : null),
    transform: dragY ? `translateY(${dragY}px)` : undefined,
    transition: dragY ? "none" : "transform 200ms ease-out, background 200ms ease-out",
    borderRadius: dragY ? "18px 18px 0 0" : undefined,
  };

  return (
    <div
      className="fs"
      style={style}
      role="dialog"
      aria-modal="true"
      aria-label="Стикер на весь экран"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div className="fs-col">
        <div className="fs-top">
          <button className="fs-round" onClick={close} aria-label="Назад" title="Назад (Esc)">
            <Icon d="M15 5l-7 7 7 7" />
          </button>
          {canEdit ? (
            <div className="fs-history">
              <button className="fs-round" onClick={undo} disabled={!canUndo} aria-label="Отменить" title="Отменить">
                <Icon d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" />
              </button>
              <button className="fs-round" onClick={redo} disabled={!canRedo} aria-label="Повторить" title="Повторить">
                <Icon d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" />
              </button>
            </div>
          ) : (
            <span className="fs-readonly">Только просмотр</span>
          )}
        </div>

        <textarea
          ref={titleRef}
          className="fs-title"
          rows={1}
          value={title}
          placeholder="Заголовок"
          readOnly={!canEdit}
          onChange={(e) => {
            const v = e.target.value.replace(/\n/g, " ");
            setTitle(v);
            latest.current = { ...latest.current, title: v };
            typed();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              bodyRef.current?.focus();
            }
          }}
        />
        <textarea
          ref={bodyRef}
          className="fs-body"
          value={body}
          placeholder={canEdit ? "Напишите заметку…" : "Текста нет"}
          readOnly={!canEdit}
          onChange={(e) => {
            setBody(e.target.value);
            latest.current = { ...latest.current, body: e.target.value };
            typed();
          }}
          onKeyDown={onBodyKeyDown}
          onClick={onBodyClick}
        />
      </div>

      <div className="fs-dock">
        {pop && canEdit && (
          <div className="fs-pop" role="listbox" aria-label={pop === "color" ? "Цвет" : "Шрифт"}>
            {pop === "color"
              ? NOTE_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`fs-dot ${c === color ? "active" : ""}`}
                    style={{ background: NOTE_COLOR_HEX[c] }}
                    onClick={() => pickColor(c)}
                    aria-label={`Цвет ${c}`}
                    aria-pressed={c === color}
                  />
                ))
              : NOTE_FONTS.map((f) => (
                  <button
                    key={f}
                    className={`fs-font ${f === font ? "active" : ""}`}
                    style={{ fontFamily: FONT_STACK[f] }}
                    onClick={() => pickFont(f)}
                    aria-label={`Шрифт ${NOTE_FONT_LABEL[f]}`}
                    aria-pressed={f === font}
                  >
                    Aa
                  </button>
                ))}
          </div>
        )}
        <div className="fs-panel" onPointerDown={(e) => e.preventDefault() /* keep keyboard & caret */}>
          {confirmDelete ? (
            <div className="fs-confirm" role="alertdialog">
              <span>Удалить стикер?</span>
              <button className="fs-pbtn" onClick={() => setConfirmDelete(false)}>Отмена</button>
              <button className="fs-pbtn danger" onClick={onDelete}>Удалить</button>
            </div>
          ) : (
            <>
              {canEdit && (
                <>
                  <button
                    className={`fs-pbtn ${pop === "color" ? "on" : ""}`}
                    onClick={() => setPop(pop === "color" ? null : "color")}
                    aria-label="Цвет"
                    title="Цвет"
                  >
                    <span className="fs-swatch" style={{ background: NOTE_COLOR_HEX[color] }} />
                  </button>
                  <button
                    className={`fs-pbtn ${pop === "font" ? "on" : ""}`}
                    onClick={() => setPop(pop === "font" ? null : "font")}
                    aria-label="Шрифт"
                    title="Шрифт"
                  >
                    <b style={{ fontFamily: FONT_STACK[font] }}>Aa</b>
                  </button>
                  <button className="fs-pbtn" onClick={toggleChecklist} aria-label="Чек-лист" title="Чек-лист">
                    <Icon d="M9 11l3 3 8-8M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h9" />
                  </button>
                </>
              )}
              {canDelete && (
                <button className="fs-pbtn danger" onClick={() => setConfirmDelete(true)} aria-label="Удалить" title="Удалить">
                  <Icon d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                </button>
              )}
              <button className="fs-done" onClick={close} aria-label="Готово" title="Готово">
                <Icon d="M5 12.5l4.5 4.5L19 7.5" size={26} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
