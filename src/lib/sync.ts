/*
 * Synchronisation between the local database (localdb.ts) and Supabase.
 *
 *  push  — the outbox (create / edit / delete) is sent in order; network errors keep the change and retry
 *          with a growing pause; a refusal by the server (rights, rules) drops the change and restores
 *          the server's version.
 *  pull  — first open, window focus, going online and once a minute: changes since the last cursor.
 *  live  — Realtime events are written straight into the local database.
 *  conflicts — the version with the later updated_at wins. My own changes that are still waiting in the
 *          queue are compared with the incoming server row by time; echoes of my own saves are recognised.
 *
 * Only one tab (the one holding the Web Lock) talks to the server; the other tabs see the same data
 * through the local database.
 */
import { useSyncExternalStore } from "react";
import { supabase, PHOTOS_BUCKET, IMAGES_BUCKET } from "./supabase";
import type { BoardInfo, BoardMember, Profile } from "./supabase";
import { local, usePendingOps, type OutOp, type NoteRow, type ConnRow, type PageLocal, type DrawingRow } from "./localdb";

// ---------- status ----------
export interface SyncState {
  online: boolean;
  syncing: boolean;
  lastError: string | null;
}
let state: SyncState = { online: typeof navigator === "undefined" ? true : navigator.onLine, syncing: false, lastError: null };
const stateSubs = new Set<() => void>();
function setState(p: Partial<SyncState>) {
  const n = { ...state, ...p };
  if (n.online === state.online && n.syncing === state.syncing && n.lastError === state.lastError) return;
  state = n;
  stateSubs.forEach((f) => f());
}
const subState = (f: () => void) => {
  stateSubs.add(f);
  return () => void stateSubs.delete(f);
};
export function useSyncState(): SyncState {
  return useSyncExternalStore(subState, () => state, () => state);
}
export function useOnline(): boolean {
  return useSyncExternalStore(subState, () => state.online, () => true);
}
export function isOnline(): boolean {
  return state.online;
}
/** Number of changes waiting to be sent (photo files are counted only when nothing else waits). */
export function usePendingCount(): number {
  const ops = usePendingOps();
  const changes = ops.filter((o) => o.table !== "upload").length;
  return changes || ops.length;
}

// ---------- notifications to the UI ----------
type Listener = (text: string) => void;
const dropListeners = new Set<Listener>();
export function onSyncDropped(fn: Listener) {
  dropListeners.add(fn);
  return () => void dropListeners.delete(fn);
}
function tell(text: string) {
  dropListeners.forEach((f) => f(text));
}

// ---------- helpers ----------
interface PgErr {
  message?: string;
  code?: string;
  status?: number;
  statusCode?: string | number;
}
const errText = (e: unknown) => String((e as PgErr | null)?.message ?? e ?? "");
function isNetErr(e: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const m = errText(e);
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet|timed? ?out|abort/i.test(m);
}
function isServerErr(e: unknown, status?: number): boolean {
  const s = status ?? (e as PgErr | null)?.status ?? Number((e as PgErr | null)?.statusCode);
  return typeof s === "number" && s >= 500;
}
const pick = (src: Record<string, unknown>, cols: readonly string[]) => {
  const out: Record<string, unknown> = {};
  for (const c of cols) if (c in src && src[c] !== undefined) out[c] = src[c];
  return out;
};

const NOTE_INSERT = ["id", "created_at", "title", "body", "color", "pos_x", "pos_y", "board", "board_id", "font", "image_path", "image_fit", "image_height", "image_align", "photos", "type", "image_url", "width", "aspect", "caption", "edit_mode", "page"] as const;
const NOTE_UPDATE = ["title", "body", "color", "pos_x", "pos_y", "font", "image_path", "image_fit", "image_height", "image_align", "photos", "image_url", "width", "aspect", "caption", "edit_mode", "page"] as const;
const CONN_INSERT = ["id", "a_id", "b_id", "color", "dashed", "label"] as const;
const CONN_UPDATE = ["color", "dashed", "label"] as const;
const PAGE_INSERT = ["id", "user_id", "board_id", "page", "name"] as const;

