import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

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

/** Interface style: localStorage (instant, also before login) + profiles.settings.style (other devices). */
export function useUiStyle(userId: string) {
  const [style, setStyleState] = useState<UIStyle>(() => readStoredStyle());
  const ref = useRef(style);
  ref.current = style;
  const dirty = useRef(false);

  useEffect(() => {
    applyStyle(style, true);
  }, [style]);

  const pull = useCallback(async () => {
    if (dirty.current) return;
    const { data, error } = await supabase.rpc("get_my_settings");
    if (error || !data || typeof data !== "object") return;
    const remote = (data as { style?: unknown }).style;
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
      void supabase.rpc("update_my_settings", { p_patch: { style: ref.current } });
    }
  }, []);

  useEffect(() => {
    pull();
    const onFocus = () => pull();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [pull, userId]);

  const setStyle = useCallback(async (next: UIStyle) => {
    if (next === ref.current) return;
    try {
      localStorage.setItem(STYLE_KEY, next);
    } catch {
      /* storage may be unavailable */
    }
    setStyleState(next);
    ref.current = next;
    dirty.current = true;
    const { error } = await supabase.rpc("update_my_settings", { p_patch: { style: next } });
    if (error) console.error("Стикеры: не удалось сохранить стиль", error);
    dirty.current = false;
  }, []);

  return { style, setStyle };
}
