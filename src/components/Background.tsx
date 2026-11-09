import { useRef, useState } from "react";
import { Sheet, Spinner } from "./Friends";
import {
  BG_BLUR_MAX,
  BG_COLORS,
  BG_DIM_MAX,
  BG_GRADIENTS,
  BG_PATTERNS,
  bgCss,
  type BackgroundApi,
  type BgSettings,
  type Preset,
} from "../lib/background";

/** The personal background: sits under the board, never receives clicks. */
export function BoardBackground({ bg, photoUrl, radiusless = true }: { bg: BgSettings; photoUrl: string | null; radiusless?: boolean }) {
  const css = bgCss(bg, photoUrl);
  if (!css) return null;
  return (
    <div className="board-bg" aria-hidden="true" data-radiusless={radiusless}>
      <div className="board-bg-paint" style={{ background: css, filter: bg.blur ? `blur(${bg.blur}px)` : undefined, transform: bg.blur ? `scale(${1 + Math.min(0.2, bg.blur / 100)})` : undefined }} />
      {bg.dim > 0 && <div className="board-bg-dim" style={{ opacity: bg.dim / 100 }} />}
    </div>
  );
}

type Tab = "colors" | "gradients" | "patterns" | "photo";
const TABS: [Tab, string][] = [
  ["colors", "Цвета"],
  ["gradients", "Градиенты"],
  ["patterns", "Узоры"],
  ["photo", "Фото"],
];

export function BackgroundIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M3 16l5-5 4 4 3-3 6 6" />
      <circle cx="9" cy="8.5" r="1.4" />
    </svg>
  );
}

interface Props {
  api: BackgroundApi;
  onClose: () => void;
  notify: (text: string, kind?: "error" | "success") => void;
}

export function BackgroundDialog({ api, onClose, notify }: Props) {
  const { bg } = api;
  const [tab, setTab] = useState<Tab>(bg.kind === "gradient" ? "gradients" : bg.kind === "pattern" ? "patterns" : bg.kind === "photo" ? "photo" : "colors");
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const grid = (list: Preset[], kind: "color" | "gradient" | "pattern") => (
    <div className="bg-grid" role="listbox" aria-label="Варианты фона">
      {list.map((p) => {
        const on = bg.kind === kind && bg.id === p.id;
        return (
          <button
            key={p.id}
            type="button"
            role="option"
            aria-selected={on}
            className={`bg-swatch ${on ? "on" : ""}`}
            style={{ background: p.css }}
            title={p.name}
            aria-label={p.name}
            onClick={() => api.setPreset(kind, p.id)}
          >
            {on && <span className="bg-check" aria-hidden="true">✓</span>}
          </button>
        );
      })}
    </div>
  );

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    const err = await api.upload(file);
    if (err) setFileError(err);
    else notify("Фон загружен", "success");
  };

  return (
    <Sheet title="Фон доски" onClose={onClose}>
      <div className="fr-panel bg-panel">
        <div className="bg-preview" aria-hidden="true">
          <BoardBackground bg={bg} photoUrl={api.photoUrl} />
          {bg.kind === "none" && <span className="bg-preview-empty">Стандартный фон</span>}
        </div>

        <div className="fr-tabs bg-tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`fr-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        {tab === "colors" && grid(BG_COLORS, "color")}
        {tab === "gradients" && grid(BG_GRADIENTS, "gradient")}
        {tab === "patterns" && grid(BG_PATTERNS, "pattern")}
        {tab === "photo" && (
          <div className="bg-upload">
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
            <button className="fr-btn primary fr-wide" onClick={() => fileRef.current?.click()} disabled={api.uploading}>
              {api.uploading ? <Spinner /> : <BackgroundIcon />} Загрузить своё фото
            </button>
            <p className="fr-hint">JPG, PNG или WebP до 8 МБ. Фото сожмётся до 1920 px по длинной стороне. Видите его только вы.</p>
            {bg.kind === "photo" && <p className="fr-hint">Сейчас стоит ваше фото.</p>}
            {fileError && <div className="fr-error" role="alert">{fileError}</div>}
          </div>
        )}

        <div className="bg-sliders">
          <label className="bg-slider">
            <span>Затемнение <b>{bg.dim}%</b></span>
            <input type="range" min={0} max={BG_DIM_MAX} step={1} value={bg.dim} onChange={(e) => api.setSliders({ dim: Number(e.target.value) })} disabled={bg.kind === "none"} aria-label="Затемнение" />
          </label>
          <label className="bg-slider">
            <span>Размытие <b>{bg.blur} px</b></span>
            <input type="range" min={0} max={BG_BLUR_MAX} step={1} value={bg.blur} onChange={(e) => api.setSliders({ blur: Number(e.target.value) })} disabled={bg.kind === "none"} aria-label="Размытие" />
          </label>
        </div>

        {api.error && <div className="fr-error" role="alert">{api.error}</div>}

        <div className="bg-actions">
          <button className="fr-btn danger" onClick={api.reset} disabled={bg.kind === "none" && bg.dim === 0 && bg.blur === 0}>Сбросить</button>
          <button className="fr-btn primary" onClick={onClose}>Готово</button>
        </div>
      </div>
    </Sheet>
  );
}