export const LOCAL_URL = "local://";
export const isLocalUrl = (u: unknown): u is string => typeof u === "string" && u.startsWith(LOCAL_URL);

/** The ids of rows that must not be overwritten by the server right now (a card being dragged). */
export const holdIds = new Set<string>();
/** What is being sent at this moment (to recognise the echo of my own save). */
const inflight = new Map<string, Record<string, unknown>>();

const sameVal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isEcho = (row: Record<string, unknown>, data: Record<string, unknown> | undefined) => !!data && Object.keys(data).length > 0 && Object.keys(data).every((k) => sameVal(row[k], data[k]));
const later = (a: string | undefined, b: string | undefined) => (a ?? "") >= (b ?? "");

// ---------- merging a server row into the local database ----------
type Tbl = "notes" | "connections";

function applyRemoteRow(table: Tbl, raw: Record<string, unknown>) {
  const t = local[table] as unknown as { get(k: string): (NoteRow | ConnRow) | undefined; put(r: NoteRow | ConnRow, p?: boolean): void; del(k: string, p?: boolean): void };
  const id = String(raw.id);
  if (holdIds.has(id)) return;
  if (table === "notes" && raw.board === "public") return;
  const ops = local.opsFor(table, id);
  if (ops.some((o) => o.kind === "delete")) return; // I deleted it, the delete is on its way
  const existing = t.get(id);
  const updated = String(raw.updated_at ?? "");
  if (existing?._srv && updated && updated <= existing._srv) return; // an older (or the same) version

  if (raw.deleted_at) {
    ops.forEach((o) => local.removeOp(o));
    if (existing) t.del(id);
    if (table === "notes") dropConnectionsOf(id);
    return;
  }
  const inf = inflight.get(`${table}|${id}`);
  if (inf && isEcho(raw, inf)) {
    if (existing) t.put({ ...existing, _srv: updated } as NoteRow & ConnRow);
    return;
  }
  const row = { ...raw, _srv: updated } as unknown as NoteRow & ConnRow;
  if (ops.length) {
    // I have changes that were not sent yet: the later version wins
    const mine = ops.filter((o) => o.kind === "insert" || o.kind === "update");
    const newest = mine.reduce((m, o) => (o.ts > m ? o.ts : m), "");
    if (mine.length && later(newest, updated)) {
      const merged = { ...row } as Record<string, unknown>;
      for (const o of mine) Object.assign(merged, o.data ?? {});
      t.put(merged as unknown as NoteRow & ConnRow);
      return;
    }
    ops.forEach((o) => local.removeOp(o)); // the server version is newer: my waiting change loses
  }
  t.put(row);
}

function dropConnectionsOf(noteId: string) {
  for (const c of local.connections.all()) {
    if (c.a_id === noteId || c.b_id === noteId) {
      local.removeOpsFor("connections", c.id);
      local.connections.del(c.id);
    }
  }
}

function removeLocal(table: Tbl, id: string) {
  local.removeOpsFor(table, id);
  if (table === "notes") {
    local.notes.del(id);
    dropConnectionsOf(id);
  } else local.connections.del(id);
}

function setSrv(table: Tbl, id: string, updated: string | undefined) {
  if (!updated) return;
  const t = local[table] as unknown as { get(k: string): (NoteRow | ConnRow) | undefined; put(r: NoteRow | ConnRow, p?: boolean): void };
  const r = t.get(id);
  if (r && (!r._srv || updated > r._srv)) t.put({ ...r, _srv: updated } as NoteRow & ConnRow);
}

