/*
 * Local database (IndexedDB) + in-memory mirror.
 *
 * The UI reads and writes the in-memory tables synchronously (instant, works without a network);
 * every change is written behind into IndexedDB and, when it has to reach the server, also put
 * into the outbox (see sync.ts). Each user gets his own database, so accounts never mix.
 *
 * (A small purpose-built layer instead of Dexie: no extra dependency to install.)
 */
import { useSyncExternalStore } from "react";
import type { Note } from "./supabase";
import type { Stroke } from "./drawings";
import type { Connection } from "./threads";
import type { PageRow } from "./pages";
import type { BoardInfo, BoardMember, Profile } from "./supabase";

// ---------- row types (local-only fields start with "_") ----------
export type NoteRow = Note & { deleted_at?: string | null; _srv?: string };
export type ConnRow = Connection & { updated_at?: string; deleted_at?: string | null; _srv?: string };
export interface DrawingRow {
  key: string; // `${user_id}|${page}`
  user_id: string;
  page: number;
  strokes: Stroke[];
  updated_at: string;
}
export type PageLocal = PageRow & { _srv?: string };
export interface MetaRow {
  key: string;
  value: unknown;
}

export type OutTable = "notes" | "connections" | "drawings" | "pages" | "settings" | "upload";
export type OutKind = "insert" | "update" | "delete" | "upsert" | "set" | "upload";
export interface OutOp {
  seq: number;
  table: OutTable;
  kind: OutKind;
  id: string;
  data?: Record<string, unknown>;
  ts: string; // when the user made the change (client clock)
  tries: number;
  nextAt: number;
}
export interface BlobRow {
  url: string;
  bucket: string;
  path: string;
  blob: Blob;
}

const STORES = ["notes", "connections", "drawings", "pages", "boards", "members", "profiles", "meta", "outbox", "blobs"] as const;
type StoreName = (typeof STORES)[number];

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const reqP = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

// ---------- generic table ----------
export class Table<T extends object> {
  rows = new Map<string, T>();
  private snap: T[] | null = null;
  private subs = new Set<() => void>();
  constructor(
    readonly name: StoreName,
    readonly keyOf: (r: T) => string
  ) {}

  all = (): T[] => (this.snap ??= Array.from(this.rows.values()));
  get(k: string): T | undefined {
    return this.rows.get(k);
  }
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  };
  private bump() {
    this.snap = null;
    this.subs.forEach((f) => f());
  }
  /** Set a row. persist=false keeps it in memory only (live drag positions). */
  put(row: T, persist = true) {
    const k = this.keyOf(row);
    this.rows.set(k, row);
    this.bump();
    if (persist) local.persistRow(this.name, k, row);
  }
  putMany(list: T[], persist = true) {
    if (!list.length) return;
    for (const r of list) {
      const k = this.keyOf(r);
      this.rows.set(k, r);
      if (persist) local.persistRow(this.name, k, r);
    }
    this.bump();
  }
  del(k: string, persist = true) {
    if (!this.rows.delete(k)) return;
    this.bump();
    if (persist) local.persistRow(this.name, k, null);
  }
  /** Replace the whole content from IndexedDB (another tab changed it). */
  replaceAll(list: [string, T][]) {
    this.rows = new Map(list);
    this.bump();
  }
}

// ---------- the database object ----------
class Local {
  userId: string | null = null;
  db: IDBDatabase | null = null;
  ready = false;

  notes = new Table<NoteRow>("notes", (r) => r.id);
  connections = new Table<ConnRow>("connections", (r) => r.id);
  drawings = new Table<DrawingRow>("drawings", (r) => r.key);
  pages = new Table<PageLocal>("pages", (r) => r.id);
  boards = new Table<BoardInfo>("boards", (r) => r.id);
  members = new Table<BoardMember & { key: string }>("members", (r) => r.key);
  profiles = new Table<Profile>("profiles", (r) => r.id);
  meta = new Table<MetaRow>("meta", (r) => r.key);

  ops: OutOp[] = [];
  private opSubs = new Set<() => void>();
  private opsSnap: OutOp[] | null = null;
  blobs = new Map<string, BlobRow>();
  private blobUrls = new Map<string, string>();
  private blobSubs = new Set<() => void>();

  private pending = new Map<string, [StoreName, string, unknown | null]>();
  private timer: number | null = null;
  private bc: BroadcastChannel | null = null;
  private seq = 0;
  onExternalOutbox: (() => void) | null = null;

