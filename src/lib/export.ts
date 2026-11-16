/*
 * Board export: PNG (current page), PDF (all pages, one sheet per page), JSON (backup).
 * The picture is drawn on a canvas from the data (not a screenshot): background, stickers, photos, threads, drawing,
 * in the current style. Locked stickers are drawn closed: their text is not on this device anyway.
 */
import { FONT_STACK, NOTE_COLOR_HEX, type Note } from "./supabase";
import { defaultPhotosFromLegacy } from "./photos";
import type { Connection } from "./threads";
import { threadGeometry } from "../components/Threads";
import { paint } from "../components/Drawing";
import type { Stroke } from "./drawings";
import type { UIStyle } from "./style";
import { bgCss, type BgSettings } from "./background";
import { localUrl } from "./localdb";
import { photoTilt } from "../components/Photos";

export interface ExportInput {
  title: string;
  kind: "private" | "shared";
  style: UIStyle;
  pages: { page: number; name: string }[];
  curPage: number;
  notes: Note[];
  conns: Connection[];
  strokesOf: (page: number) => Stroke[];
  authors: Record<string, string>; // user id -> name (shared boards)
  bg: BgSettings;
  bgPhotoUrl: string | null;
  imageUrl: (path: string | null) => string | null;
}

export type Progress = (fraction: number, label: string) => void;

const TILT_RANGE = 3;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const MAX_PIXELS = 24_000_000; // canvas area limit (phones are lower, the scale is reduced then)

function noteTilt(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (((h >>> 0) % 2001) / 1000 - 1) * TILT_RANGE;
}

// ---------- images ----------
type Img = ImageBitmap | HTMLImageElement | null;
class Images {
  private m = new Map<string, Promise<Img>>();
  get(url: string): Promise<Img> {
    let p = this.m.get(url);
    if (!p) {
      p = this.load(url);
      this.m.set(url, p);
    }
    return p;
  }
  private async load(url: string): Promise<Img> {
    try {
      const res = await fetch(url, { mode: "cors", cache: "force-cache" });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (typeof createImageBitmap === "function") {
        try {
          return await createImageBitmap(blob);
        } catch {
          /* fall through to <img> */
        }
      }
      const obj = URL.createObjectURL(blob);
      try {
        return await new Promise<HTMLImageElement>((ok, bad) => {
          const i = new Image();
          i.onload = () => ok(i);
          i.onerror = () => bad(new Error("img"));
          i.src = obj;
        });
      } finally {
        setTimeout(() => URL.revokeObjectURL(obj), 5000);
      }
    } catch {
      return null;
    }
  }
}
const iw = (i: Exclude<Img, null>) => ("naturalWidth" in i ? i.naturalWidth : i.width);
const ih = (i: Exclude<Img, null>) => ("naturalHeight" in i ? i.naturalHeight : i.height);

// ---------- style tables (the numbers come from index.css) ----------
interface St {
  w: number;
  minH: number;
  padT: number;
  padX: number;
  padB: number;
  radius: number;
  titleFont: string; // "<weight> <size>px"
  titleSize: number;
  titleLH: number;
  bodySize: number;
  bodyLH: number;
  timeSize: number;
  title: string;
  body: string;
  time: string;
  timeAlpha: number;
}
function stFor(style: UIStyle, hand: string): St & { handFont: string } {
  const base = { padT: 20, padX: 18, padB: 16, w: 240, minH: 200, radius: 6, titleFont: "650", titleSize: 19, titleLH: 22.8, bodySize: 15, bodyLH: 22.5, timeSize: 12, title: "#202531", body: "#303746", time: "#4d5665", timeAlpha: 0.8, handFont: hand };
  if (style === "original") return { ...base, w: 248, minH: 185, radius: 2, titleFont: "600", titleSize: 18, titleLH: 21.6, bodySize: 14, bodyLH: 20.3, timeSize: 11, time: "#5b6270", timeAlpha: 1 };
  if (style === "skeuo") return { ...base, padT: 30, radius: 3, titleFont: "400", titleSize: 25, titleLH: 27.5, title: "#2d2012", body: "#3a2c1a", time: "#6a5638", timeAlpha: 1 };
  return base;
}