// ---------- photo files ----------
/** After a file is uploaded: every place that pointed to the local copy now points to the real URL. */
function rewriteUrl(oldUrl: string, newUrl: string) {
  for (const n of local.notes.all()) {
    let changed = false;
    let next: NoteRow = n;
    if (n.image_url === oldUrl) {
      next = { ...next, image_url: newUrl };
      changed = true;
    }
    if (n.photos?.some((p) => p.url === oldUrl)) {
      next = { ...next, photos: n.photos.map((p) => (p.url === oldUrl ? { ...p, url: newUrl } : p)) };
      changed = true;
    }
    if (changed) local.notes.put(next);
  }
  for (const op of local.ops) {
    if (op.data && JSON.stringify(op.data).includes(oldUrl)) {
      op.data = JSON.parse(JSON.stringify(op.data).split(oldUrl).join(newUrl));
      local.touchOp(op);
    }
  }
  local.removeBlob(oldUrl);
}

function blobRefs(op: OutOp): string[] {
  if (op.table === "upload" || !op.data) return [];
  const s = JSON.stringify(op.data);
  if (!s.includes(LOCAL_URL)) return [];
  return Array.from(local.blobs.keys()).filter((u) => s.includes(u));
}

// ---------- pushing ----------
type Outcome = "ok" | "drop" | "net" | "retry";

interface Result {
  error: unknown;
  status?: number;
}
function classify(r: Result, opts: { okCodes?: string[]; okText?: RegExp } = {}): Outcome | null {
  if (!r.error) return "ok";
  const e = r.error as PgErr;
  if (opts.okCodes?.includes(String(e.code))) return "ok";
  if (opts.okText && opts.okText.test(errText(e))) return "ok";
  if (isNetErr(e)) return "net";
  if (isServerErr(e, r.status)) return "retry";
  return null; // a refusal
}

const REFUSAL_TEXT = (msg: string): string => {
  if (msg.includes("PAGE_NOT_EMPTY")) return "Страница не пустая: удаление не выполнено";
  if (msg.includes("DIFFERENT_PAGES")) return "Нить можно протянуть только между объектами одной страницы";
  if (msg.includes("DIFFERENT_BOARDS")) return "Нить можно протянуть только между объектами одной доски";
  if (/row-level security|NOT_ALLOWED|permission/i.test(msg)) return "Сервер не принял изменение: нет прав";
  return "Сервер не принял одно из изменений";
};

async function refetchRow(table: Tbl, id: string) {
  const { data, error } = await supabase.from(table).select("*").eq("id", id).maybeSingle();
  if (error) return;
  if (!data || (data as { deleted_at?: string | null }).deleted_at) {
    removeLocal(table, id);
    return;
  }
  const row = data as Record<string, unknown>;
  const t = local[table] as unknown as { put(r: NoteRow | ConnRow, p?: boolean): void };
  t.put({ ...row, _srv: String(row.updated_at ?? "") } as unknown as NoteRow & ConnRow);
}

async function pushOp(op: OutOp): Promise<Outcome> {
  const key = `${op.table}|${op.id}`;
  inflight.set(key, (op.data ?? {}) as Record<string, unknown>);
  try {
    return await pushOpInner(op);
  } finally {
    // the echo may arrive a moment after the answer
    window.setTimeout(() => {
      if (inflight.get(key) === op.data || !op.data) inflight.delete(key);
    }, 4000);
  }
}