  private tables(): Table<object>[] {
    return [this.notes, this.connections, this.drawings, this.pages, this.boards, this.members, this.profiles, this.meta] as unknown as Table<object>[];
  }

  async init(userId: string) {
    if (this.userId === userId && this.ready) return;
    this.userId = userId;
    this.ready = false;
    this.db = await openDb(`sticky-${userId}`);
    for (const t of this.tables()) t.rows = new Map();
    await Promise.all(this.tables().map((t) => this.loadTable(t)));
    await this.loadOutbox();
    await this.loadBlobs();
    this.ready = true;
    this.bc?.close();
    try {
      this.bc = new BroadcastChannel(`sticky-${userId}`);
      this.bc.onmessage = (e) => void this.onMessage(e.data as { stores: StoreName[] });
    } catch {
      this.bc = null;
    }
    this.tables().forEach((t) => (t as Table<object>).subscribe(() => undefined));
  }

  private async loadTable(t: Table<object>) {
    const db = this.db as IDBDatabase;
    const store = db.transaction(t.name, "readonly").objectStore(t.name);
    const [keys, vals] = await Promise.all([reqP(store.getAllKeys()), reqP(store.getAll())]);
    t.replaceAll(keys.map((k, i) => [String(k), vals[i] as object]));
  }
  private async loadOutbox() {
    const db = this.db as IDBDatabase;
    const vals = (await reqP(db.transaction("outbox", "readonly").objectStore("outbox").getAll())) as OutOp[];
    this.ops = vals.sort((a, b) => a.seq - b.seq);
    this.seq = this.ops.reduce((m, o) => Math.max(m, o.seq), (this.meta.get("seq")?.value as number) ?? 0);
    this.opsSnap = null;
    this.opSubs.forEach((f) => f());
  }
  private async loadBlobs() {
    const db = this.db as IDBDatabase;
    const vals = (await reqP(db.transaction("blobs", "readonly").objectStore("blobs").getAll())) as BlobRow[];
    this.blobs = new Map(vals.map((b) => [b.url, b]));
    this.blobUrls.forEach((u) => URL.revokeObjectURL(u));
    this.blobUrls = new Map();
    this.blobSubs.forEach((f) => f());
  }

  private async onMessage(msg: { stores: StoreName[] }) {
    if (!this.db) return;
    for (const s of msg.stores) {
      if (s === "outbox") {
        await this.loadOutbox();
        this.onExternalOutbox?.();
      } else if (s === "blobs") await this.loadBlobs();
      else {
        const t = this.tables().find((x) => x.name === s);
        if (t) await this.loadTable(t);
      }
    }
  }

  // ---------- write-behind persistence ----------
  persistRow(store: StoreName, key: string, value: unknown | null) {
    this.pending.set(`${store}\u0000${key}`, [store, key, value]);
    if (this.timer == null) this.timer = window.setTimeout(() => void this.flush(), 60);
  }

  async flush() {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    if (!this.db || this.pending.size === 0) return;
    const batch = Array.from(this.pending.values());
    this.pending.clear();
    const names = Array.from(new Set(batch.map((b) => b[0])));
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = (this.db as IDBDatabase).transaction(names, "readwrite");
        for (const [store, key, value] of batch) {
          const os = tx.objectStore(store);
          if (value === null) os.delete(key);
          else os.put(value, key);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      this.bc?.postMessage({ stores: names });
    } catch (e) {
      console.error("Стикеры: не удалось записать в локальную базу", e);
      window.dispatchEvent(new CustomEvent("sticky-local-error"));
    }
  }

  // ---------- outbox ----------
  opsSnapshot = (): OutOp[] => (this.opsSnap ??= this.ops.slice());
  subscribeOps = (fn: () => void) => {
    this.opSubs.add(fn);
    return () => void this.opSubs.delete(fn);
  };
  private opsChanged() {
    this.opsSnap = null;
    this.opSubs.forEach((f) => f());
  }
  private saveOp(op: OutOp) {
    this.persistRow("outbox", String(op.seq), op);
  }
  private dropOp(op: OutOp) {
    this.ops = this.ops.filter((o) => o !== op);
    this.persistRow("outbox", String(op.seq), null);
  }
  opsFor(table: OutTable, id: string) {
    return this.ops.filter((o) => o.table === table && o.id === id);
  }
  removeOp(op: OutOp) {
    this.dropOp(op);
    this.opsChanged();
  }
  removeOpsFor(table: OutTable, id: string) {
    this.opsFor(table, id).forEach((o) => this.dropOp(o));
    this.opsChanged();
  }
  touchOp(op: OutOp) {
    this.saveOp(op);
    this.opsChanged();
  }

