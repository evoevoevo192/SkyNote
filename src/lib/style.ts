import { useCallback, useEffect, useRef, useState } from "react";
import { local, useTable, usePendingOps } from "./localdb";
import { settingsPatch } from "./data";

export type UIStyle = "modern" | "original" | "skeuo";
export const UI_STYLES: UIStyle[] = ["modern", "original", "skeuo"];
export const DEFAULT_STYLE: UIStyle = "modern";
export const STYLE_KEY = "sticky-style";
export const STYLE_FADE_MS = 250;

export function isStyle(v: unknown): v is UIStyle {
  return v === "modern" || v === "original" || v === "skeuo";
}

export function readStoredStyle(): UIStyle {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    return isStyle(v) ? v : DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}

let fadeTimer: number | null = null;

/** Sets data-style on <html>; `animate` adds a short class that fades colours / radii / shadows (250 ms). */
export function applyStyle(style: UIStyle, animate: boolean) {
  const root = document.documentElement;
  if (root.getAttribute("data-style") === style) return;
  if (animate) {
    root.classList.add("style-fade");
    if (fadeTimer) window.clearTimeout(fadeTimer);
    fadeTimer = window.setTimeout(() => root.classList.remove("style-fade"), STYLE_FADE_MS + 60);
  }
  root.setAttribute("data-style", style);
}

/** Interface style: localStorage (instant, also before login) + profiles.settings.style (other devices) via the sync queue. */
export function useUiStyle(userId: string) {
  const [style, setStyleState] = useState<UIStyle>(() => readStoredStyle());
  const ref = useRef(style);
  ref.current = style;
  const meta = useTable(local.meta);
  const ops = usePendingOps();

  useEffect(() => {
    applyStyle(style, true);
  }, [style]);

  // what the account says (written by the synchronisation) -> this device
  useEffect(() => {
    if (ops.some((o) => o.table === "settings")) return; // my change is on its way
    const settings = meta.find((m) => m.key === "settings")?.value as { style?: unknown } | undefined;
    const synced = meta.some((m) => m.key === "lastSync");
    if (!settings || !synced) return;
    const remote = settings.style;
    if (isStyle(remote)) {
      if (remote !== ref.current) {
        try {
          localStorage.setItem(STYLE_KEY, remote);
        } catch {
          /* storage may be unavailable */
        }
        setStyleState(remote);
      }
    } else if (ref.current !== DEFAULT_STYLE) {
      settingsPatch({ style: ref.current });
    }
  }, [meta, ops, userId]);

  const setStyle = useCallback(async (next: UIStyle) => {
    if (next === ref.current) return;
    try {
      localStorage.setItem(STYLE_KEY, next);
    } catch {
      /* storage may be unavailable */
    }
    setStyleState(next);
    ref.current = next;
    settingsPatch({ style: next });
  }, []);

  return { style, setStyle };
}