// ---------- text ----------
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const tok of para.split(/(\s+)/)) {
      if (!tok) continue;
      if (ctx.measureText(line + tok).width <= maxW || !line.trim()) {
        line += tok;
        // a very long word: break by characters
        while (ctx.measureText(line).width > maxW && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxW) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        out.push(line.trimEnd());
        line = tok.trimStart();
      }
    }
    out.push(line.trimEnd());
    if (out.length > maxLines + 1) break;
  }
  if (out.length > maxLines) {
    const cut = out.slice(0, maxLines);
    let last = cut[maxLines - 1];
    while (last.length > 0 && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
    cut[maxLines - 1] = last + "…";
    return cut;
  }
  return out;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- layout of one page ----------
interface Item {
  note: Note;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number; // degrees
  pin: { x: number; y: number }; // pin centre in page coordinates (thread end)
  draw: (ctx: CanvasRenderingContext2D) => void;
}

function rootVar(name: string, fallback = ""): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
}

function rotPoint(px: number, py: number, cx: number, cy: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

async function layoutPage(input: ExportInput, page: number, images: Images, ctx: CanvasRenderingContext2D): Promise<Item[]> {
  const style = input.style;
  const hand = rootVar("--hand", '"Comic Sans MS", "Segoe Print", cursive');
  const st = stFor(style, hand);
  const tiltK = parseFloat(rootVar("--tilt-k", "1")) || 1;
  const showAuthor = input.kind === "shared";
  const items: Item[] = [];
  const notes = input.notes.filter((n) => (n.page ?? 1) === page);

  for (const note of notes) {
    const x = note.pos_x;
    const y = Math.max(112, note.pos_y);
    if (note.type === "photo" && note.image_url) {
      const img = await images.get(localUrl(note.image_url));
      const pw = note.width ?? 220;
      const skeuo = style === "skeuo";
      const pad = skeuo ? 10 : 8;
      const withAuthor = showAuthor && !!note.user_id && !!input.authors[note.user_id];
      const padB = withAuthor ? 46 : skeuo ? 46 : 28;
      const fw = pw - pad * 2;
      const aspect = (note.aspect && note.aspect > 0 ? note.aspect : img ? iw(img) / ih(img) : 1) || 1;
      const fh = fw / aspect;
      const h = pad + fh + padB;
      const rot = photoTilt(note.id);
      const cx = x + pw / 2;
      const cy = y + h / 2;
      const pinLocal = { x: pw / 2, y: 13 };
      const pin = rotPoint(x + pinLocal.x, y + pinLocal.y, cx, cy, rot);
      items.push({
        note, x, y, w: pw, h, rot, pin,
        draw: (c) => {
          c.save();
          c.translate(cx, cy);
          c.rotate((rot * Math.PI) / 180);
          c.translate(-pw / 2, -h / 2);
          c.shadowColor = skeuo ? "rgba(0,0,0,0.42)" : "rgba(0,0,0,0.26)";
          c.shadowBlur = skeuo ? 16 : style === "original" ? 12 : 24;
          c.shadowOffsetY = skeuo ? 10 : style === "original" ? 4 : 10;
          c.fillStyle = skeuo ? "#fbf9f2" : "#fff";
          rr(c, 0, 0, pw, h, 2);
          c.fill();
          c.shadowColor = "transparent";
          if (skeuo) {
            const g = c.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, "rgba(255,255,255,0.7)");
            g.addColorStop(1, "rgba(0,0,0,0.04)");
            c.fillStyle = g;
            c.fill();
          }
          // frame
          c.save();
          c.beginPath();
          c.rect(pad, pad, fw, fh);
          c.clip();
          if (img) c.drawImage(img, pad, pad, fw, fh);
          else {
            c.fillStyle = "#f1efe9";
            c.fillRect(pad, pad, fw, fh);
            c.fillStyle = "#8a8f99";
            c.font = "12px sans-serif";
            c.textAlign = "center";
            c.textBaseline = "middle";
            c.fillText("Фото недоступно", pad + fw / 2, pad + fh / 2);
          }
          c.restore();
          if (skeuo) {
            c.strokeStyle = "rgba(0,0,0,0.28)";
            c.lineWidth = 1;
            c.strokeRect(pad - 0.5, pad - 0.5, fw + 1, fh + 1);
          }
          if (note.caption) {
            const capH = withAuthor ? (skeuo ? 30 : 28) : skeuo ? 46 : 28;
            const capBottom = withAuthor ? h - 18 : h;
            c.fillStyle = skeuo ? "#33261a" : "#2b2f3a";
            c.font = skeuo ? `21px ${hand}` : '14px "Comic Sans MS", "Segoe Print", "Bradley Hand", cursive';
            c.textAlign = "center";
            c.textBaseline = "middle";
            const t = wrap(c, note.caption, pw - pad * 2, 1)[0] ?? "";
            c.fillText(t, pw / 2, capBottom - capH / 2);
          }
          if (withAuthor) {
            c.fillStyle = skeuo ? "#6a5638" : "#4d5665";
            c.font = "italic 12px sans-serif";
            c.textAlign = "center";
            c.textBaseline = "middle";
            c.fillText(`— ${input.authors[note.user_id as string]}`, pw / 2, h - 4 - 8);
          }
          // tape or pin
          if (skeuo) pinHead(c, pw / 2, 16);
          else tape(c, pw / 2, -9, 64, 18, "rgba(255,244,196,0.72)", true, -2, 3);
          c.restore();
        },
      });
      continue;
    }

    // ---- sticker ----
    const locked = !!note.locked;
    const family = FONT_STACK[note.font] ?? FONT_STACK.default;
    const innerW = st.w - st.padX * 2;
    const titleFam = style === "skeuo" ? hand : family;
    ctx.font = `${st.titleFont} ${st.titleSize}px ${titleFam}`;
    const titleLines = locked ? [] : wrap(ctx, note.title || "Без названия", innerW - 30, 2);
    ctx.font = `${st.bodySize}px ${family}`;
    const body = locked ? "" : note.body.trim();
    const bodyLines = body ? wrap(ctx, body, innerW, 4) : [];
    const titleH = titleLines.length * st.titleLH + (locked ? 0 : 8);
    const lockH = locked ? 14 + 30 + 10 + 3 * 8 + 2 * 6 + 6 : 0;
    const bodyH = bodyLines.length * st.bodyLH;
    const footH = 15;
    const contentH = st.padT + titleH + lockH + bodyH + 14 + footH + st.padB;
    const h = Math.max(st.minH, contentH);
    const rot = noteTilt(note.id) * tiltK;
    const cx = x + st.w / 2;
    const cy = y + h / 2;
    const pin = rotPoint(x + st.w / 2, y + 16, cx, cy, rot);
    const photos = locked ? [] : note.photos && note.photos.length > 0 ? note.photos : defaultPhotosFromLegacy(note.image_path, input.imageUrl(note.image_path));
    const thumb = photos[0] ?? null;
    const timg = thumb ? await images.get(localUrl(thumb.url)) : null;
    const color = rootVar(`--nc-${note.color}`, NOTE_COLOR_HEX[note.color]);
    const author = showAuthor && note.user_id ? input.authors[note.user_id] : null;
    const w = st.w;
    items.push({
      note, x, y, w, h, rot, pin,
      draw: (c) => {
        c.save();
        c.translate(cx, cy);
        c.rotate((rot * Math.PI) / 180);
        c.translate(-w / 2, -h / 2);
        const skeuo = style === "skeuo";
        // shadow + paper
        c.save();
        c.shadowColor = skeuo ? "rgba(0,0,0,0.38)" : style === "original" ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.22)";
        c.shadowBlur = skeuo ? 12 : style === "original" ? 12 : 22;
        c.shadowOffsetY = skeuo ? 9 : style === "original" ? 4 : 10;
        c.fillStyle = color;
        if (skeuo) cutCorner(c, w, h, 28);
        else rr(c, 0, 0, w, h, st.radius);
        c.fill();
        c.restore();
        c.save();
        if (skeuo) cutCorner(c, w, h, 28);
        else rr(c, 0, 0, w, h, st.radius);
        c.clip();
        c.fillStyle = color;
        c.fillRect(0, 0, w, h);
        if (skeuo) {
          const g = c.createLinearGradient(0, 0, 0, h);
          g.addColorStop(0, "rgba(255,255,255,0.38)");
          g.addColorStop(0.32, "rgba(255,255,255,0)");
          g.addColorStop(1, "rgba(0,0,0,0.07)");
          c.fillStyle = g;
          c.fillRect(0, 0, w, h);
          c.save();
          c.globalAlpha = 0.9;
          c.beginPath();
          c.moveTo(w, h - 28);
          c.lineTo(w - 28, h);
          c.lineTo(w, h);
          c.closePath();
          const cg = c.createLinearGradient(w - 28, h - 28, w, h);
          cg.addColorStop(0, "#fffdf1");
          cg.addColorStop(0.46, "#ece4c8");
          cg.addColorStop(1, "#bfb592");
          c.fillStyle = cg;
          c.fill();
          c.restore();
        } else {
          c.fillStyle = "rgba(0,0,0,0.07)";
          c.fillRect(0, h - 2, w, 2);
        }
        // photo of the sticker
        if (thumb) {
          const pw = (thumb.width / 100) * w;
          const px = (thumb.x / 100) * w;
          const py = (thumb.y / 100) * h;
          const ph = timg ? (pw * ih(timg)) / iw(timg) : pw * 0.66;
          c.save();
          rr(c, px, py, pw, ph, 4);
          c.clip();
          if (timg) c.drawImage(timg, px, py, pw, ph);
          else {
            c.fillStyle = "rgba(0,0,0,0.08)";
            c.fillRect(px, py, pw, ph);
          }
          c.restore();
        }
        // text
        c.textAlign = "left";
        c.textBaseline = "middle";
        let ty = st.padT;
        if (locked) {
          ty += 14;
          c.strokeStyle = "rgba(0,0,0,0.55)";
          c.lineWidth = 30 / 12;
          c.lineCap = "round";
          c.lineJoin = "round";
          c.save();
          c.translate(w / 2 - 15, ty);
          c.scale(30 / 24, 30 / 24);
          rr(c, 5, 11, 14, 10, 2);
          c.stroke();
          c.beginPath();
          c.moveTo(8, 11);
          c.lineTo(8, 8);
          c.arc(12, 8, 4, Math.PI, 0);
          c.lineTo(16, 11);
          c.stroke();
          c.restore();
          ty += 30 + 10;
          const bars = [0.78, 0.78 * 0.85, 0.78 * 0.55];
          for (let i = 0; i < 3; i++) {
            c.save();
            if ("filter" in c) (c as CanvasRenderingContext2D & { filter: string }).filter = "blur(2.5px)";
            c.fillStyle = "rgba(0,0,0,0.28)";
            const bw = w * bars[i];
            rr(c, w / 2 - w * 0.39, ty + i * 14, bw, 8, 4);
            c.fill();
            c.restore();
          }
          ty += lockH - 14 - 30 - 10;
        } else {
          c.fillStyle = st.title;
          c.font = `${st.titleFont} ${st.titleSize}px ${titleFam}`;
          titleLines.forEach((l, i) => c.fillText(l, st.padX, ty + i * st.titleLH + st.titleLH / 2));
          ty += titleH;
          c.fillStyle = st.body;
          c.font = `${st.bodySize}px ${family}`;
          bodyLines.forEach((l, i) => c.fillText(l, st.padX, ty + i * st.bodyLH + st.bodyLH / 2));
        }
        // foot
        const fy = h - st.padB - footH / 2;
        c.globalAlpha = st.timeAlpha;
        c.fillStyle = st.time;
        c.font = `${st.timeSize}px ${family}`;
        const tm = fmtTime(note.created_at);
        c.fillText(tm, st.padX, fy);
        if (author) {
          const tw = c.measureText(tm).width;
          c.font = `italic ${st.timeSize}px ${family}`;
          c.fillText(`— ${author}`, st.padX + tw + 6, fy);
        }
        c.globalAlpha = 1;
        // tape (inside the paper: the paper clips it, as in the app)
        if (!skeuo) {
          if (style === "original") tape(c, w / 2, -6, 56, 16, "rgba(255,255,255,0.5)", false, -2, 2);
          else tape(c, w / 2, -6, 64, 18, "rgba(255,255,255,0.58)", true, -2, 3);
        }
        c.restore();
        if (skeuo) pinHead(c, w / 2, 16);
        c.restore();
      },
    });
  }
  return items;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function cutCorner(c: CanvasRenderingContext2D, w: number, h: number, k: number) {
  c.beginPath();
  c.moveTo(3, 0);
  c.lineTo(w - 3, 0);
  c.lineTo(w, 3);
  c.lineTo(w, h - k);
  c.lineTo(w - k, h);
  c.lineTo(3, h);
  c.lineTo(0, h - 3);
  c.lineTo(0, 3);
  c.closePath();
}