async function pushOpInner(op: OutOp): Promise<Outcome> {
  const data = (op.data ?? {}) as Record<string, unknown>;
  const delayed = Date.now() - Date.parse(op.ts) > 60_000; // made offline: check for a newer server version
  const refuse = async (r: Result, after?: () => Promise<void> | void): Promise<Outcome> => {
    const c = classify(r);
    if (c) return c;
    console.error("Стикеры: сервер отклонил изменение", op.table, op.kind, r.error);
    tell(REFUSAL_TEXT(errText(r.error)));
    await after?.();
    return "drop";
  };

  switch (op.table) {
    case "notes": {
      if (op.kind === "insert") {
        const r = await supabase.from("notes").insert(pick(data, NOTE_INSERT));
        const c = classify(r, { okCodes: ["23505"] });
        if (c === "ok" || c === "net" || c === "retry") return c;
        return refuse(r, () => removeLocal("notes", op.id));
      }
      if (op.kind === "update") {
        const patch = pick(data, NOTE_UPDATE);
        if (!Object.keys(patch).length) return "ok";
        let q = supabase.from("notes").update(patch).eq("id", op.id);
        if (delayed) q = q.lte("updated_at", op.ts);
        const r = (await q.select("updated_at")) as Result & { data: { updated_at: string }[] | null };
        const c = classify(r);
        if (c === "ok") {
          if (!r.data?.length) {
            await refetchRow("notes", op.id); // newer on the server, or no access any more
            return "drop";
          }
          setSrv("notes", op.id, r.data[0].updated_at);
          return "ok";
        }
        if (c) return c;
        return refuse(r, () => refetchRow("notes", op.id));
      }
      if (op.kind === "delete") {
        const r = await supabase.rpc("soft_delete_note", { p_id: op.id });
        const c = classify(r);
        if (c === "ok") {
          const files = (data.files as string[] | undefined) ?? [];
          if (files.length) void removeFiles(files);
          return "ok";
        }
        if (c) return c;
        return refuse(r, () => refetchRow("notes", op.id));
      }
      return "drop";
    }
    case "connections": {
      if (op.kind === "insert") {
        const r = await supabase.from("connections").insert(pick(data, CONN_INSERT));
        const c = classify(r, { okCodes: ["23505"] });
        if (c === "ok" || c === "net" || c === "retry") {
          if (c === "ok" && r.error) await refetchPair(String(data.a_id), String(data.b_id), op.id);
          return c;
        }
        return refuse(r, () => removeLocal("connections", op.id));
      }
      if (op.kind === "update") {
        const patch = pick(data, CONN_UPDATE);
        if (!Object.keys(patch).length) return "ok";
        let q = supabase.from("connections").update(patch).eq("id", op.id);
        if (delayed) q = q.lte("updated_at", op.ts);
        const r = (await q.select("updated_at")) as Result & { data: { updated_at: string }[] | null };
        const c = classify(r);
        if (c === "ok") {
          if (!r.data?.length) {
            await refetchRow("connections", op.id);
            return "drop";
          }
          setSrv("connections", op.id, r.data[0].updated_at);
          return "ok";
        }
        if (c) return c;
        return refuse(r, () => refetchRow("connections", op.id));
      }
      if (op.kind === "delete") {
        const r = await supabase.rpc("soft_delete_connection", { p_id: op.id });
        const c = classify(r);
        if (c) return c;
        return refuse(r, () => refetchRow("connections", op.id));
      }
      return "drop";
    }
    case "pages": {
      if (op.kind === "insert") {
        const r = await supabase.from("board_pages").insert(pick(data, PAGE_INSERT));
        const c = classify(r, { okCodes: ["23505"] });
        if (c === "ok" && r.error) {
          // the page already exists on the server under another id: take the server's row
          local.pages.del(op.id);
          await pullPages();
        }
        if (c) return c;
        return refuse(r, () => {
          local.pages.del(op.id);
        });
      }
      if (op.kind === "update") {
        const r = await supabase.from("board_pages").update(pick(data, ["name"])).eq("id", op.id);
        const c = classify(r);
        if (c) return c;
        return refuse(r, () => pullPages());
      }
      if (op.kind === "delete") {
        const r = await supabase.from("board_pages").delete().eq("id", op.id);
        const c = classify(r);
        if (c) return c;
        return refuse(r, () => pullPages());
      }
      return "drop";
    }
    case "drawings": {
      const page = Number(data.page ?? 1);
      const r = await supabase
        .from("drawings")
        .upsert({ user_id: local.userId, page, strokes: data.strokes ?? [], updated_at: data.updated_at ?? op.ts }, { onConflict: "user_id,page" });
      const c = classify(r);
      if (c) return c;
      return refuse(r, () => pullDrawings());
    }
    case "settings": {
      const r = await supabase.rpc("update_my_settings", { p_patch: data });
      const c = classify(r);
      if (c) return c;
      return refuse(r);
    }
    case "upload": {
      const blob = local.blobs.get(op.id);
      if (!blob) return "ok"; // the file is gone (the object was deleted before it was sent)
      const r = await supabase.storage.from(blob.bucket).upload(blob.path, blob.blob, { contentType: "image/jpeg", upsert: false });
      const c = classify(r as Result, { okText: /already exists|duplicate/i });
      if (c === "ok") {
        const { data: pub } = supabase.storage.from(blob.bucket).getPublicUrl(blob.path);
        rewriteUrl(op.id, pub.publicUrl);
        return "ok";
      }
      if (c) return c;
      return refuse(r as Result, () => {
        local.removeBlob(op.id);
      });
    }
  }
  return "drop";
}

