/*
 * Local-first operations: every change is applied to the local database at once (the screen updates
 * instantly, no network needed) and put into the outbox; sync.ts sends it to Supabase when it can.
 */
import { local, type NoteRow, type ConnRow, type PageLocal } from "./localdb";
import { isLocalUrl, LOCAL_URL } from "./sync";
import type { Stroke } from "./drawings";

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
}

const now = () => new Date().toISOString();

// ---------- notes (stickers and photo objects) ----------
export function noteCreate(row: Omit<NoteRow, "id" | "created_at" | "updated_at" | "user_id"> & Partial<NoteRow>): NoteRow {
  const t = now();
  const full = { ...row, id: row.id ?? uid(), created_at: row.created_at ?? t, updated_at: t, user_id: local.userId } as NoteRow;
  local.notes.put(full);
  local.enqueue("notes", "insert", full.id, { ...full } as unknown as Record<string, unknown>);
  return full;
}

export function notePatch(id: string, patch: Partial<NoteRow>) {
  const row = local.notes.get(id);
  if (!row) return;
  local.notes.put({ ...row, ...patch, updated_at: now() });
  local.enqueue("notes", "update", id, patch as Record<string, unknown>);
}

/** Position while dragging: only in memory (many events per second). */
export function noteMoveLive(id: string, x: number, y: number) {
  const row = local.notes.get(id);
  if (row) local.notes.put({ ...row, pos_x: x, pos_y: y }, false);
}

/** Fixes the final position: saved to the local database and queued. */
export function noteMoveDone(id: string) {
  const row = local.notes.get(id);
  if (!row) return;
  local.notes.put({ ...row, updated_at: now() });
  local.enqueue("notes", "update", id, { pos_x: row.pos_x, pos_y: row.pos_y });
}

export function noteDelete(id: string, publicUrlOf?: (path: string) => string) {
  const row = local.notes.get(id);
  if (!row) return;
  const files: string[] = [];
  const localFiles: string[] = [];
  const take = (u: string | null | undefined) => {
    if (!u) return;
    (isLocalUrl(u) ? localFiles : files).push(u);
  };
  take(row.image_url);
  row.photos?.forEach((p) => take(p.url));
  if (row.image_path && publicUrlOf) take(publicUrlOf(row.image_path));
  for (const u of localFiles) {
    local.removeOpsFor("upload", u);
    local.removeBlob(u);
  }
  // threads of this object disappear with it (the server does the same)
  for (const c of local.connections.all()) {
    if (c.a_id === id || c.b_id === id) {
      local.removeOpsFor("connections", c.id);
      local.connections.del(c.id);
    }
  }
  local.notes.del(id);
  local.enqueue("notes", "delete", id, { files });
}

// ---------- threads ----------
export function connCreate(base: { a_id: string; b_id: string; board: "private" | "shared"; board_id: string | null; page: number }): ConnRow {
  const row: ConnRow = {
    id: uid(),
    user_id: local.userId as string,
    color: "#d62828",
    dashed: false,
    label: "",
    created_at: now(),
    updated_at: now(),
    ...base,
  };
  local.connections.put(row);
  local.enqueue("connections", "insert", row.id, { id: row.id, a_id: row.a_id, b_id: row.b_id });
  return row;
}

export function connPatch(id: string, patch: Partial<Pick<ConnRow, "color" | "dashed" | "label">>) {
  const row = local.connections.get(id);
  if (!row) return;
  local.connections.put({ ...row, ...patch, updated_at: now() });
  local.enqueue("connections", "update", id, patch as Record<string, unknown>);
}

export function connDelete(id: string) {
  if (!local.connections.get(id)) return;
  local.connections.del(id);
  local.enqueue("connections", "delete", id, undefined);
}

// ---------- pages ----------
export function pageInsert(scope: { user_id: string | null; board_id: string | null }, page: number, name: string): PageLocal {
  const row: PageLocal = { id: uid(), user_id: scope.user_id, board_id: scope.board_id, page, name };
  local.pages.put(row);
  local.enqueue("pages", "insert", row.id, { ...row });
  return row;
}
export function pageRename(id: string, name: string) {
  const row = local.pages.get(id);
  if (!row) return;
  local.pages.put({ ...row, name });
  local.enqueue("pages", "update", id, { name });
}
export function pageDelete(id: string) {
  if (!local.pages.get(id)) return;
  local.pages.del(id);
  local.enqueue("pages", "delete", id, undefined);
}

// ---------- drawings ----------
export const drawKey = (userId: string, page: number) => `${userId}|${page}`;
export function drawingSave(userId: string, page: number, strokes: Stroke[]): string {
  const t = now();
  local.drawings.put({ key: drawKey(userId, page), user_id: userId, page, strokes, updated_at: t });
  local.enqueue("drawings", "upsert", drawKey(userId, page), { page, strokes, updated_at: t }, t);
  return t;
}

// ---------- settings (profiles.settings) ----------
export function settingsGet(): Record<string, unknown> {
  return (local.getMeta<Record<string, unknown>>("settings") ?? {}) as Record<string, unknown>;
}
export function settingsPatch(patch: Record<string, unknown>) {
  local.setMeta("settings", { ...settingsGet(), ...patch });
  local.enqueue("settings", "set", "me", patch);
}

// ---------- photo files ----------
/** Keeps a compressed file on the device and queues its upload. Returns a local:// URL that works until it is uploaded. */
export function stageImage(blob: Blob, bucket: string, path: string): string {
  const url = `${LOCAL_URL}${bucket}/${path}`;
  void local.putBlob({ url, bucket, path, blob });
  local.enqueue("upload", "upload", url, undefined);
  return url;
}