function tape(c: CanvasRenderingContext2D, cx: number, top: number, w: number, h: number, color: string, shadow: boolean, deg: number, r: number) {
  c.save();
  c.translate(cx, top + h / 2);
  c.rotate((deg * Math.PI) / 180);
  if (shadow) {
    c.shadowColor = "rgba(0,0,0,0.13)";
    c.shadowBlur = 4;
    c.shadowOffsetY = 2;
  }
  c.fillStyle = color;
  rr(c, -w / 2, -h / 2, w, h, r);
  c.fill();
  c.restore();
}

function pinHead(c: CanvasRenderingContext2D, cx: number, cy: number) {
  c.save();
  c.shadowColor = "rgba(0,0,0,0.5)";
  c.shadowBlur = 3;
  c.shadowOffsetY = 3;
  const g = c.createRadialGradient(cx, cy + 1, 0, cx, cy + 1, 8);
  g.addColorStop(0, "#ff6a5e");
  g.addColorStop(0.55, "#d3221a");
  g.addColorStop(1, "#8f0f0a");
  c.fillStyle = g;
  c.beginPath();
  c.arc(cx, cy, 8, 0, Math.PI * 2);
  c.fill();
  c.shadowColor = "transparent";
  c.fillStyle = "rgba(255,255,255,0.85)";
  c.beginPath();
  c.arc(cx - 2.5, cy - 3, 2, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

// ---------- background ----------
function svgEsc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A CSS background (gradients, patterns, textures) drawn through an SVG <foreignObject>: the browser itself paints it. */
async function cssBackground(c: CanvasRenderingContext2D, W: number, H: number, css: string): Promise<boolean> {
  try {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${W}px;height:${H}px;${svgEsc(css)}"></div></foreignObject></svg>`;
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error("bg"));
      i.src = url;
    });
    c.drawImage(img, 0, 0, W, H);
    // a tainted canvas would fail later in toBlob: test it now
    c.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function boardCss(): string {
  // what the board itself shows in the current style (default board, no custom background)
  const el = document.querySelector(".board");
  const r = document.documentElement;
  const top = rootVar("--board-top", "#f4f1ea");
  const bottom = rootVar("--board-bottom", "#ece8df");
  if (!el) return `background:linear-gradient(145deg,${top},${bottom});`;
  const cs = getComputedStyle(el);
  void r;
  const img = cs.backgroundImage && cs.backgroundImage !== "none" ? cs.backgroundImage.replace(/"/g, "'") : "";
  return (
    `background-color:${cs.backgroundColor};` +
    (img ? `background-image:${img};background-size:${cs.backgroundSize};background-position:${cs.backgroundPosition};background-repeat:${cs.backgroundRepeat};` : "") +
    (cs.backgroundBlendMode ? `background-blend-mode:${cs.backgroundBlendMode};` : "")
  );
}

async function drawBackground(input: ExportInput, c: CanvasRenderingContext2D, W: number, H: number, images: Images) {
  const bg = input.bg;
  if (bg.kind === "photo" && input.bgPhotoUrl) {
    const img = await images.get(input.bgPhotoUrl);
    if (img) {
      c.fillStyle = "#222";
      c.fillRect(0, 0, W, H);
      const k = Math.max(W / iw(img), H / ih(img));
      const dw = iw(img) * k;
      const dh = ih(img) * k;
      c.save();
      if (bg.blur > 0 && "filter" in c) {
        (c as CanvasRenderingContext2D & { filter: string }).filter = `blur(${bg.blur}px)`;
        const m = bg.blur * 2;
        c.drawImage(img, (W - dw) / 2 - m, (H - dh) / 2 - m, dw + m * 2, dh + m * 2);
      } else c.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      c.restore();
      if (bg.dim > 0) {
        c.fillStyle = `rgba(0,0,0,${bg.dim / 100})`;
        c.fillRect(0, 0, W, H);
      }
      return;
    }
  }
  const css = bg.kind !== "none" && bg.kind !== "photo" ? bgCss(bg, null) : null;
  const ok = css ? await cssBackground(c, W, H, `background:${css};`) : await cssBackground(c, W, H, boardCss());
  if (!ok) {
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, rootVar("--board-top", "#f4f1ea"));
    g.addColorStop(1, rootVar("--board-bottom", "#ece8df"));
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }
  if (bg.kind !== "none" && bg.kind !== "photo" && bg.dim > 0) {
    c.fillStyle = `rgba(0,0,0,${bg.dim / 100})`;
    c.fillRect(0, 0, W, H);
  }
}

// ---------- one page -> canvas ----------
export async function renderPage(input: ExportInput, page: number, images = new Images()): Promise<HTMLCanvasElement> {
  try {
    await document.fonts?.ready;
  } catch {
    /* ignore */
  }
  const probe = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
  const items = await layoutPage(input, page, images, probe);
  const strokes = input.kind === "private" ? input.strokesOf(page) : [];
  const screenW = Math.max(320, window.innerWidth);

  // extents: stickers (with tilt), strokes, and a sensible minimum
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const it of items) {
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    for (const [px, py] of [[it.x, it.y], [it.x + it.w, it.y], [it.x, it.y + it.h], [it.x + it.w, it.y + it.h]] as const) {
      const p = rotPoint(px, py, cx, cy, it.rot);
      grow(p.x - 6, p.y - 12);
      grow(p.x + 6, p.y + 30);
    }
  }
  for (const s of strokes) {
    const half = (s.t === "marker" ? s.w * 3 : s.w) / 2;
    for (let i = 0; i < s.p.length; i += 2) grow(s.p[i] * screenW - half, s.p[i + 1] * screenW - half), grow(s.p[i] * screenW + half, s.p[i + 1] * screenW + half);
  }
  const empty = !isFinite(minX);
  const M = 48;
  const ox = empty ? 0 : Math.max(0, minX - M);
  const oy = empty ? 0 : Math.max(0, minY - M);
  const W = Math.round(Math.max(empty ? screenW : 640, empty ? screenW : maxX + M - ox));
  const H = Math.round(Math.max(empty ? 600 : 420, empty ? Math.max(480, window.innerHeight) : maxY + M - oy));
  let scale = Math.min(2, window.devicePixelRatio > 2 ? 2 : 2);
  if (W * H * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (W * H));
  scale = Math.max(0.25, scale);

  const canvas = document.createElement("canvas");
  canvas.dataset.lw = String(W);
  canvas.dataset.lh = String(H);
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const c = canvas.getContext("2d") as CanvasRenderingContext2D;
  c.scale(scale, scale);
  await drawBackground(input, c, W, H, images);

  c.save();
  c.translate(-ox, -oy);
  // stickers, then threads, then the drawing (as on the screen)
  for (const it of items) it.draw(c);

  const byId = new Map(items.map((i) => [i.note.id, i]));
  const threaded = new Set<string>();
  for (const k of input.conns) {
    if ((k.page ?? 1) !== page) continue;
    const a = byId.get(k.a_id), b = byId.get(k.b_id);
    if (!a || !b) continue;
    threaded.add(a.note.id);
    threaded.add(b.note.id);
    const { d, mid } = threadGeometry(a.pin, b.pin);
    c.save();
    c.strokeStyle = k.color;
    c.lineWidth = input.style === "skeuo" ? 3.6 : 3;
    c.lineCap = "round";
    if (k.dashed) c.setLineDash([2, 9]);
    c.stroke(new Path2D(d));
    c.restore();
    if (k.label) {
      const t = k.label.length > 30 ? k.label.slice(0, 29) + "…" : k.label;
      const lw = Math.min(k.label.length, 30) * 7.6 + 20;
      c.save();
      c.fillStyle = "#fffbe8";
      c.strokeStyle = "rgba(0,0,0,0.25)";
      c.lineWidth = 1;
      rr(c, mid.x - lw / 2, mid.y - 11, lw, 22, 6);
      c.fill();
      c.stroke();
      c.fillStyle = "#202531";
      c.font = "600 12px sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(t, mid.x, mid.y);
      c.restore();
    }
  }
  for (const id of threaded) {
    const p = byId.get(id)?.pin;
    if (!p) continue;
    c.save();
    c.shadowColor = "rgba(0,0,0,0.4)";
    c.shadowBlur = 3;
    c.shadowOffsetY = 2;
    const g = c.createRadialGradient(p.x - 2, p.y - 2, 0, p.x, p.y, 8);
    g.addColorStop(0, "#ff8a8a");
    g.addColorStop(0.55, "#d62828");
    g.addColorStop(1, "#8f1414");
    c.fillStyle = g;
    c.beginPath();
    c.arc(p.x, p.y, 7, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
  for (const s of strokes) paint(c, s, screenW);
  c.restore();
  return canvas;
}

// ---------- files ----------
const toBlob = (cv: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((ok, bad) => cv.toBlob((b) => (b ? ok(b) : bad(new Error("toBlob"))), type, q));

export async function exportPng(input: ExportInput, progress: Progress): Promise<Blob> {
  progress(0.05, "Рисую доску…");
  await tick();
  const cv = await renderPage(input, input.curPage);
  progress(0.85, "Сохраняю картинку…");
  await tick();
  const blob = await toBlob(cv, "image/png");
  progress(1, "Готово");
  return blob;
}

export async function exportPdf(input: ExportInput, progress: Progress): Promise<Blob> {
  const images = new Images();
  const sheets: Sheet[] = [];
  const n = input.pages.length;
  for (let i = 0; i < n; i++) {
    progress((i / n) * 0.9 + 0.02, `Страница ${i + 1} из ${n}…`);
    await tick();
    const cv = await renderPage(input, input.pages[i].page, images);
    const blob = await toBlob(cv, "image/jpeg", 0.9);
    sheets.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height, lw: Number(cv.dataset.lw), lh: Number(cv.dataset.lh) });
    cv.width = cv.height = 0; // free the memory at once
  }
  progress(0.95, "Собираю PDF…");
  await tick();
  const pdf = buildPdf(sheets);
  progress(1, "Готово");
  return pdf;
}

/** The smallest PDF writer: one JPEG per page, the page has the size of the picture (96 dpi -> points). */
export interface Sheet {
  jpeg: Uint8Array;
  w: number; // pixels of the picture
  h: number;
  lw: number; // size of the board in CSS px
  lh: number;
}
export function buildPdf(sheets: Sheet[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Uint8Array | string) => {
    const u = typeof b === "string" ? enc.encode(b) : b;
    parts.push(u);
    len += u.length;
  };
  const obj = (id: number, body: (Uint8Array | string)[]) => {
    offsets[id] = len;
    push(`${id} 0 obj\n`);
    body.forEach(push);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const n = sheets.length;
  const kids = sheets.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  obj(2, [`<< /Type /Pages /Count ${n} /Kids [${kids}] >>`]);
  sheets.forEach((s, i) => {
    const pid = 3 + i * 3, cid = pid + 1, iid = pid + 2;
    // the page keeps the logical size of the board (96 dpi -> points), the picture is sharper than that
    const pw = +(s.lw * 0.75).toFixed(2), ph = +(s.lh * 0.75).toFixed(2);
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(pid, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>`]);
    obj(cid, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    obj(iid, [`<< /Type /XObject /Subtype /Image /Width ${s.w} /Height ${s.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${s.jpeg.length} >>\nstream\n`, s.jpeg, "\nendstream"]);
  });
  const total = 3 + n * 3;
  const xref = len;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let id = 1; id < total; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

export function exportJson(input: ExportInput): Blob {
  const data = {
    app: "Стикеры",
    format: 1,
    exported_at: new Date().toISOString(),
    board: { name: input.title, kind: input.kind },
    pages: input.pages,
    // locked stickers: the text is not on this device and so is not in the backup (only the flag)
    notes: input.notes.map((n) => (n.locked ? { ...n, title: "", body: "", photos: [], image_path: null } : { ...n })),
    connections: input.conns,
    drawings: input.kind === "private" ? Object.fromEntries(input.pages.map((p) => [String(p.page), input.strokesOf(p.page)])) : undefined,
  };
  return new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
}

export function fileName(title: string, ext: string, page?: number): string {
  const base = (title || "board").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "board";
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${base}${page ? ` стр ${page}` : ""} ${stamp}.${ext}`;
}

export function canShareFiles(blob: Blob, name: string): boolean {
  try {
    const f = new File([blob], name, { type: blob.type });
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [f] }) && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

export async function shareFile(blob: Blob, name: string): Promise<"shared" | "cancelled" | "failed"> {
  try {
    await navigator.share({ files: [new File([blob], name, { type: blob.type })], title: name });
    return "shared";
  } catch (e) {
    return (e as { name?: string })?.name === "AbortError" ? "cancelled" : "failed";
  }
}

export function downloadFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
