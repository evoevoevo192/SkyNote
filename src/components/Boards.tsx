import { useState } from "react";
import { Avatar, Sheet, Spinner } from "./Friends";
import type { Notify } from "./Friends";
import type { BoardsApi } from "../lib/boards";
import type { FriendsApi } from "../lib/friends";
import { BOARD_MAX_FRIENDS, BOARD_NAME_MAX } from "../lib/supabase";
import type { BoardInfo } from "../lib/supabase";

// ---------- chips row ----------
interface ChipsProps {
  boards: BoardInfo[];
  activeId: string | null;
  onPick: (id: string | null) => void;
  onNew: () => void;
  onManage: (id: string) => void;
}

export function BoardChips({ boards, activeId, onPick, onNew, onManage }: ChipsProps) {
  return (
    <nav className="board-chips" aria-label="Доски">
      {boards.map((b) => (
        <span key={b.id} className={`bchip-wrap ${activeId === b.id ? "active" : ""}`}>
          <button className="bchip" onClick={() => onPick(b.id)} title={b.name}>
            <span className="bchip-name">{b.name}</span>
          </button>
          {activeId === b.id && (
            <button className="bchip-gear" onClick={() => onManage(b.id)} aria-label="Настройки доски" title="Настройки доски">
              ⚙
            </button>
          )}
        </span>
      ))}
      <button className="bchip bchip-new" onClick={onNew}>+ Новая доска</button>
    </nav>
  );
}

// ---------- new board ----------
interface NewProps {
  friends: FriendsApi;
  boards: BoardsApi;
  onClose: () => void;
  onCreated: (id: string) => void;
  notify: Notify;
}

