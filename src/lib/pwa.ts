/*
 * PWA: service worker registration and the "Install app" button.
 * `beforeinstallprompt` can fire before React is mounted, so the listener is added when this module loads.
 */
import { useSyncExternalStore } from "react";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = typeof window !== "undefined" && isStandalone();
const subs = new Set<() => void>();
let snap = { installed, canPrompt: false };
function emit() {
  const next = { installed, canPrompt: !!deferred };
  if (next.installed !== snap.installed || next.canPrompt !== snap.canPrompt) {
    snap = next;
    subs.forEach((f) => f());
  }
}

function isStandalone(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}

export function useInstall() {
  const s = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => snap,
    () => snap
  );
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const install = async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    if (!deferred) return "unavailable";
    const ev = deferred;
    deferred = null;
    emit();
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    return outcome;
  };
  return { installed: s.installed, canPrompt: s.canPrompt, ios, install };
}

/** Registers the service worker (production builds only; the file is generated at build time). */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((e) => console.error("Стикеры: service worker не зарегистрирован", e));
  });
}
