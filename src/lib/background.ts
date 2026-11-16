import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import { local, useTable, usePendingOps } from "./localdb";
import { isOnline } from "./sync";
import { settingsPatch } from "./data";
import { compressImage } from "./photos";

export const BACKGROUNDS_BUCKET = "backgrounds";
export const BG_MAX_BYTES = 8 * 1024 * 1024;
export const BG_MAX_SIDE = 1920;
export const BG_DIM_MAX = 80; // %
export const BG_BLUR_MAX = 24; // px

export type BgKind = "none" | "color" | "gradient" | "pattern" | "photo";

export interface BgSettings {
  kind: BgKind;
  id?: string; // preset id (color / gradient / pattern)
  path?: string; // storage path (photo)
  dim: number; // 0..80 (%)
  blur: number; // 0..24 (px)
}

export const BG_DEFAULT: BgSettings = { kind: "none", dim: 0, blur: 0 };

export interface Preset {
  id: string;
  name: string;
  css: string; // CSS `background` value
}

export const BG_COLORS: Preset[] = [
  ["c-cream", "Крем", "#f4efe6"], ["c-sky", "Небо", "#e3ebf7"], ["c-rose", "Роза", "#fbe4e4"], ["c-mint", "Мята", "#e2f3e8"],
  ["c-sun", "Солнце", "#fff1c9"], ["c-lilac", "Сирень", "#e8e1f5"], ["c-sand", "Песок", "#e9dcc3"], ["c-slate", "Графит", "#2b2f3a"],
  ["c-night", "Ночь", "#161a26"], ["c-teal", "Лагуна", "#0f4a4c"], ["c-plum", "Слива", "#3d2a52"], ["c-navy", "Море", "#1d3557"],
].map(([id, name, css]) => ({ id, name, css }));

export const BG_GRADIENTS: Preset[] = [
  ["g-sunrise", "Рассвет", "linear-gradient(135deg,#ffd6a5,#fdffb6 55%,#caffbf)"],
  ["g-peach", "Персик", "linear-gradient(160deg,#ffecd2,#fcb69f)"],
  ["g-candy", "Леденец", "linear-gradient(135deg,#ff9a9e,#fad0c4 60%,#fbc2eb)"],
  ["g-ocean", "Океан", "linear-gradient(160deg,#a1c4fd,#c2e9fb)"],
  ["g-lavender", "Лаванда", "linear-gradient(135deg,#e0c3fc,#8ec5fc)"],
  ["g-forest", "Лес", "linear-gradient(160deg,#134e5e,#71b280)"],
  ["g-dusk", "Сумерки", "linear-gradient(160deg,#614385,#516395)"],
  ["g-night", "Полночь", "linear-gradient(160deg,#0f2027,#203a43 55%,#2c5364)"],
  ["g-ember", "Угли", "linear-gradient(160deg,#42275a,#734b6d)"],
  ["g-aurora", "Аврора", "radial-gradient(circle at 20% 15%,#7ee8c7 0,transparent 45%),radial-gradient(circle at 85% 80%,#8f94fb 0,transparent 50%),#1b2340"],
].map(([id, name, css]) => ({ id, name, css }));

const dot = (fg: string, bg: string) => `radial-gradient(${fg} 1.6px,transparent 1.8px) 0 0/22px 22px,${bg}`;
const grid = (fg: string, bg: string) => `linear-gradient(${fg} 1px,transparent 1px) 0 0/28px 28px,linear-gradient(90deg,${fg} 1px,transparent 1px) 0 0/28px 28px,${bg}`;
const diag = (fg: string, bg: string) => `repeating-linear-gradient(45deg,${fg} 0 2px,transparent 2px 14px),${bg}`;
const check = (fg: string, bg: string) => `conic-gradient(${fg} 25%,transparent 0 50%,${fg} 0 75%,transparent 0) 0 0/36px 36px,${bg}`;
const lines = (fg: string, bg: string) => `repeating-linear-gradient(0deg,${fg} 0 1px,transparent 1px 30px),${bg}`;
const cross = (fg: string, bg: string) => `linear-gradient(${fg},${fg}) 50% 50%/10px 2px no-repeat,linear-gradient(${fg},${fg}) 50% 50%/2px 10px no-repeat,${bg}`;

