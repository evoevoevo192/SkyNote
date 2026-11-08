import { supabase, IMAGES_BUCKET, PHOTOS_BUCKET, type NotePhoto } from "./supabase";

const MAX_SIDE = 1600;
const QUALITY = 0.85;

export async function compressImage(file: File, maxSide: number = MAX_SIDE): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const { width: ow, height: oh } = bitmap;
  const scale = Math.min(1, maxSide / Math.max(ow, oh));
  const w = Math.round(ow * scale);
  const h = Math.round(oh * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas недоступен");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Не удалось сжать фото"))),
      "image/jpeg",
      QUALITY
    );
  });
  return { blob, width: w, height: h };
}

export async function uploadPhoto(
  file: File,
  ownerId: string,
  noteId: string
): Promise<NotePhoto> {
  const { blob } = await compressImage(file);
  const path = `${ownerId || "anon"}/${noteId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await supabase.storage
    .from(IMAGES_BUCKET)
    .upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from(IMAGES_BUCKET).getPublicUrl(path);
  return {
    url: data.publicUrl,
    path,
    x: 10,
    y: 45,
    width: 80,
  };
}

export async function removePhotoPaths(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const { error } = await supabase.storage.from(IMAGES_BUCKET).remove(paths);
  if (error) console.error("Не удалось удалить файлы фото", error);
}

export function defaultPhotosFromLegacy(imagePath: string | null, imageUrl: string | null): NotePhoto[] {
  if (!imagePath || !imageUrl) return [];
  return [
    {
      url: imageUrl,
      path: imagePath,
      x: 10,
      y: 45,
      width: 80,
    },
  ];
}

// ---------- photo objects on the board ----------
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function validatePhotoFile(file: File): string | null {
  if (!file.type.startsWith("image/")) return "Это не изображение. Выберите фото в формате JPG, PNG или WebP";
  if (file.size > MAX_PHOTO_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1).replace(".", ",");
    return `Файл слишком большой (${mb} МБ). Максимум 10 МБ`;
  }
  return null;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Compresses (1600px, JPEG 0.85) and uploads to photos/<userId>/<uuid>.jpg. */
export async function uploadBoardPhoto(file: File, userId: string): Promise<{ url: string; aspect: number }> {
  const { blob, width, height } = await compressImage(file);
  const path = `${userId}/${newId()}.jpg`;
  const { error } = await supabase.storage
    .from(PHOTOS_BUCKET)
    .upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, aspect: width / height };
}

export function photoPathFromUrl(url: string): string | null {
  const marker = `/${PHOTOS_BUCKET}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  const path = decodeURIComponent(url.slice(i + marker.length).split("?")[0]);
  return path || null;
}

export async function removeBoardPhoto(url: string): Promise<void> {
  const path = photoPathFromUrl(url);
  if (!path) return;
  const { error } = await supabase.storage.from(PHOTOS_BUCKET).remove([path]);
  if (error) console.error("Не удалось удалить файл фото", error);
}

export function photoErrorText(error: unknown, fallback: string): string {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : "";
  if (/bucket not found/i.test(message)) return "Хранилище фото не создано. Примените миграцию photo_objects в Supabase";
  if (/schema cache|column .* does not exist/i.test(message)) return "База не обновлена. Примените миграцию photo_objects в Supabase";
  if (/row-level security|not authorized|unauthorized/i.test(message)) return "Нет прав на загрузку фото. Войдите заново";
  if (/mime|invalid.*type/i.test(message)) return "Этот формат не поддерживается. Используйте JPG, PNG или WebP";
  if (/exceeded|too large|payload/i.test(message)) return "Файл слишком большой. Максимум 10 МБ";
  if (/failed to fetch|network/i.test(message)) return "Нет соединения. Проверьте интернет и повторите";
  return fallback;
}
