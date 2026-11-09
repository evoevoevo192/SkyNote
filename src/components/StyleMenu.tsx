import { useState } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "./Friends";
import type { UIStyle } from "../lib/style";

export function PaletteIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3a9 9 0 100 18c1.4 0 2-.9 2-1.8 0-.9-.6-1.3-.6-2.1 0-.9.7-1.6 1.7-1.6H17a4 4 0 004-4c0-4.4-4-8.5-9-8.5z" />
      <circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="7.2" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="7.6" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

const CARDS: { id: UIStyle; name: string; hint: string }[] = [
  { id: "modern", name: "Современный", hint: "Мягкие цвета и стекло" },
  { id: "original", name: "Оригинал", hint: "Плоская бумага на сером" },
  { id: "skeuo", name: "Скевоморфизм", hint: "Пробка, кожа, бумага (iOS 6)" },
];

interface Props {
  style: UIStyle;
  onChange: (s: UIStyle) => void;
}

/** "Стиль" button + a small picker (the shared Sheet: a dialog on desktop, a bottom sheet on phones). */
export function StyleButton({ style, onChange }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="theme-btn style-btn" onClick={() => setOpen(true)} title="Стиль оформления" aria-label="Стиль" aria-haspopup="dialog">
        <PaletteIcon />
      </button>
      {open &&
        createPortal(
        <Sheet title="Стиль оформления" onClose={() => setOpen(false)}>
          <div className="style-cards" role="radiogroup" aria-label="Стиль оформления">
            {CARDS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={style === c.id}
                className={`style-card${style === c.id ? " on" : ""}`}
                onClick={() => onChange(c.id)}
              >
                <span className="style-thumb" data-s={c.id} aria-hidden="true">
                  <span className="style-thumb-note" />
                </span>
                <span className="style-card-name">{c.name}</span>
                <span className="style-card-hint">{c.hint}</span>
                {style === c.id && <span className="style-check" aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>
        </Sheet>,
          document.body
        )}
    </>
  );
}