async function refetchPair(a: string, b: string, myId: string) {
  const { data } = await supabase.from("connections").select("*").eq("a_id", a).eq("b_id", b).is("deleted_at", null).maybeSingle();
  if (data && (data as ConnRow).id !== myId) {
    local.connections.del(myId);
    applyRemoteRow("connections", data as Record<string, unknown>);
  }
}

async function removeFiles(urls: string[]) {
  const by: Record<string, string[]> = {};
  for (const u of urls) {
    for (const bucket of [PHOTOS_BUCKET, IMAGES_BUCKET]) {
      const marker = `/${bucket}/`;
      const i = u.indexOf(marker);
      if (i !== -1) {
        (by[bucket] ||= []).push(decodeURIComponent(u.slice(i + marker.length).split("?")[0]));
        break;
      }
    }
  }
  for (const [bucket, paths] of Object.entries(by)) {
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) console.error("Не удалось удалить файлы фото", error);
  }
}

// ---------- the engine ----------
const GIVE_UP_REFUSALS = 6;

class Engine {
  private leader = false;
  private pushing = false;
  private pulling = false;
  private wantPush = false;
  private retryTimer: number | null = null;
  private pullTimer: number | null = null;
  private netFails = 0;
  private channel: ReturnType<typeof supabase.channel> | null = null;
  private cleanup: (() => void)[] = [];
  private lastPull = 0;
  private started: string | null = null;

  private startP: Promise<void> | null = null;
  start(userId: string): Promise<void> {
    if (this.started === userId && this.startP) return this.startP;
    this.stop();
    this.started = userId;
    this.startP = this.boot(userId);
    return this.startP;
  }

  private async boot(userId: string) {
    await local.init(userId);
    const lockName = `sticky-sync-${userId}`;
    const locks = (navigator as Navigator & { locks?: { request: (n: string, cb: () => Promise<void>) => Promise<void> } }).locks;
    if (locks) {
      void locks.request(lockName, () => {
        if (this.started !== userId) return Promise.resolve();
        this.becomeLeader();
        return new Promise<void>((resolve) => this.cleanup.push(resolve)); // held until the tab closes / stops
      });
    } else {
      this.becomeLeader();
    }
    // followers still show the right "offline" state
    const onNet = () => setState({ online: navigator.onLine });
    window.addEventListener("online", onNet);
    window.addEventListener("offline", onNet);
    this.cleanup.push(() => {
      window.removeEventListener("online", onNet);
      window.removeEventListener("offline", onNet);
    });
    this.cleanup.push(local.subscribeOps(() => this.kick()));
    local.onExternalOutbox = () => this.kick();
  }

  stop() {
    this.started = null;
    this.startP = null;
    this.leader = false;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    if (this.pullTimer) window.clearInterval(this.pullTimer);
    this.retryTimer = this.pullTimer = null;
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
    const c = this.cleanup;
    this.cleanup = [];
    c.forEach((f) => f());
    local.onExternalOutbox = null;
  }