  /** Adds a change to the queue, merging it with the pending ones of the same object. */
  enqueue(table: OutTable, kind: OutKind, id: string, data: Record<string, unknown> | undefined, ts = new Date().toISOString()) {
    const same = this.opsFor(table, id);
    const last = same[same.length - 1];
    if (table === "drawings" || table === "settings") {
      // whole value replaces / merges
      if (last && last.kind === kind) {
        last.data = table === "settings" ? { ...(last.data ?? {}), ...(data ?? {}) } : data;
        last.ts = ts;
        last.tries = 0;
        last.nextAt = 0;
        this.saveOp(last);
        this.opsChanged();
        return;
      }
    } else if (table !== "upload") {
      if (kind === "update" && last) {
        if (last.kind === "insert" || last.kind === "update") {
          last.data = { ...(last.data ?? {}), ...(data ?? {}) };
          last.ts = ts;
          this.saveOp(last);
          this.opsChanged();
          return;
        }
        if (last.kind === "delete") return;
      }
      if (kind === "delete" && same.length) {
        if (same.some((o) => o.kind === "insert")) {
          // never reached the server: forget it completely (its photo files stay for upload, harmless)
          same.forEach((o) => this.dropOp(o));
          this.opsChanged();
          return;
        }
        same.forEach((o) => this.dropOp(o)); // pending updates are pointless now
      }
    }
    this.seq = Math.max(this.seq + 1, Date.now() * 1000); // unique across tabs
    const op: OutOp = { seq: this.seq, table, kind, id, data, ts, tries: 0, nextAt: 0 };
    this.ops.push(op);
    this.saveOp(op);
    this.persistRow("meta", "seq", { key: "seq", value: this.seq });
    this.opsChanged();
  }

  // ---------- local photos (not yet uploaded) ----------
  async putBlob(b: BlobRow) {
    this.blobs.set(b.url, b);
    this.persistRow("blobs", b.url, b);
    this.blobSubs.forEach((f) => f());
  }
  removeBlob(url: string) {
    this.blobs.delete(url);
    this.persistRow("blobs", url, null);
    // the object URL stays alive until the page is reloaded (the image may be on screen)
  }
  /** URL to show: a local object URL while the file is not uploaded yet. */
  resolveUrl = (url: string | null | undefined): string => {
    if (!url) return "";
    const b = this.blobs.get(url);
    if (!b) return url;
    let u = this.blobUrls.get(url);
    if (!u) {
      u = URL.createObjectURL(b.blob);
      this.blobUrls.set(url, u);
    }
    return u;
  };
  subscribeBlobs = (fn: () => void) => {
    this.blobSubs.add(fn);
    return () => void this.blobSubs.delete(fn);
  };

  // ---------- meta helpers ----------
  getMeta<T>(key: string): T | undefined {
    return this.meta.get(key)?.value as T | undefined;
  }
  setMeta(key: string, value: unknown) {
    this.meta.put({ key, value });
  }

  /** Forget everything of this user (sign-out). */
  async wipe() {
    const id = this.userId;
    this.db?.close();
    this.db = null;
    this.ready = false;
    this.bc?.close();
    this.bc = null;
    this.ops = [];
    this.blobs = new Map();
    for (const t of this.tables()) t.rows = new Map();
    this.pending.clear();
    if (id) {
      await new Promise<void>((resolve) => {
        const r = indexedDB.deleteDatabase(`sticky-${id}`);
        r.onsuccess = r.onerror = r.onblocked = () => resolve();
      });
    }
    this.userId = null;
  }
}

export const local = new Local();

// ---------- React bindings ----------
export function useTable<T extends object>(t: Table<T>): T[] {
  return useSyncExternalStore(t.subscribe, t.all, t.all);
}
export function usePendingOps(): OutOp[] {
  return useSyncExternalStore(local.subscribeOps, local.opsSnapshot, local.opsSnapshot);
}
/** Re-renders when pending local photos change. */
export function useBlobTick(): number {
  return useSyncExternalStore(
    local.subscribeBlobs,
    () => local.blobs.size,
    () => 0
  );
}
export function localUrl(url: string | null | undefined): string {
  return local.resolveUrl(url);
}
