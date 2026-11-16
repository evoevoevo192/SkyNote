/*
 * Reminders on stickers. Personal: kept in my profile settings (profiles.settings.reminders = { noteId: ISO time }),
 * so they sync like the other settings, work offline and are never seen by other members of a shared board.
 * They fire while the app is open (also minimised); a reminder that came due while it was closed is shown on the next open.
 */
import { useEffect, useMemo, useRef } from "react";
import { local, useTable } from "./localdb";
import { settingsGet, settingsPatch } from "./data";
import type { Note } from "./supabase";

export type Reminders = Record<string, string>;
export const MAX_REMINDERS = 40; // update_my_settings accepts 4 KB per change

export function useReminders(): Reminders {
  const meta = useTable(local.meta);
  return useMemo(() => {
    const s = meta.find((m) => m.key === "settings")?.value as { reminders?: Reminders } | undefined;
    return s?.reminders && typeof s.reminders === "object" ? s.reminders : {};
  }, [meta]);
}

const current = (): Reminders => ({ ...((settingsGet().reminders as Reminders | undefined) ?? {}) });

/** Sets (iso) or removes (null) a reminder. false = too many reminders. */
export function setReminder(noteId: string, iso: string | null): boolean {
  const cur = current();
  if (iso) {
    if (!(noteId in cur) && Object.keys(cur).length >= MAX_REMINDERS) return false;
    cur[noteId] = iso;
  } else if (noteId in cur) delete cur[noteId];
  else return true;
  settingsPatch({ reminders: cur });
  return true;
}

function dropMany(ids: string[]) {
  const cur = current();
  let changed = false;
  for (const id of ids) if (id in cur) (delete cur[id], (changed = true));
  if (changed) settingsPatch({ reminders: cur });
}

// ---------- system notification ----------
export const canNotify = () => typeof Notification !== "undefined";
export async function askPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!canNotify()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

async function showSystem(title: string, body: string, tag: string) {
  if (!canNotify() || Notification.permission !== "granted") return;
  const icon = `${import.meta.env.BASE_URL}icons/icon-192.png`;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return void (await reg.showNotification(title, { body, tag, icon }));
  } catch {
    /* fall back below */
  }
  try {
    new Notification(title, { body, tag, icon });
  } catch {
    /* nothing more to do */
  }
}

const FIRED = "sticky-reminder-fired:";
const fmt = (iso: string) => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Looks for due reminders now, when the tab comes back, and every 15 seconds. */
export function useReminderRunner(notes: Note[], ready: boolean, notify: (text: string) => void) {
  const reminders = useReminders();
  const st = useRef({ notes, reminders, ready, notify });
  st.current = { notes, reminders, ready, notify };

  useEffect(() => {
    const check = () => {
      const { notes, reminders, ready, notify } = st.current;
      if (!ready) return;
      const now = Date.now();
      const gone: string[] = [];
      for (const [id, iso] of Object.entries(reminders)) {
        const t = Date.parse(iso);
        if (Number.isNaN(t)) {
          gone.push(id);
          continue;
        }
        if (t > now) continue;
        const note = notes.find((n) => n.id === id);
        gone.push(id);
        if (!note) continue; // the sticker is gone (or lives on another board): nothing to remind about
        // two tabs: only the one that marks it first shows it
        const key = `${FIRED}${id}:${iso}`;
        try {
          if (localStorage.getItem(key)) continue;
          localStorage.setItem(key, "1");
        } catch {
          /* private mode: may show twice, acceptable */
        }
        const name = note.locked ? "Заблокированный стикер" : note.title.trim() || "Стикер";
        const late = now - t > 2 * 60_000;
        const body = late ? `Пропущено напоминание (${fmt(iso)})` : "Напоминание";
        notify(`${late ? "Пропущено: " : "Напоминание: "}${name}`);
        void showSystem(name, body, key);
      }
      if (gone.length) dropMany(gone);
    };
    check();
    const iv = setInterval(check, 15_000);
    const on = () => document.visibilityState !== "hidden" && check();
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", on);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
    };
  }, []);

  // a changed list is checked at once (a reminder "in a minute" or one set in the past)
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("focus")), 50);
    return () => clearTimeout(t);
  }, [reminders, ready]);
}
