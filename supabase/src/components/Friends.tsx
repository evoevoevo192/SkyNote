import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  MAX_REQUESTS_PER_DAY,
  fetchMyPublicId,
  formatLastActive,
  formatPublicIdInput,
  type FriendsApi,
  type Person,
} from "../lib/friends";

export interface Toast {
  id: number;
  text: string;
  kind: "success" | "error";
}

export type Notify = (text: string, kind?: "success" | "error") => void;

// ---------- small pieces ----------
export function FriendsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
      <circle cx="17.5" cy="9" r="2.5" />
      <path d="M17 14.2c2.6.2 4.5 2 4.5 5" />
    </svg>
  );
}

export function Spinner() {
  return <span className="fr-spinner" aria-hidden="true" />;
}

export function Avatar({ name }: { name: string }) {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  let hue = 0;
  for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="fr-avatar" style={{ background: `hsl(${hue} 52% 46%)` }} aria-hidden="true">
      {letter}
    </span>
  );
}

export function ToastView({ toast, onClose }: { toast: Toast | null; onClose: () => void }) {
  if (!toast) return null;
  return (
    <div className={`app-toast ${toast.kind}`} role="status" aria-live="polite" key={toast.id}>
      <span className="app-toast-dot" aria-hidden="true" />
      <span className="app-toast-text">{toast.text}</span>
      <button className="app-toast-close" onClick={onClose} aria-label="Закрыть уведомление">×</button>
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

interface SheetProps {
  title: string;
  onClose: () => void;
  onBack?: () => void;
  children: ReactNode;
}

export function Sheet({ title, onClose, onBack, children }: SheetProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fr-overlay" onClick={onClose}>
      <div className="fr-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="fr-head">
          {onBack && (
            <button className="fr-icon-btn" onClick={onBack} aria-label="Назад">‹</button>
          )}
          <h2 className="fr-title">{title}</h2>
          <button className="fr-icon-btn" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        <div className="fr-body">{children}</div>
      </div>
    </div>
  );
}

// ---------- friends dialog ----------
type Tab = "friends" | "requests" | "add";

interface FriendsDialogProps {
  api: FriendsApi;
  onClose: () => void;
  notify: Notify;
}

export function FriendsDialog({ api, onClose, notify }: FriendsDialogProps) {
  const [tab, setTab] = useState<Tab>("friends");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; kind: "remove" | "block" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (key: string, fn: () => Promise<string | null>, okText: string) => {
    if (busy) return false;
    setBusy(key);
    const error = await fn();
    setBusy(null);
    if (error) notify(error, "error");
    else notify(okText, "success");
    return !error;
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    if (code.length < 9) {
      setCodeError("Введите ID полностью: 8 символов, например K7M2-9QX4");
      return;
    }
    setCodeError(null);
    setSending(true);
    const result = await api.sendRequest(code);
    setSending(false);
    if (result.error) {
      setCodeError(result.error);
      return;
    }
    setCode("");
    notify(
      result.status === "accepted"
        ? `Вы теперь друзья: ${result.username}`
        : `Заявка отправлена: ${result.username}`,
      "success"
    );
  };

  const tabButton = (key: Tab, label: string, badge?: number) => (
    <button
      key={key}
      role="tab"
      aria-selected={tab === key}
      className={`fr-tab ${tab === key ? "active" : ""}`}
      onClick={() => setTab(key)}
    >
      {label}
      {badge ? <span className="fr-badge" aria-label={`${badge} новых`}>{badge > 99 ? "99+" : badge}</span> : null}
    </button>
  );

  return (
    <Sheet title="Друзья" onClose={onClose}>
      <div className="fr-tabs" role="tablist">
        {tabButton("friends", "Друзья")}
        {tabButton("requests", "Заявки", api.incoming.length)}
        {tabButton("add", "Добавить")}
      </div>

      {api.loadError && <div className="fr-error fr-block-error" role="alert">{api.loadError}</div>}

      {tab === "friends" && (
        <div className="fr-panel">
          {api.loading && <div className="fr-empty"><Spinner /> Загрузка…</div>}
          {!api.loading && api.friends.length === 0 && (
            <div className="fr-empty">
              Пока нет друзей.
              <button className="fr-link" onClick={() => setTab("add")}>Добавить по ID</button>
            </div>
          )}
          <ul className="fr-list">
            {api.friends.map((f) => {
              const open = menuId === f.friendshipId;
              const asking = confirm?.id === f.friendshipId ? confirm : null;
              const name = f.person.username;
              return (
                <li className="fr-row" key={f.friendshipId}>
                  <div className="fr-row-main">
                    <Avatar name={name} />
                    <div className="fr-info">
                      <div className="fr-name">{name}</div>
                      <div className="fr-sub">{formatLastActive(f.lastActive)}</div>
                    </div>
                    <button
                      className="fr-icon-btn"
                      aria-label={`Действия: ${name}`}
                      aria-expanded={open}
                      onClick={() => {
                        setMenuId(open ? null : f.friendshipId);
                        setConfirm(null);
                      }}
                    >
                      ⋯
                    </button>
                  </div>
                  {open && (
                    <div className="fr-menu">
                      {asking ? (
                        <div className="fr-confirm" role="alertdialog" aria-label="Подтверждение">
                          <span>
                            {asking.kind === "remove"
                              ? `Удалить ${name} из друзей?`
                              : `Заблокировать ${name}? Он перестанет видеть ваши стикеры.`}
                          </span>
                          <button className="fr-btn" onClick={() => setConfirm(null)}>Отмена</button>
                          <button
                            className="fr-btn danger"
                            disabled={busy !== null}
                            onClick={async () => {
                              const done =
                                asking.kind === "remove"
                                  ? await act(`rm-${f.friendshipId}`, () => api.remove(f.friendshipId), "Удалён из друзей")
                                  : await act(`bl-${f.friendshipId}`, () => api.block(f.person.id), "Пользователь заблокирован");
                              if (done) {
                                setMenuId(null);
                                setConfirm(null);
                              }
                            }}
                          >
                            {busy !== null && <Spinner />}
                            {asking.kind === "remove" ? "Удалить" : "Заблокировать"}
                          </button>
                        </div>
                      ) : (
                        <>
                          <button className="fr-menu-item danger" onClick={() => setConfirm({ id: f.friendshipId, kind: "remove" })}>
                            Удалить из друзей
                          </button>
                          <button className="fr-menu-item danger" onClick={() => setConfirm({ id: f.friendshipId, kind: "block" })}>
                            Заблокировать
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {tab === "requests" && (
        <div className="fr-panel">
          {api.loading && <div className="fr-empty"><Spinner /> Загрузка…</div>}
          {!api.loading && api.incoming.length === 0 && api.outgoing.length === 0 && (
            <div className="fr-empty">Заявок нет</div>
          )}

          {api.incoming.length > 0 && (
            <>
              <h3 className="fr-section">Входящие</h3>
              <ul className="fr-list">
                {api.incoming.map((r) => (
                  <li className="fr-row" key={r.friendshipId}>
                    <div className="fr-row-main">
                      <Avatar name={r.person.username} />
                      <div className="fr-info">
                        <div className="fr-name">{r.person.username}</div>
                      </div>
                      <div className="fr-actions">
                        <button
                          className="fr-btn primary"
                          disabled={busy !== null}
                          onClick={() => act(`ac-${r.friendshipId}`, () => api.accept(r.friendshipId), `Вы теперь друзья: ${r.person.username}`)}
                        >
                          {busy === `ac-${r.friendshipId}` && <Spinner />}
                          Принять
                        </button>
                        <button
                          className="fr-btn"
                          disabled={busy !== null}
                          onClick={() => act(`dc-${r.friendshipId}`, () => api.remove(r.friendshipId), "Заявка отклонена")}
                        >
                          {busy === `dc-${r.friendshipId}` && <Spinner />}
                          Отклонить
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {api.outgoing.length > 0 && (
            <>
              <h3 className="fr-section">Исходящие</h3>
              <ul className="fr-list">
                {api.outgoing.map((r) => (
                  <li className="fr-row" key={r.friendshipId}>
                    <div className="fr-row-main">
                      <Avatar name={r.person.username} />
                      <div className="fr-info">
                        <div className="fr-name">{r.person.username}</div>
                        <div className="fr-sub">Ожидает ответа</div>
                      </div>
                      <button
                        className="fr-btn"
                        disabled={busy !== null}
                        onClick={() => act(`ca-${r.friendshipId}`, () => api.remove(r.friendshipId), "Заявка отменена")}
                      >
                        {busy === `ca-${r.friendshipId}` && <Spinner />}
                        Отменить
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {tab === "add" && (
        <form className="fr-panel fr-form" onSubmit={submitCode} noValidate>
          <label className="fr-field">
            <span>ID пользователя</span>
            <input
              className="fr-input"
              value={code}
              onChange={(e) => {
                setCode(formatPublicIdInput(e.target.value));
                setCodeError(null);
              }}
              placeholder="XXXX-XXXX"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={9}
              aria-invalid={Boolean(codeError)}
              aria-describedby="fr-code-help"
              autoFocus
            />
            {codeError && <span className="fr-error" role="alert">{codeError}</span>}
          </label>
          <p className="fr-hint" id="fr-code-help">
            ID друга виден ему в меню профиля. Не больше {MAX_REQUESTS_PER_DAY} заявок в сутки.
          </p>
          <button type="submit" className="fr-btn primary fr-wide" disabled={sending}>
            {sending && <Spinner />}
            {sending ? "Отправляем…" : "Отправить заявку"}
          </button>
        </form>
      )}
    </Sheet>
  );
}

// ---------- profile dialog ----------
interface ProfileDialogProps {
  username: string;
  api: FriendsApi;
  onClose: () => void;
  notify: Notify;
}

export function ProfileDialog({ username, api, onClose, notify }: ProfileDialogProps) {
  const [view, setView] = useState<"main" | "blocked">("main");
  const [publicId, setPublicId] = useState<string | null>(null);
  const [idFailed, setIdFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMyPublicId().then((id) => {
      if (!alive) return;
      if (id) setPublicId(id);
      else setIdFailed(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const copy = async () => {
    if (!publicId) return;
    const ok = await copyText(publicId);
    notify(ok ? "Скопировано" : "Не удалось скопировать. Выделите ID вручную", ok ? "success" : "error");
  };

  const unblock = async (friendshipId: string, name: string) => {
    if (busy) return;
    setBusy(friendshipId);
    const error = await api.remove(friendshipId);
    setBusy(null);
    if (error) notify(error, "error");
    else notify(`${name} разблокирован`, "success");
  };

  if (view === "blocked") {
    return (
      <Sheet title="Заблокированные" onClose={onClose} onBack={() => setView("main")}>
        <div className="fr-panel">
          {api.blocked.length === 0 && <div className="fr-empty">Список пуст</div>}
          <ul className="fr-list">
            {api.blocked.map((b) => (
              <li className="fr-row" key={b.friendshipId}>
                <div className="fr-row-main">
                  <Avatar name={b.person.username} />
                  <div className="fr-info">
                    <div className="fr-name">{b.person.username}</div>
                  </div>
                  <button className="fr-btn" disabled={busy !== null} onClick={() => unblock(b.friendshipId, b.person.username)}>
                    {busy === b.friendshipId && <Spinner />}
                    Разблокировать
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Профиль" onClose={onClose}>
      <div className="fr-panel">
        <div className="fr-profile-head">
          <Avatar name={username || "?"} />
          <div className="fr-info">
            <div className="fr-name">{username || "Без ника"}</div>
            <div className="fr-sub">Ваш ник для друзей</div>
          </div>
        </div>

        <div className="fr-id-label">Ваш ID для друзей</div>
        <button className="fr-id-btn" onClick={copy} disabled={!publicId} aria-label={publicId ? `Скопировать ID ${publicId}` : "ID загружается"}>
          {publicId ? (
            <>
              <span className="fr-id-code">{publicId}</span>
              <span className="fr-id-copy">Копировать</span>
            </>
          ) : idFailed ? (
            <span className="fr-error">Не удалось загрузить ID</span>
          ) : (
            <span><Spinner /> Загрузка…</span>
          )}
        </button>
        <p className="fr-hint">Отправьте этот ID другу, чтобы он мог добавить вас.</p>

        <button className="fr-menu-item fr-menu-wide" onClick={() => setView("blocked")}>
          Заблокированные
          {api.blocked.length > 0 && <span className="fr-count">{api.blocked.length}</span>}
        </button>
      </div>
    </Sheet>
  );
}