export const BG_PATTERNS: Preset[] = [
  ["p-dots", "Точки", dot("rgba(0,0,0,.2)", "#f4efe6")],
  ["p-dots-dark", "Точки ночью", dot("rgba(255,255,255,.16)", "#1c2030")],
  ["p-grid", "Клетка", grid("rgba(60,90,160,.16)", "#fbfaf5")],
  ["p-grid-dark", "Чертёж", grid("rgba(255,255,255,.08)", "#1e3a5f")],
  ["p-lines", "Линейка", lines("rgba(70,100,170,.2)", "#fffdf4")],
  ["p-diag", "Штрихи", diag("rgba(0,0,0,.07)", "#e8ecf4")],
  ["p-check", "Шахматы", check("rgba(0,0,0,.05)", "#f4f1ea")],
  ["p-cross", "Плюсы", `${cross("rgba(0,0,0,.2)", "transparent")},#e6f0e8`.replace("transparent,#e6f0e8", "#e6f0e8")],
].map(([id, name, css]) => ({ id, name, css }));

export function presetFor(bg: BgSettings): Preset | null {
  const list = bg.kind === "color" ? BG_COLORS : bg.kind === "gradient" ? BG_GRADIENTS : bg.kind === "pattern" ? BG_PATTERNS : [];
  return list.find((p) => p.id === bg.id) ?? null;
}

export function sanitizeBg(raw: unknown): BgSettings {
  if (!raw || typeof raw !== "object") return { ...BG_DEFAULT };
  const r = raw as Partial<BgSettings>;
  const kinds: BgKind[] = ["none", "color", "gradient", "pattern", "photo"];
  const kind = kinds.includes(r.kind as BgKind) ? (r.kind as BgKind) : "none";
  const num = (v: unknown, max: number) => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
  return {
    kind,
    id: typeof r.id === "string" ? r.id : undefined,
    path: typeof r.path === "string" ? r.path : undefined,
    dim: num(r.dim, BG_DIM_MAX),
    blur: num(r.blur, BG_BLUR_MAX),
  };
}

export function bgErrorText(error: unknown): string {
  const m = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  if (m === "BIG") return "Файл больше 8 МБ";
  if (m === "TYPE") return "Нужна картинка (JPG, PNG или WebP)";
  return "Не удалось загрузить фон. Попробуйте другое фото";
}

const cacheKey = (uid: string) => `sticky-bg-${uid}`;
const SIGN_TTL = 24 * 3600;
const SIGN_REFRESH_MS = 6 * 3600 * 1000;

function readCache(uid: string): BgSettings {
  try {
    const raw = localStorage.getItem(cacheKey(uid));
    return raw ? sanitizeBg(JSON.parse(raw)) : { ...BG_DEFAULT };
  } catch {
    return { ...BG_DEFAULT };
  }
}
function writeCache(uid: string, bg: BgSettings) {
  try {
    localStorage.setItem(cacheKey(uid), JSON.stringify(bg));
  } catch {
    /* storage may be unavailable */
  }
}

