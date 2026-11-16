import { useRef, useState } from "react";
import { Sheet } from "./Friends";
import { canShareFiles, downloadFile, exportJson, exportPdf, exportPng, fileName, shareFile, type ExportInput } from "../lib/export";

type Kind = "png" | "pdf" | "json";
interface Ready {
  blob: Blob;
  name: string;
  share: boolean;
}

interface Props {
  build: () => ExportInput;
  onClose: () => void;
  notify: (text: string, kind?: "success" | "error") => void;
}

export function ExportSheet({ build, onClose, notify }: Props) {
  const [busy, setBusy] = useState<{ kind: Kind; frac: number; label: string } | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<ExportInput>();
  if (!input.current) input.current = build();
  const inp = input.current;

  const run = async (kind: Kind) => {
    if (busy) return;
    setError(null);
    setReady(null);
    setBusy({ kind, frac: 0, label: "Готовлю…" });
    try {
      const fresh = build(); // the data may have changed while the sheet was open
      const progress = (frac: number, label: string) => setBusy({ kind, frac, label });
      let blob: Blob;
      let name: string;
      if (kind === "png") {
        blob = await exportPng(fresh, progress);
        name = fileName(fresh.title, "png", fresh.pages.length > 1 ? fresh.curPage : undefined);
      } else if (kind === "pdf") {
        blob = await exportPdf(fresh, progress);
        name = fileName(fresh.title, "pdf");
      } else {
        progress(0.5, "Собираю данные…");
        blob = exportJson(fresh);
        name = fileName(fresh.title, "json");
      }
      setBusy(null);
      if (canShareFiles(blob, name)) {
        // the share sheet needs a fresh tap: rendering may have taken longer than the browser allows
        setReady({ blob, name, share: true });
      } else {
        downloadFile(blob, name);
        setReady({ blob, name, share: false });
        notify("Файл сохранён");
      }
    } catch (e) {
      console.error(e);
      setBusy(null);
      setError("Не удалось создать файл. Попробуйте ещё раз или выберите другой формат");
    }
  };

  return (
    <Sheet title="Экспорт доски" onClose={busy ? () => undefined : onClose}>
      <div className="exp-list">
        <button className="exp-row" disabled={!!busy} onClick={() => void run("png")}>
          <strong>Картинка (PNG)</strong>
          <span>Текущая страница{inp.pages.length > 1 ? `: ${inp.pages.find((p) => p.page === inp.curPage)?.name || inp.curPage}` : ""}</span>
        </button>
        <button className="exp-row" disabled={!!busy} onClick={() => void run("pdf")}>
          <strong>PDF</strong>
          <span>{inp.pages.length > 1 ? `Все страницы (${inp.pages.length}), по странице на лист` : "Доска на одном листе"}</span>
        </button>
        <button className="exp-row" disabled={!!busy} onClick={() => void run("json")}>
          <strong>Данные (JSON)</strong>
          <span>Резервная копия: стикеры, нити, рисунок. Заблокированные стикеры — без текста</span>
        </button>
      </div>
      {busy && (
        <div className="exp-progress" role="status" aria-live="polite">
          <div className="exp-bar"><i style={{ width: `${Math.round(busy.frac * 100)}%` }} /></div>
          <span>{busy.label} {Math.round(busy.frac * 100)}%</span>
        </div>
      )}
      {error && <div className="fr-error" role="alert">{error}</div>}
      {ready && (
        <div className="exp-done" role="status">
          <span>{ready.share ? "Файл готов" : "Файл сохранён на устройство"}</span>
          <div className="fr-actions">
            {ready.share && (
              <button
                className="fr-btn primary"
                onClick={async () => {
                  const r = await shareFile(ready.blob, ready.name);
                  if (r === "failed") {
                    downloadFile(ready.blob, ready.name);
                    notify("Файл сохранён");
                  } else if (r === "shared") onClose();
                }}
              >
                Поделиться
              </button>
            )}
            <button className="fr-btn" onClick={() => (downloadFile(ready.blob, ready.name), notify("Файл сохранён"))}>Скачать</button>
            <button className="fr-btn" onClick={onClose}>Закрыть</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
