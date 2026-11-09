import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !key) {
  throw new Error("Supabase env vars missing. Check .env");
}

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export type NoteColor =
  | "yellow"
  | "pink"
  | "green"
  | "blue"
  | "orange"
  | "purple"
  | "teal"
  | "red"
  | "mint"
  | "lavender";

export type Board = "private" | "public" | "shared";
/** Who may edit a sticker on a shared board: only its author, or the author and the board members. */
export type EditMode = "author" | "members";

export type NoteFont = "default" | "serif" | "mono" | "hand" | "rounded";

export interface NotePhoto {
  url: string;
  path: string;
  x: number; // top-left X in % of sticker width (0..100)
  y: number; // top-left Y in % of sticker height (0..100)
  width: number; // width in % of sticker width (20..100)
}

export type NoteType = "sticker" | "photo";

export interface Note {
  id: string;
  type?: NoteType; // missing on rows read before the photo migration -> sticker
  title: string;
  body: string;
  color: NoteColor;
  pos_x: number;
  pos_y: number;
  board: Board;
  board_id?: string | null; // set only on shared boards
  edit_mode?: EditMode;
  user_id: string | null;
  font: NoteFont;
  image_path: string | null;
  image_fit: string;
  image_height: number;
  image_align: string;
  photos: NotePhoto[] | null;
  // photo objects (type = 'photo')
  image_url?: string | null;
  width?: number;
  aspect?: number | null;
  caption?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  username: string;
  is_admin: boolean;
  created_at: string;
}

export const NOTE_COLORS: NoteColor[] = [
  "yellow",
  "pink",
  "green",
  "blue",
  "orange",
  "purple",
  "teal",
  "red",
  "mint",
  "lavender",
];

export const NOTE_COLOR_HEX: Record<NoteColor, string> = {
  yellow: "#ffe27a",
  pink: "#ffb3c6",
  green: "#b6e388",
  blue: "#9bd1f5",
  orange: "#ffc27a",
  purple: "#d8b4fe",
  teal: "#99e0d0",
  red: "#fda4a4",
  mint: "#c7f0c0",
  lavender: "#e3c9ff",
};

export const NOTE_FONTS: NoteFont[] = [
  "default",
  "serif",
  "mono",
  "hand",
  "rounded",
];

export const NOTE_FONT_LABEL: Record<NoteFont, string> = {
  default: "Обычный",
  serif: "С засечками",
  mono: "Моноширинный",
  hand: "Рукописный",
  rounded: "Округлый",
};

export const FONT_STACK: Record<NoteFont, string> = {
  default: '"Segoe UI", "Inter", system-ui, -apple-system, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
  hand: '"Comic Sans MS", "Segoe Print", cursive',
  rounded: '"Nunito", "Varela Round", "Segoe UI", sans-serif',
};

export const IMAGES_BUCKET = "note-images";
export const PHOTOS_BUCKET = "photos";
export const PHOTO_MIN_W = 100;
export const PHOTO_MAX_W = 600;
export const PHOTO_DEFAULT_W = 220;
export const PHOTO_CAPTION_MAX = 60;

export const BOARD_NAME_MAX = 40;
export const BOARD_MAX_FRIENDS = 7;

export interface BoardInfo {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
}

export interface BoardMember {
  board_id: string;
  user_id: string;
}