export function NewBoardDialog({ friends, boards, onClose, onCreated, notify }: NewProps) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= BOARD_MAX_FRIENDS ? p : [...p, id]));

  const submit = async () => {
    const clean = name.trim();
    if (!clean) {
      setError("Введите название доски");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await boards.create(clean, picked);
    setBusy(false);
    if (res.error || !res.id) {
      setError(res.error ?? "Не удалось создать доску");
      return;
    }
    notify(`Доска «${clean}» создана`);
    onCreated(res.id);
  };

  return (
    <Sheet title="Новая доска" onClose={onClose}>
      <form
        className="fr-panel fr-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="fr-field">
          Название
          <input
            className="fr-input bname"
            value={name}
            maxLength={BOARD_NAME_MAX}
            placeholder="Например, Поездка в Казань"
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        <div className="fr-section">
          Друзья на доске · {picked.length} из {BOARD_MAX_FRIENDS}
        </div>
        {friends.loading && <div className="fr-empty"><Spinner /> Загрузка…</div>}
        {!friends.loading && friends.friends.length === 0 && (
          <p className="fr-hint">Друзей пока нет. Доску можно создать и одному, а людей добавить позже.</p>
        )}
        <ul className="fr-list">
          {friends.friends.map((f) => {
            const on = picked.includes(f.person.id);
            const locked = !on && picked.length >= BOARD_MAX_FRIENDS;
            return (
              <li key={f.friendshipId}>
                <button
                  type="button"
                  className={`fr-row bpick ${on ? "on" : ""}`}
                  aria-pressed={on}
                  disabled={locked}
                  onClick={() => toggle(f.person.id)}
                >
                  <Avatar name={f.person.username} />
                  <span className="fr-info"><span className="fr-name">{f.person.username}</span></span>
                  <span className="bpick-mark" aria-hidden="true">{on ? "✓" : ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {error && <div className="fr-error" role="alert">{error}</div>}
        <button className="fr-btn primary fr-wide" type="submit" disabled={busy}>
          {busy && <Spinner />} Создать доску
        </button>
      </form>
    </Sheet>
  );
}

// ---------- board settings ----------
interface ManageProps {
  board: BoardInfo;
  userId: string;
  friends: FriendsApi;
  boards: BoardsApi;
  onClose: () => void;
  onGone: () => void; // left or deleted: the board is no longer available
  notify: Notify;
}

export function BoardDialog({ board, userId, friends, boards, onClose, onGone, notify }: ManageProps) {
  const isOwner = board.owner_id === userId;
  const [name, setName] = useState(board.name);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "leave" | null>(null);

  const members = boards.members.filter((m) => m.board_id === board.id);
  const memberIds = new Set(members.map((m) => m.user_id));
  const nameOf = (id: string) =>
    id === userId ? "Вы" : boards.names[id] ?? friends.friends.find((f) => f.person.id === id)?.person.username ?? "Пользователь";
  const others = members
    .map((m) => m.user_id)
    .sort((a, b) => (a === board.owner_id ? -1 : b === board.owner_id ? 1 : nameOf(a).localeCompare(nameOf(b), "ru")));
  const friendCount = members.filter((m) => m.user_id !== board.owner_id).length;
  const candidates = friends.friends.filter((f) => !memberIds.has(f.person.id));

  const run = async (key: string, fn: () => Promise<string | null>, ok?: string, after?: () => void) => {
    setBusy(key);
    setError(null);
    const err = await fn();
    setBusy(null);
    if (err) {
      setError(err);
      return;
    }
    if (ok) notify(ok);
    after?.();
  };

  const saveName = () => {
    const clean = name.trim();
    if (!clean) {
      setError("Введите название доски");
      return;
    }
    if (clean === board.name) return;
    run("rename", () => boards.rename(board.id, clean), "Название сохранено");
  };

  return (
    <Sheet title={isOwner ? "Настройки доски" : board.name} onClose={onClose}>
      <div className="fr-panel fr-form">
        {isOwner && (
          <form
            className="bname-row"
            onSubmit={(e) => {
              e.preventDefault();
              saveName();
            }}
          >
            <input
              className="fr-input bname"
              value={name}
              maxLength={BOARD_NAME_MAX}
              aria-label="Название доски"
              onChange={(e) => setName(e.target.value)}
            />
            <button className="fr-btn primary" type="submit" disabled={busy === "rename" || name.trim() === board.name}>
              {busy === "rename" ? <Spinner /> : "Сохранить"}
            </button>
          </form>
        )}

        <div className="fr-section">Участники · {members.length}</div>
        <ul className="fr-list">
          {others.map((id) => (
            <li className="fr-row" key={id}>
              <div className="fr-row-main">
                <Avatar name={nameOf(id)} />
                <div className="fr-info">
                  <div className="fr-name">{nameOf(id)}</div>
                  <div className="fr-sub">{id === board.owner_id ? "Владелец" : "Участник"}</div>
                </div>
                {isOwner && id !== userId && (
                  <button
                    className="fr-btn danger"
                    disabled={busy === `rm-${id}`}
                    onClick={() => run(`rm-${id}`, () => boards.removeMember(board.id, id), "Участник убран с доски")}
                  >
                    {busy === `rm-${id}` ? <Spinner /> : "Убрать"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>

        {isOwner && (
          <>
            <div className="fr-section">Добавить друзей · {friendCount} из {BOARD_MAX_FRIENDS}</div>
            {friendCount >= BOARD_MAX_FRIENDS && <p className="fr-hint">Достигнут предел: 7 друзей на доске.</p>}
            {friendCount < BOARD_MAX_FRIENDS && candidates.length === 0 && (
              <p className="fr-hint">Все ваши друзья уже на этой доске.</p>
            )}
            {friendCount < BOARD_MAX_FRIENDS && (
              <ul className="fr-list">
                {candidates.map((f) => (
                  <li className="fr-row" key={f.friendshipId}>
                    <div className="fr-row-main">
                      <Avatar name={f.person.username} />
                      <div className="fr-info"><div className="fr-name">{f.person.username}</div></div>
                      <button
                        className="fr-btn"
                        disabled={busy === `add-${f.person.id}`}
                        onClick={() => run(`add-${f.person.id}`, () => boards.addMember(board.id, f.person.id), `${f.person.username} добавлен(а)`)}
                      >
                        {busy === `add-${f.person.id}` ? <Spinner /> : "Добавить"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {error && <div className="fr-error" role="alert">{error}</div>}

        {confirm ? (
          <div className="fr-confirm" role="alertdialog">
            <span>
              {confirm === "delete"
                ? "Удалить доску вместе со всеми стикерами и фото? Это нельзя отменить."
                : "Выйти с доски? Ваши стикеры и фото на ней останутся."}
            </span>
            <button className="fr-btn" onClick={() => setConfirm(null)}>Отмена</button>
            <button
              className="fr-btn danger"
              disabled={busy === "final"}
              onClick={() =>
                run(
                  "final",
                  () => (confirm === "delete" ? boards.remove(board.id) : boards.removeMember(board.id, userId)),
                  confirm === "delete" ? "Доска удалена" : "Вы вышли с доски",
                  onGone
                )
              }
            >
              {busy === "final" ? <Spinner /> : confirm === "delete" ? "Удалить" : "Выйти"}
            </button>
          </div>
        ) : (
          <button className="fr-btn danger fr-wide" onClick={() => setConfirm(isOwner ? "delete" : "leave")}>
            {isOwner ? "Удалить доску" : "Выйти с доски"}
          </button>
        )}
      </div>
    </Sheet>
  );
}