/** Personal board background: applied immediately, saved to profiles.settings, synced from other devices. */
export function useBackground(userId: string, paused: boolean) {
  const [bg, setBgState] = useState<BgSettings>(() => readCache(userId));
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bgRef = useRef(bg);
  bgRef.current = bg;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const signed = useRef<{ path: string; at: number } | null>(null);

  const sign = useCallback(async (path: string | undefined) => {
    if (!path) {
      signed.current = null;
      setPhotoUrl(null);
      return;
    }
    const urlKey = `sticky-bgurl-${path}`;
    const cached = (() => {
      try {
        const v = JSON.parse(localStorage.getItem(urlKey) || "null");
        return v && typeof v.url === "string" ? (v as { url: string; at: number }) : null;
      } catch {
        return null;
      }
    })();
    if (!isOnline() && cached) {
      signed.current = { path, at: cached.at };
      setPhotoUrl(cached.url);
      return;
    }
    const { data, error: e } = await supabase.storage.from(BACKGROUNDS_BUCKET).createSignedUrl(path, SIGN_TTL);
    if (e || !data?.signedUrl) {
      console.error("Стикеры: не удалось получить ссылку на фон", e);
      if (cached) {
        signed.current = { path, at: cached.at };
        setPhotoUrl(cached.url);
      }
      return;
    }
    signed.current = { path, at: Date.now() };
    setPhotoUrl(data.signedUrl);
    try {
      localStorage.setItem(urlKey, JSON.stringify({ url: data.signedUrl, at: Date.now() }));
    } catch {
      /* storage may be unavailable */
    }
  }, []);

  useEffect(() => {
    if (bg.kind === "photo") {
      if (!signed.current || signed.current.path !== bg.path) sign(bg.path);
    } else {
      signed.current = null;
      setPhotoUrl(null);
    }
  }, [bg.kind, bg.path, sign]);

  const apply = useCallback(
    (next: BgSettings) => {
      setBgState(next);
      bgRef.current = next;
      writeCache(userId, next);
      settingsPatch({ background: next }); // local first, the queue sends it
    },
    [userId]
  );

  // what the account says (written by the synchronisation) -> this device; photo links are refreshed now and then
  const meta = useTable(local.meta);
  const ops = usePendingOps();
  useEffect(() => {
    if (pausedRef.current || ops.some((o) => o.table === "settings")) return;
    const settings = meta.find((m) => m.key === "settings")?.value as { background?: unknown } | undefined;
    if (!settings || !meta.some((m) => m.key === "lastSync")) return;
    const remote = sanitizeBg(settings.background);
    if (JSON.stringify(remote) !== JSON.stringify(bgRef.current)) {
      setBgState(remote);
      bgRef.current = remote;
      writeCache(userId, remote);
    }
  }, [meta, ops, userId, paused]);
  useEffect(() => {
    const t = window.setInterval(() => {
      const cur = bgRef.current;
      if (cur.kind === "photo" && signed.current && isOnline() && Date.now() - signed.current.at > SIGN_REFRESH_MS) void sign(cur.path);
    }, 60000);
    return () => window.clearInterval(t);
  }, [sign]);

  const removeFile = useCallback((path: string | undefined) => {
    if (path) void supabase.storage.from(BACKGROUNDS_BUCKET).remove([path]);
  }, []);

  const setPreset = useCallback(
    (kind: "color" | "gradient" | "pattern", id: string) => {
      const prev = bgRef.current;
      if (prev.kind === "photo") removeFile(prev.path);
      apply({ ...prev, kind, id, path: undefined });
    },
    [apply, removeFile]
  );
  const setSliders = useCallback((patch: Partial<Pick<BgSettings, "dim" | "blur">>) => apply({ ...bgRef.current, ...patch }), [apply]);

  const upload = useCallback(
    async (file: File): Promise<string | null> => {
      if (!file.type.startsWith("image/")) return bgErrorText(new Error("TYPE"));
      if (file.size > BG_MAX_BYTES) return bgErrorText(new Error("BIG"));
      if (!isOnline()) return "Нет сети: фото для фона можно загрузить, когда появится интернет";
      setUploading(true);
      try {
        const { blob } = await compressImage(file, BG_MAX_SIDE);
        const path = `${userId}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        const { error: e } = await supabase.storage.from(BACKGROUNDS_BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
        if (e) throw e;
        const prev = bgRef.current;
        if (prev.kind === "photo") removeFile(prev.path);
        await sign(path);
        apply({ ...prev, kind: "photo", id: undefined, path });
        return null;
      } catch (e) {
        console.error(e);
        return bgErrorText(e);
      } finally {
        setUploading(false);
      }
    },
    [apply, removeFile, sign, userId]
  );

  const reset = useCallback(() => {
    const prev = bgRef.current;
    if (prev.kind === "photo") removeFile(prev.path);
    apply({ ...BG_DEFAULT });
  }, [apply, removeFile]);

  return { bg, photoUrl, uploading, error, clearError: () => setError(null), setPreset, setSliders, upload, reset };
}

export type BackgroundApi = ReturnType<typeof useBackground>;

/** CSS `background` for the painted layer (without dim / blur). */
export function bgCss(bg: BgSettings, photoUrl: string | null): string | null {
  if (bg.kind === "photo") return photoUrl ? `center/cover no-repeat url("${photoUrl}")` : null;
  return presetFor(bg)?.css ?? null;
}