  private becomeLeader() {
    this.leader = true;
    const onOnline = () => {
      this.netFails = 0;
      setState({ online: true });
      // first learn what changed on the server (the later version wins), then send my queue
      void this.pull(true).finally(() => this.kick());
    };
    const onOffline = () => setState({ online: false });
    const onFocus = () => {
      this.kick();
      void this.pull();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    this.cleanup.push(() => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    });
    this.pullTimer = window.setInterval(() => {
      this.kick();
      void this.pull();
    }, 60_000);
    this.subscribe();
    this.kick();
    void this.pull(true);
  }

  // ----- realtime -----
  private subscribe() {
    const uid = local.userId;
    if (!uid) return;
    let first = true;
    const refreshBoards = debounce(() => void pullBoards().then(() => pullProfiles()), 400);
    this.channel = supabase
      .channel(`sync-${uid}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "notes" }, (p) => this.onRow("notes", p))
      .on("postgres_changes", { event: "*", schema: "public", table: "connections" }, (p) => this.onRow("connections", p))
      .on("postgres_changes", { event: "*", schema: "public", table: "board_pages" }, (p) => {
        if (p.eventType === "DELETE") {
          const id = (p.old as { id?: string }).id;
          if (id && !local.opsFor("pages", id).length) local.pages.del(id);
        } else {
          const row = p.new as PageLocal;
          if (row && !local.opsFor("pages", row.id).length) local.pages.put(row);
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "boards" }, refreshBoards)
      .on("postgres_changes", { event: "*", schema: "public", table: "board_members" }, refreshBoards)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (!first) void this.pull(true); // reconnected: catch up
          first = false;
        }
      });
  }

  private onRow(table: Tbl, p: { eventType: string; new: unknown; old: unknown }) {
    if (p.eventType === "DELETE") {
      const id = (p.old as { id?: string }).id;
      if (id && !local.opsFor(table, id).some((o) => o.kind === "insert")) removeLocal(table, id);
      return;
    }
    const row = p.new as Record<string, unknown> | null;
    if (!row || !row.id) return;
    applyRemoteRow(table, row);
    if (table === "notes" && typeof row.user_id === "string" && !local.profiles.get(row.user_id)) void pullProfiles();
  }

  // ----- push -----
  kick() {
    if (!this.leader) return;
    this.wantPush = true;
    if (this.pushing) return;
    window.setTimeout(() => void this.push(), 80);
  }

  private async push() {
    if (this.pushing || !this.leader) return;
    this.pushing = true;
    this.wantPush = false;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    let netDown = false;
    let wait = 0;
    try {
      if (!local.ready) return;
      const blocked = new Set<string>();
      const ops = local.ops.slice();
      if (ops.length) setState({ syncing: true });
      for (const op of ops) {
        if (!local.ops.includes(op)) continue; // removed meanwhile
        const key = `${op.table}|${op.id}`;
        const refs = op.table === "connections" && op.kind === "insert" ? [`notes|${String(op.data?.a_id)}`, `notes|${String(op.data?.b_id)}`] : [];
        if (blocked.has(key) || refs.some((k) => blocked.has(k))) {
          blocked.add(key);
          continue;
        }
        if (op.nextAt > Date.now()) {
          blocked.add(key);
          wait = Math.max(wait, op.nextAt - Date.now());
          continue;
        }
        const pendingBlobs = blobRefs(op);
        if (pendingBlobs.length) {
          // waits for its photo file; if the upload no longer exists the change cannot be sent
          if (pendingBlobs.some((u) => !local.opsFor("upload", u).length)) {
            local.removeOp(op);
            continue;
          }
          blocked.add(key);
          continue;
        }
        let out: Outcome;
        try {
          out = await pushOp(op);
        } catch (e) {
          out = isNetErr(e) ? "net" : "retry";
          console.error("Стикеры: ошибка отправки", e);
        }
        if (out === "ok" || out === "drop") {
          local.removeOp(op);
          this.netFails = 0;
          setState({ online: navigator.onLine, lastError: null });
        } else if (out === "net") {
          netDown = true;
          setState({ online: false });
          break;
        } else {
          op.tries += 1;
          op.nextAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(op.tries, 6));
          if (op.tries >= GIVE_UP_REFUSALS * 3) {
            local.removeOp(op);
            tell("Одно из изменений не удалось отправить, оно отменено");
          } else {
            local.touchOp(op);
            wait = Math.max(wait, op.nextAt - Date.now());
          }
          blocked.add(key);
          setState({ lastError: "server" });
        }
      }
    } finally {
      this.pushing = false;
      setState({ syncing: false });
      if (netDown) {
        this.netFails += 1;
        this.retryTimer = window.setTimeout(() => void this.probe(), Math.min(30_000, 2000 * 2 ** Math.min(this.netFails, 4)));
      } else if (wait > 0) {
        this.retryTimer = window.setTimeout(() => this.kick(), wait + 50);
      } else if (this.wantPush) {
        this.kick();
      }
    }
  }

  /** While offline: a cheap request tells when the server is reachable again. */
  private async probe() {
    if (!this.leader) return;
    if (!navigator.onLine) {
      this.retryTimer = window.setTimeout(() => void this.probe(), 5000);
      return;
    }
    const { error } = await supabase.from("profiles").select("id").eq("id", local.userId as string).maybeSingle();
    if (error && isNetErr(error)) {
      this.netFails += 1;
      setState({ online: false });
      this.retryTimer = window.setTimeout(() => void this.probe(), Math.min(30_000, 2000 * 2 ** Math.min(this.netFails, 4)));
      return;
    }
    this.netFails = 0;
    setState({ online: true });
    void this.pull(true).finally(() => this.kick());
  }

  // ----- pull -----
  async pull(force = false) {
    if (!this.leader || this.pulling || !local.ready) return;
    if (!force && Date.now() - this.lastPull < 15_000) return;
    if (!navigator.onLine) return;
    this.pulling = true;
    try {
      await pullBoards();
      await Promise.all([pullNotes(), pullConnections(), pullPages(), pullDrawings(), pullSettings()]);
      await pullProfiles();
      this.lastPull = Date.now();
      setState({ online: true });
      local.setMeta("lastSync", new Date().toISOString());
    } catch (e) {
      if (isNetErr(e)) setState({ online: false });
      else console.error("Стикеры: не удалось обновить данные", e);
    } finally {
      this.pulling = false;
    }
  }
}

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: number | null = null;
  return (...a: A) => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

function check<T extends { error: unknown }>(r: T): T {
  if (r.error) throw r.error;
  return r;
}

const PAGE_SIZE = 500;

async function pullTable(table: Tbl) {
  const curKey = `cursor:${table}`;
  const cursor = local.getMeta<string>(curKey);
  let from = 0;
  let max = cursor ?? "";
  for (;;) {
    let q = supabase.from(table).select("*");
    if (table === "notes") q = q.neq("board", "public");
    if (cursor) q = q.gte("updated_at", cursor);
    else q = q.is("deleted_at", null);
    const { data } = check(await q.order("updated_at", { ascending: true }).range(from, from + PAGE_SIZE - 1));
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      applyRemoteRow(table, r);
      const u = String(r.updated_at ?? "");
      if (u > max) max = u;
    }
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  if (max && max !== cursor) local.setMeta(curKey, max);
}
const pullNotes = () => pullTable("notes");
const pullConnections = () => pullTable("connections");

async function pullPages() {
  const { data } = check(await supabase.from("board_pages").select("id, user_id, board_id, page, name"));
  const rows = (data ?? []) as PageLocal[];
  const have = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (local.opsFor("pages", r.id).length) continue;
    local.pages.put(r);
  }
  for (const r of local.pages.all()) {
    if (!have.has(r.id) && !local.opsFor("pages", r.id).some((o) => o.kind === "insert")) local.pages.del(r.id);
  }
}

async function pullDrawings() {
  const uid = local.userId as string;
  const { data } = check(await supabase.from("drawings").select("user_id, page, strokes, updated_at").eq("user_id", uid));
  for (const r of (data ?? []) as { user_id: string; page: number; strokes: unknown; updated_at: string }[]) {
    const key = `${r.user_id}|${r.page}`;
    const mine = local.opsFor("drawings", key);
    const ex = local.drawings.get(key);
    if (mine.length && later(mine[mine.length - 1].ts, r.updated_at)) continue; // my newer drawing is on its way
    mine.forEach((o) => local.removeOp(o));
    if (ex && JSON.stringify(ex.strokes) === JSON.stringify(r.strokes)) continue;
    local.drawings.put({ key, user_id: r.user_id, page: r.page, strokes: (r.strokes ?? []) as DrawingRow["strokes"], updated_at: r.updated_at });
  }
}

async function pullSettings() {
  if (local.opsFor("settings", "me").length) return;
  const { data, error } = await supabase.rpc("get_my_settings");
  if (error || !data || typeof data !== "object") return;
  local.setMeta("settings", data);
}

async function pullBoards() {
  const [b, m] = await Promise.all([
    supabase.from("boards").select("id, owner_id, name, created_at").order("created_at", { ascending: true }),
    supabase.from("board_members").select("board_id, user_id"),
  ]);
  check(b);
  check(m);
  const boards = (b.data ?? []) as BoardInfo[];
  const members = (m.data ?? []) as BoardMember[];
  const ids = new Set(boards.map((x) => x.id));
  for (const old of local.boards.all()) if (!ids.has(old.id)) local.boards.del(old.id);
  local.boards.putMany(boards);
  const keys = new Set(members.map((x) => `${x.board_id}|${x.user_id}`));
  for (const old of local.members.all()) if (!keys.has(old.key)) local.members.del(old.key);
  local.members.putMany(members.map((x) => ({ ...x, key: `${x.board_id}|${x.user_id}` })));
  // boards I left / that were deleted: forget their content
  for (const n of local.notes.all()) {
    if (n.board === "shared" && n.board_id && !ids.has(n.board_id) && !local.opsFor("notes", n.id).some((o) => o.kind === "insert")) removeLocal("notes", n.id);
  }
  for (const c of local.connections.all()) {
    if (c.board === "shared" && c.board_id && !ids.has(c.board_id)) removeLocal("connections", c.id);
  }
  for (const p of local.pages.all()) {
    if (p.board_id && !ids.has(p.board_id) && !local.opsFor("pages", p.id).length) local.pages.del(p.id);
  }
}

async function pullProfiles() {
  const need = new Set<string>();
  const uid = local.userId as string;
  need.add(uid);
  local.members.all().forEach((x) => need.add(x.user_id));
  local.notes.all().forEach((n) => n.user_id && need.add(n.user_id));
  const missing = Array.from(need).filter((id) => !local.profiles.get(id));
  // my own profile is refreshed every time (name, admin flag)
  const ask = Array.from(new Set([uid, ...missing]));
  const { data, error } = await supabase.from("profiles").select("id, username, is_admin, created_at").in("id", ask);
  if (error) {
    if (isNetErr(error)) throw error;
    return;
  }
  local.profiles.putMany((data ?? []) as Profile[]);
}

export const sync = new Engine();
export const pullNow = () => sync.pull(true);

/** Re-reads boards, members and the people on them right now (after the user changed a board). */
export async function refreshBoards() {
  try {
    await pullBoards();
    await pullProfiles();
  } catch (e) {
    console.error("Стикеры: не удалось обновить доски", e);
  }
}
