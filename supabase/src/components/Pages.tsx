import { useEffect, useRef, useState } from "react";
import { Sheet } from "./Friends";
import type { Notify } from "./Friends";
import { MAX_PAGES, PAGE_NAME_MAX } from "../lib/pages";
import type { PageInfo, PagesApi } from "../lib/pages";

export function pageLabel(p: PageInfo, index: number): string {
  return p.name ? p.name : `Страница ${index + 1}`;
}

// ---------- bottom switcher: ‹ 1 / 3 › + ----------
interface BarProps {
  api: PagesApi;
  onMenu: () => void;
  notify: Notify;
}

export function PageBar({ api, onMenu, notify }: BarProps) {
  const { pages, index } = api;
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const [busy, setBusy] = useState(false);
  const cur = pages[index];

  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const add = async () => {
    if (busy) return;
    setBusy(true);
    const err = await api.add();
    setBusy(false);
    if (err) notify(err, "error");
  };

  return (
    <div className="page-bar" role="group" aria-label="Страницы доски" onPointerDown={(e) => e.stopPropagation()}>
      <button className="pg-btn" onClick={() => api.go(-1)} disabled={index <= 0} aria-label="Предыдущая страница">‹</button>
      <button
        className="pg-label"
        title="Нажмите и удерживайте, чтобы переименовать"
        aria-label={`Страница ${index + 1} из ${pages.length}${cur?.name ? `, ${cur.name}` : ""}. Меню страницы`}
        onPointerDown={() => {
          longPressed.current = false;
          clear();
          timer.current = window.setTimeout(() => {
            longPressed.current = true;
            onMenu();
          }, 500);
        }}
        onPointerUp={clear}
        onPointerLeave={clear}
        onPointerCancel={clear}
        onClick={() => {
          if (!longPressed.current) onMenu();
          longPressed.current = false;
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {cur?.name && <span className="pg-name">{cur.name}</span>}
        <span className="pg-num">{index + 1} / {pages.length}</span>
      </button>
      <button className="pg-btn" onClick={() => api.go(1)} disabled={index >= pages.length - 1} aria-label="Следующая страница">›</button>
      <button className="pg-btn pg-add" onClick={add} disabled={busy || pages.length >= MAX_PAGES} aria-label="Новая страница" title={pages.length >= MAX_PAGES ? `Не больше ${MAX_PAGES} страниц` : "Новая страница"}>+</button>
    </div>
  );
}

// ---------- page menu: jump, rename, delete ----------
interface MenuProps {
  api: PagesApi;
  /** objects on every page (to know which pages are empty) */
  counts: Record<number, number>;
  onClose: () => void;
  notify: Notify;
}

export function PageMenu({ api, counts, onClose, notify }: MenuProps) {
  const { pages, page, index } = api;
  const cur = pages[index];
  const [name, setName] = useState(cur?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const empty = (counts[page] ?? 0) === 0;
  const canDelete = pages.length > 1 && empty;

  const save = async () => {
    if (busy) return;
    if (name.trim() === (cur?.name ?? "")) return;
    setBusy(true);
    const err = await api.rename(page, name);
    setBusy(false);
    if (err) notify(err, "error");
    else notify("Название сохранено");
  };

  const del = async () => {
    setBusy(true);
    const err = await api.remove(page);
    setBusy(false);
    if (err) {
      notify(err, "error");
      setConfirm(false);
    } else {
      notify("Страница удалена");
      onClose();
    }
  };

  return (
    <Sheet title="Страницы" onClose={onClose}>
      <div className="pg-list" role="list">
        {pages.map((p, i) => (
          <button
            key={p.page}
            role="listitem"
            className={`pg-row ${p.page === page ? "active" : ""}`}
            onClick={() => {
              api.setPage(p.page);
              onClose();
            }}
          >
            <span className="pg-row-name">{pageLabel(p, i)}</span>
            <span className="pg-row-count">{counts[p.page] ?? 0} шт.</span>
          </button>
        ))}
      </div>

      <label className="fr-field pg-field">
        Название страницы {index + 1}
        <input
          className="pg-input"
          value={name}
          maxLength={PAGE_NAME_MAX}
          placeholder={`Страница ${index + 1}`}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
      </label>
      <div className="pg-actions">
        <button className="fr-btn primary" onClick={save} disabled={busy || name.trim() === (cur?.name ?? "")}>Сохранить название</button>
        {confirm ? (
          <>
            <button className="fr-btn" onClick={() => setConfirm(false)} disabled={busy}>Отмена</button>
            <button className="fr-btn danger" onClick={del} disabled={busy}>Удалить страницу</button>
          </>
        ) : (
          <button
            className="fr-btn danger"
            onClick={() => setConfirm(true)}
            disabled={!canDelete || busy}
            title={pages.length <= 1 ? "Последнюю страницу удалить нельзя" : empty ? "Удалить страницу" : "Удалить можно только пустую страницу"}
          >
            Удалить страницу
          </button>
        )}
      </div>
      {!canDelete && <p className="pg-hint">{pages.length <= 1 ? "Это единственная страница." : "Удалить можно только пустую страницу: уберите с неё стикеры, нити и рисунок или перенесите их."}</p>}
    </Sheet>
  );
}

// ---------- "Переместить на страницу…" ----------
interface MoveProps {
  pages: PageInfo[];
  current: number;
  onMove: (page: number) => void;
  className?: string;
}

export function MoveToPage({ pages, current, onMove, className = "" }: MoveProps) {
  const [open, setOpen] = useState(false);
  const others = pages.map((p, i) => ({ p, i })).filter(({ p }) => p.page !== current);
  if (others.length === 0) return null;
  return (
    <div className={`move-page ${className}`}>
      <button type="button" className="move-page-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Переместить на страницу…
      </button>
      {open && (
        <div className="move-page-list" role="menu">
          {others.map(({ p, i }) => (
            <button key={p.page} type="button" role="menuitem" className="move-page-item" onClick={() => onMove(p.page)}>
              {i + 1}{p.name ? ` · ${p.name}` : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
