/*
 * Sticker lock by a numeric code. The real content of a locked sticker lives on the server (table note_locks)
 * and is returned only by unlock_note after the code is checked there. Here we keep it in memory only while
 * the editor is open: nothing of it is written to IndexedDB, to the outbox or to the service-worker cache.
 */
import { useSyncExternalStore } from "react";
import { supabase, type NotePhoto } from "./supabase";
import { local } from "./localdb";
import { sync, isOnline, pullNow } from "./sync";

export interface LockedContent {
  title: string;
  body: string;
  photos: NotePhoto[];
  image_path: string | null;
}

export type LockResult =
  | { ok: true }
  | { ok: false; reason: "bad_code"; left: number }
  | { ok: false; reason: "wait"; seconds: number }
  | { ok: false; reason: "offline" | "pending" | "format" | "error" };

export const CODE_RE = /^[0-9]{4,6}$/;

// ---------- content opened in this session (memory only) ----------
interface Session {
  code: string;
  content: LockedContent;
}
const sessions = new Map<string, Session>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  listeners.forEach((l) => l());
};
export function useLockSessions(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version
  );
}
export const openedContent = (id: string): LockedContent | null => sessions.get(id)?.content ?? null;
export const isOpened = (id: string) => sessions.has(id);
/** Closes the sticker again: the content is forgotten. */
export function relock(id: string) {
  if (sessions.delete(id)) bump();
}
export function relockAll() {
  if (sessions.size) {
    sessions.clear();
    bump();
  }
}

// ---------- the pause after wrong codes (also kept on the server; here only to show the countdown) ----------
const waits = new Map<string, number>();
export const waitLeft = (id: string) => Math.max(0, Math.ceil(((waits.get(id) ?? 0) - Date.now()) / 1000));

type Rpc = { data: unknown; error: { message?: string } | null };
function parse(r: Rpc, id: string): { res: Record<string, unknown> | null } {
  if (r.error || !r.data || typeof r.data !== "object") return { res: null };
  const res = r.data as Record<string, unknown>;
  if (res.ok === false && res.reason === "wait") waits.set(id, Date.now() + Number(res.seconds ?? 30) * 1000);
  return { res };
}
function toResult(res: Record<string, unknown> | null): LockResult {
  if (!res) return { ok: false, reason: "error" };
  if (res.ok === true) return { ok: true };
  if (res.reason === "bad_code") return { ok: false, reason: "bad_code", left: Number(res.left ?? 0) };
  if (res.reason === "wait") return { ok: false, reason: "wait", seconds: Number(res.seconds ?? 30) };
  return { ok: false, reason: "error" };
}

function closeLocal(id: string, locked: boolean, content?: LockedContent) {
  const row = local.notes.get(id);
  if (!row) return;
  // without enqueue: the server already knows
  if (locked) local.notes.put({ ...row, locked: true, title: "", body: "", photos: [], image_path: null });
  else local.notes.put({ ...row, locked: false, ...(content ?? {}) });
}

/** Unsent edits of this sticker must reach the server before the content moves into the lock. */
async function settle(id: string): Promise<boolean> {
  if (!local.opsFor("notes", id).length) return true;
  sync.kick();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!local.opsFor("notes", id).length) return true;
  }
  return false;
}

export async function lockNote(id: string, code: string): Promise<LockResult> {
  if (!CODE_RE.test(code)) return { ok: false, reason: "format" };
  if (!isOnline()) return { ok: false, reason: "offline" };
  if (!(await settle(id))) return { ok: false, reason: "pending" };
  const row = local.notes.get(id);
  const content: LockedContent = {
    title: row?.title ?? "",
    body: row?.body ?? "",
    photos: row?.photos ?? [],
    image_path: row?.image_path ?? null,
  };
  // the session first: the server's update may reach us (realtime) before the answer, and the editor must not
  // see "locked, but not opened" in between
  const session: Session = { code, content };
  sessions.set(id, session);
  const { error } = await supabase.rpc("lock_note", { p_id: id, p_code: code });
  if (error) {
    if (sessions.get(id) === session) sessions.delete(id);
    return { ok: false, reason: "error" };
  }
  closeLocal(id, true);
  bump();
  return { ok: true };
}

export async function openNote(id: string, code: string): Promise<LockResult> {
  if (!isOnline()) return { ok: false, reason: "offline" };
  if (!CODE_RE.test(code)) return { ok: false, reason: "bad_code", left: 5 };
  const r = (await supabase.rpc("unlock_note", { p_id: id, p_code: code })) as Rpc;
  const { res } = parse(r, id);
  if (res?.ok === true) {
    waits.delete(id);
    sessions.set(id, {
      code,
      content: {
        title: String(res.title ?? ""),
        body: String(res.body ?? ""),
        photos: Array.isArray(res.photos) ? (res.photos as NotePhoto[]) : [],
        image_path: (res.image_path as string | null) ?? null,
      },
    });
    bump();
  }
  return toResult(res);
}

/** Saves edits of an opened sticker (author). The text goes to the server only, never into the local database. */
export async function saveOpened(id: string, patch: Partial<LockedContent>): Promise<LockResult> {
  const s = sessions.get(id);
  if (!s) return { ok: false, reason: "error" };
  if (!isOnline()) return { ok: false, reason: "offline" };
  const next = { ...s.content, ...patch };
  const r = (await supabase.rpc("save_locked_note", { p_id: id, p_code: s.code, p_patch: patch })) as Rpc;
  const { res } = parse(r, id);
  const out = toResult(res);
  if (out.ok && sessions.get(id) === s) {
    sessions.set(id, { ...s, content: next });
    bump();
  }
  return out;
}

export async function changeCode(id: string, oldCode: string, newCode: string): Promise<LockResult> {
  if (!CODE_RE.test(newCode)) return { ok: false, reason: "format" };
  if (!isOnline()) return { ok: false, reason: "offline" };
  const r = (await supabase.rpc("change_note_lock", { p_id: id, p_old: oldCode, p_new: newCode })) as Rpc;
  const { res } = parse(r, id);
  const out = toResult(res);
  const s = sessions.get(id);
  if (out.ok && s) sessions.set(id, { ...s, code: newCode });
  return out;
}

export async function removeLock(id: string, code: string): Promise<LockResult> {
  if (!isOnline()) return { ok: false, reason: "offline" };
  const r = (await supabase.rpc("remove_note_lock", { p_id: id, p_code: code })) as Rpc;
  const { res } = parse(r, id);
  const out = toResult(res);
  if (out.ok) {
    const s = sessions.get(id);
    const row = local.notes.get(id);
    // the content comes back to the notes row, so the local copy may keep it again
    closeLocal(id, false, s?.content);
    if (!s && row) void pullNow();
    relock(id);
  }
  return out;
}

/** Text for a failed result. */
export function lockMessage(r: LockResult): string {
  if (r.ok) return "";
  switch (r.reason) {
    case "bad_code":
      return r.left > 0 ? `Неверный код. Осталось попыток: ${r.left}` : "Неверный код";
    case "wait":
      return `Слишком много попыток. Подождите ${r.seconds} с`;
    case "offline":
      return "Нужна сеть: код проверяется на сервере";
    case "pending":
      return "Есть неотправленные изменения. Подождите, пока они синхронизируются";
    case "format":
      return "Код — от 4 до 6 цифр";
    default:
      return "Не получилось. Попробуйте ещё раз";
  }
}
