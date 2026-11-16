import { useEffect, useRef, useState } from "react";
import { Sheet, Spinner } from "./Friends";
import { CODE_RE, changeCode, lockMessage, lockNote, openNote, removeLock, waitLeft, type LockResult } from "../lib/locks";

export type LockDialogKind = "open" | "set" | "change" | "remove";

interface Props {
  kind: LockDialogKind;
  noteId: string;
  onClose: () => void;
  /** the code was accepted (for "open": the content is now in memory) */
  onDone: (kind: LockDialogKind) => void;
}

const TITLES: Record<LockDialogKind, string> = {
  open: "Введите код",
  set: "Заблокировать стикер",
  change: "Сменить код",
  remove: "Снять блокировку",
};

/** digits only, numeric keypad on phones */
function CodeInput({ label, value, onChange, autoFocus, id }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; id: string }) {
  return (
    <label className="fr-field" htmlFor={id}>
      {label}
      <input
        id={id}
        className="fr-input code-input"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        maxLength={6}
        value={value}
        placeholder="••••"
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      />
    </label>
  );
}

export function LockIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </svg>
  );
}

export function LockDialog({ kind, noteId, onClose, onDone }: Props) {
  const [cur, setCur] = useState("");
  const [code, setCode] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(() => waitLeft(noteId));
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // (also after the effect re-run of React strict mode)
    return () => void (alive.current = false);
  }, []);

  // countdown of the pause after wrong codes
  const waiting = wait > 0;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setWait(waitLeft(noteId)), 400);
    return () => clearInterval(t);
  }, [waiting, noteId]);

  const needCur = kind !== "set";
  const needNew = kind === "set" || kind === "change";

  const submit = async () => {
    if (busy || wait > 0) return;
    if (needCur && !CODE_RE.test(cur)) return setError("Код — от 4 до 6 цифр");
    if (needNew) {
      if (!CODE_RE.test(code)) return setError("Новый код — от 4 до 6 цифр");
      if (code !== again) return setError("Коды не совпадают");
    }
    setBusy(true);
    setError(null);
    let r: LockResult;
    if (kind === "open") r = await openNote(noteId, cur);
    else if (kind === "set") r = await lockNote(noteId, code);
    else if (kind === "change") r = await changeCode(noteId, cur, code);
    else r = await removeLock(noteId, cur);
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) return onDone(kind);
    if (r.reason === "wait") setWait(waitLeft(noteId) || r.seconds);
    setCur("");
    setError(lockMessage(r));
  };

  return (
    <Sheet title={TITLES[kind]} onClose={onClose}>
      <form
        className="fr-panel fr-form lock-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {kind === "set" && (
          <p className="fr-hint lock-warn">
            Задайте код из 4–6 цифр. <strong>Забытый код восстановить нельзя</strong> — текст и фото стикера останутся закрытыми навсегда. Запишите код в надёжном месте.
          </p>
        )}
        {kind === "remove" && <p className="fr-hint">После снятия блокировки стикер снова будет виден всем, кто видит доску.</p>}
        {needCur && <CodeInput id="lock-cur" label={kind === "change" ? "Текущий код" : "Код"} value={cur} onChange={setCur} autoFocus />}
        {needNew && (
          <>
            <CodeInput id="lock-new" label={kind === "change" ? "Новый код" : "Код (4–6 цифр)"} value={code} onChange={setCode} autoFocus={kind === "set"} />
            <CodeInput id="lock-again" label="Повторите код" value={again} onChange={setAgain} />
          </>
        )}
        {wait > 0 && <div className="fr-error">Слишком много попыток. Подождите {wait} с</div>}
        {error && wait <= 0 && <div className="fr-error" role="alert">{error}</div>}
        <div className="fr-actions">
          <button type="button" className="fr-btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="fr-btn primary" disabled={busy || wait > 0}>
            {busy ? <Spinner /> : kind === "open" ? "Открыть" : kind === "set" ? "Заблокировать" : kind === "change" ? "Сменить" : "Снять"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
