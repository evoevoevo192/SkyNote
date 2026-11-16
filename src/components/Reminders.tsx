import { useState } from "react";
import { Sheet } from "./Friends";
import { askPermission, canNotify, setReminder, MAX_REMINDERS } from "../lib/reminders";

const pad = (n: number) => String(n).padStart(2, "0");
const toInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmt = (iso: string) => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

interface Props {
  noteId: string;
  current: string | null;
  onClose: () => void;
  notify: (text: string, kind?: "success" | "error") => void;
}

export function ReminderDialog({ noteId, current, onClose, notify }: Props) {
  const soon = new Date(Date.now() + 3600_000);
  const [value, setValue] = useState(current ? toInput(new Date(current)) : toInput(soon));
  const [error, setError] = useState<string | null>(null);
  const denied = canNotify() && Notification.permission === "denied";

  const save = async (when: Date) => {
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60_000) return setError("Время уже прошло");
    // the permission is asked in the tap that sets the reminder
    const perm = await askPermission();
    if (!setReminder(noteId, when.toISOString())) return setError(`Можно не больше ${MAX_REMINDERS} напоминаний`);
    notify(perm === "granted" || perm === "unsupported" ? `Напомню ${fmt(when.toISOString())}` : "Напоминание поставлено (без системных уведомлений)");
    onClose();
  };

  const at = (days: number, h: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(h, 0, 0, 0);
    return d;
  };
  const evening = at(0, 19);
  const quick: { label: string; when: Date }[] = [
    { label: "Через час", when: new Date(Date.now() + 3600_000) },
    ...(evening.getTime() > Date.now() + 10 * 60_000 ? [{ label: "Сегодня в 19:00", when: evening }] : []),
    { label: "Завтра в 9:00", when: at(1, 9) },
    { label: "Через неделю", when: at(7, 9) },
  ];

  return (
    <Sheet title="Напоминание" onClose={onClose}>
      <div className="fr-panel fr-form rem-form">
        {current && <p className="fr-hint">Сейчас: <strong>{fmt(current)}</strong></p>}
        <div className="rem-quick">
          {quick.map((q) => (
            <button key={q.label} type="button" className="fr-btn" onClick={() => void save(q.when)}>{q.label}</button>
          ))}
        </div>
        <label className="fr-field">
          Дата и время
          <input className="fr-input" type="datetime-local" value={value} min={toInput(new Date())} onChange={(e) => (setValue(e.target.value), setError(null))} />
        </label>
        {error && <div className="fr-error" role="alert">{error}</div>}
        <p className="fr-hint">
          Видно только вам, даже на общей доске. Сработает, пока приложение открыто (можно свёрнутым); если оно было закрыто — покажем пропущенное при следующем открытии.
          {denied && " Системные уведомления запрещены в браузере, поэтому напоминание появится только внутри приложения."}
        </p>
        <div className="fr-actions">
          {current && <button type="button" className="fr-btn" onClick={() => (setReminder(noteId, null), notify("Напоминание снято"), onClose())}>Снять</button>}
          <button type="button" className="fr-btn primary" onClick={() => void save(new Date(value))}>Поставить</button>
        </div>
      </div>
    </Sheet>
  );
}

export function BellIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 003.4 0" />
    </svg>
  );
}
