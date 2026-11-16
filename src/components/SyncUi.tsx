import { useOnline, usePendingCount, useSyncState } from "../lib/sync";
import { useInstall } from "../lib/pwa";

/** Toolbar badge: «Синхронизировано» / «Ожидает отправки (N)» / «Нет сети». */
export function SyncBadge() {
  const online = useOnline();
  const pending = usePendingCount();
  const { syncing } = useSyncState();
  const kind = !online ? "offline" : pending > 0 ? "pending" : "ok";
  const text = !online ? (pending > 0 ? `Нет сети · в очереди ${pending}` : "Нет сети") : pending > 0 ? `Ожидает отправки (${pending})` : "Синхронизировано";
  return (
    <span className={`sync-badge ${kind}${syncing ? " busy" : ""}`} role="status" aria-live="polite" title={text}>
      <span className="sync-dot" aria-hidden="true" />
      <span className="sync-text">{text}</span>
      {pending > 0 && <span className="sync-n" aria-hidden="true">{pending}</span>}
    </span>
  );
}

export function OfflineBanner() {
  return (
    <div className="offline-banner" role="status">
      <strong>Нет сети.</strong> Доска открыта только для чтения: видны последние сохранённые данные.
    </div>
  );
}

/** «Установить приложение» in the profile / settings sheet. */
export function InstallRow({ notify }: { notify: (text: string, kind?: "success" | "error") => void }) {
  const { installed, canPrompt, ios, install } = useInstall();
  if (installed) return <p className="fr-hint">Приложение установлено на это устройство.</p>;
  const run = async () => {
    const r = await install();
    if (r === "accepted") notify("Приложение устанавливается");
    else if (r === "unavailable") notify(ios ? "Нажмите «Поделиться» и выберите «На экран Домой»" : "Откройте меню браузера и выберите «Установить приложение»");
  };
  return (
    <>
      <button className="fr-menu-item fr-menu-wide install-btn" onClick={run}>
        Установить приложение
      </button>
      <p className="fr-hint">
        {canPrompt
          ? "Стикеры откроются отдельным окном и будут работать без сети."
          : ios
            ? "На iPhone и iPad: «Поделиться» → «На экран Домой»."
            : "Если кнопка не сработала, найдите «Установить приложение» в меню браузера."}
      </p>
    </>
  );
}
