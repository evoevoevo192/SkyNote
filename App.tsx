import { useCallback, useEffect, useRef, useState } from "react";
import {
  supabase,
  type Note,
  type NoteColor,
  type NoteFont,
  type NotePhoto,
  type Profile,
  type Board,
  NOTE_COLORS,
  NOTE_COLOR_HEX,
  NOTE_FONTS,
  NOTE_FONT_LABEL,
  FONT_STACK,
  IMAGES_BUCKET,
  PHOTO_DEFAULT_W,
  PHOTO_MAX_W,
  PHOTO_MIN_W,
} from "./lib/supabase";
import {
  uploadPhoto,
  removePhotoPaths,
  defaultPhotosFromLegacy,
  uploadBoardPhoto,
  removeBoardPhoto,
  validatePhotoFile,
  photoErrorText,
} from "./lib/photos";
import { PhotoFrame, PhotoPanel, PhotoResizeHandle, PhotoViewer, ImageIcon, photoTilt } from "./components/Photos";
import { PhotoLayer } from "./components/PhotoLayer";
import { useFriends, type Person } from "./lib/friends";
import type { EditMode } from "./lib/supabase";
import { useBoards } from "./lib/boards";
import { useBackground } from "./lib/background";
import { BackgroundDialog, BackgroundIcon, BoardBackground } from "./components/Background";
import { NoteFullscreen } from "./components/NoteFullscreen";
import { BoardChips, NewBoardDialog, BoardDialog } from "./components/Boards";
import { FriendsDialog, ProfileDialog, ToastView, Avatar, FriendsIcon, type Toast } from "./components/Friends";

const TILT_RANGE = 3; // degrees of random tilt per note

type Theme = "light" | "dark";

function randomTilt(): number {
  return (Math.random() * 2 - 1) * TILT_RANGE;
}

function preview(body: string): string {
  return body.trim();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function imageUrl(path: string | null): string | null {
  if (!path) return null;
  const { data } = supabase.storage.from(IMAGES_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ---------- auth ----------
type AuthState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; userId: string; email: string };

function useAuth() {
  const [state, setState] = useState<AuthState>({ kind: "loading" });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setState({
          kind: "signed-in",
          userId: data.session.user.id,
          email: data.session.user.email ?? "",
        });
      } else {
        setState({ kind: "signed-out" });
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setState({
          kind: "signed-in",
          userId: session.user.id,
          email: session.user.email ?? "",
        });
      } else {
        setState({ kind: "signed-out" });
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  return state;
}

// ---------- main app ----------
export default function App() {
  const auth = useAuth();
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("theme") as Theme | null;
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  const [view, setView] = useState<Board>("private");
  const [boardId, setBoardId] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  if (auth.kind === "loading") {
    return (
      <div className="login-wrap">
        <p className="login-subtitle">Загрузка…</p>
      </div>
    );
  }

  if (auth.kind === "signed-out") {
    return (
      <AuthScreen
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />
    );
  }

  return (
    <BoardApp
      theme={theme}
      onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      view={view}
      setView={setView}
      boardId={boardId}
      setBoardId={setBoardId}
      userId={auth.userId}
      onSignOut={() => supabase.auth.signOut()}
    />
  );
}

// ---------- board ----------
interface BoardAppProps {
  theme: Theme;
  onToggleTheme: () => void;
  view: Board;
  setView: (b: Board) => void;
  boardId: string | null;
  setBoardId: (id: string | null) => void;
  userId: string;
  onSignOut: () => void;
}

function BoardApp({ theme, onToggleTheme, view, setView, boardId, setBoardId, userId, onSignOut }: BoardAppProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [me, setMe] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // friends
  const friendsApi = useFriends(userId);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [authorFilter, setAuthorFilter] = useState<Person | null>(null);
  const boardsApi = useBoards(userId);
  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [fullId, setFullId] = useState<string | null>(null);
  const [bgOpen, setBgOpen] = useState(false);
  const background = useBackground(userId, bgOpen);
  const activeBoard = view === "shared" ? boardsApi.boards.find((b) => b.id === boardId) ?? null : null;
  const isBoardOwner = activeBoard?.owner_id === userId;
  const [toast, setToast] = useState<Toast | null>(null);
  const notify = useCallback(
    (text: string, kind: "success" | "error" = "success") => setToast({ id: Date.now(), text, kind }),
    []
  );
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (view === "private") setAuthorFilter(null);
  }, [view]);
  // the shared board disappeared (deleted by the owner, I was removed, or I left)
  useEffect(() => {
    if (view !== "shared" || boardsApi.loading) return;
    if (!boardsApi.boards.some((b) => b.id === boardId)) {
      setBoardId(null);
      setView("public");
      setManageOpen(false);
      notify("Доска больше недоступна", "error");
    }
  }, [view, boardId, boardsApi.boards, boardsApi.loading, setBoardId, setView, notify]);
  const openBoardsTab = () => {
    if (view !== "private") return;
    if (boardId && boardsApi.boards.some((b) => b.id === boardId)) setView("shared");
    else setView("public");
  };
  const pickBoard = (id: string | null) => {
    setBoardId(id);
    setView(id ? "shared" : "public");
    setAuthorFilter(null);
  };
  const openFriendBoard = (person: Person) => {
    setAuthorFilter(person);
    setBoardId(null);
    setView("public");
    setFriendsOpen(false);
  };

  // photo objects (notes with type = 'photo')
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const [confirmPhotoId, setConfirmPhotoId] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [fabOpen, setFabOpen] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  const widthTimers = useRef<Record<string, number>>({});
  const press = useRef<{ x: number; y: number; timer: number; fired: boolean; moved: boolean } | null>(null);

  const boardRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  // load my profile
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, username, is_admin, created_at")
        .eq("id", userId)
        .maybeSingle();
      if (data) {
        setMe(data as Profile);
        localStorage.removeItem("pending-sticky-profile");
        return;
      }

      const pendingProfile = localStorage.getItem("pending-sticky-profile");
      if (!pendingProfile) return;
      try {
        const parsed = JSON.parse(pendingProfile) as { username?: string };
        if (!parsed.username) return;
        const { error: profileError } = await supabase.rpc("register_profile", {
          p_username: parsed.username,
        });
        if (profileError) {
          console.error("Стикеры: не удалось создать профиль после подтверждения email", profileError);
          setError(`Профиль не создан: ${supabaseErrorText(profileError)}`);
          return;
        }
        localStorage.removeItem("pending-sticky-profile");
        const { data: createdProfile } = await supabase
          .from("profiles")
          .select("id, username, is_admin, created_at")
          .eq("id", userId)
          .maybeSingle();
        if (createdProfile) setMe(createdProfile as Profile);
      } catch (profileFailure) {
        console.error("Стикеры: ошибка восстановления профиля", profileFailure);
        setError("Не удалось завершить создание профиля. Выйдите и войдите снова.");
      }
    })();
  }, [userId]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);

  // load notes for current view + all author profiles
  const loadNotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    if (view === "shared" && !boardId) {
      setNotes([]);
      setLoading(false);
      return;
    }
    let query = supabase.from("notes").select("*");
    query = view === "shared" ? query.eq("board_id", boardId as string) : query.eq("board", view);
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) {
      setError("Не удалось загрузить заметки");
      console.error(error);
    } else {
      const rows = (data ?? []) as Note[];
      setNotes(rows);
      // fetch profiles for authors we don't have yet
      const ids = Array.from(
        new Set(rows.map((r) => r.user_id).filter((id): id is string => id !== null))
      );
      const missing = ids.filter((id) => !profiles[id]);
      if (missing.length) {
        const { data: pdata } = await supabase
          .from("profiles")
          .select("id, username, is_admin, created_at")
          .in("id", missing);
        if (pdata) {
          setProfiles((prev) => {
            const next = { ...prev };
            for (const p of pdata as Profile[]) next[p.id] = p;
            return next;
          });
        }
      }
    }
    setLoading(false);
  }, [view, boardId, profiles]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  // ---- Realtime: other people's changes arrive without reloading ----
  const sentSigs = useRef<Map<string, string[]>>(new Map());
  const notesRef = useRef<Note[]>([]);
  notesRef.current = notes;
  const ensureProfile = useCallback(async (id: string | null) => {
    if (!id) return;
    const { data } = await supabase.from("profiles").select("id, username, is_admin, created_at").eq("id", id).maybeSingle();
    if (data) setProfiles((prev) => (prev[id] ? prev : { ...prev, [id]: data as Profile }));
  }, []);

  useEffect(() => {
    if (view === "shared" && !boardId) return;
    const matches = (n: Partial<Note>) => (view === "shared" ? n.board_id === boardId : n.board === view);
    const channel = supabase
      .channel(`notes-${view}-${boardId ?? "none"}-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "notes" }, (payload) => {
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string }).id;
          if (!id) return;
          setNotes((prev) => (prev.some((n) => n.id === id) ? prev.filter((n) => n.id !== id) : prev));
          setActiveId((cur) => (cur === id ? null : cur));
          setFullId((cur) => (cur === id ? null : cur));
          setSelectedPhotoId((cur) => (cur === id ? null : cur));
          setViewerId((cur) => (cur === id ? null : cur));
          return;
        }
        const row = payload.new as Note;
        if (!row || !matches(row)) return;
        if (payload.eventType === "INSERT") {
          setNotes((prev) => (prev.some((n) => n.id === row.id) ? prev : [row, ...prev]));
          ensureProfile(row.user_id);
        } else {
          // the card I am dragging must not jump
          if (dragState.current?.id === row.id) return;
          const sigs = sentSigs.current.get(row.id) ?? [];
          const mine = sigs.indexOf(textSig(row));
          if (mine !== -1) {
            sigs.splice(mine, 1); // echo of my own save: consume it
            sentSigs.current.set(row.id, sigs);
          }
          setNotes((prev) => {
            const i = prev.findIndex((n) => n.id === row.id);
            if (i === -1) {
              ensureProfile(row.user_id);
              return [row, ...prev];
            }
            const next = prev.slice();
            const old = prev[i];
            // echo of my own change: take only server-side facts, keep what I may be typing right now.
            // someone else's change (collaborative sticker): take everything.
            const echo = mine !== -1 || textSig(old) === textSig(row);
            next[i] = echo
              ? { ...old, pos_x: row.pos_x, pos_y: row.pos_y, edit_mode: row.edit_mode, updated_at: row.updated_at }
              : { ...old, ...row };
            return next;
          });
        }
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [view, boardId, userId, ensureProfile]);

  const activeNote = notes.find((n) => n.id === activeId) ?? null;
  const fullNote = notes.find((n) => n.id === fullId) ?? null;
  const visibleNotes = authorFilter ? notes.filter((n) => n.user_id === authorFilter.id) : notes;
  const selectedPhoto = notes.find((n) => n.id === selectedPhotoId && n.type === "photo") ?? null;
  const viewerPhotos = visibleNotes
    .filter((n) => n.type === "photo" && n.image_url)
    .map((n) => ({ id: n.id, url: n.image_url as string, caption: n.caption ?? null }));

  const createNote = useCallback(async () => {
    const board = boardRef.current;
    const w = board?.clientWidth ?? window.innerWidth;
    const h = board?.clientHeight ?? window.innerHeight;
    const x = Math.max(20, Math.random() * (w - 240));
    const y = Math.max(128, Math.random() * Math.max(160, h - 220));
    const color: NoteColor = NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)];

    const { data, error } = await supabase
      .from("notes")
      .insert({
        title: "Новая заметка",
        body: "",
        color,
        pos_x: x,
        pos_y: y,
        board: view,
        ...(view === "shared" ? { board_id: boardId } : {}),
        font: "default",
      })
      .select()
      .single();
    if (error) {
      setError("Не удалось создать заметку");
      console.error(error);
      return;
    }
    const created = data as Note;
    setNotes((prev) => (prev.some((n) => n.id === created.id) ? prev : [created, ...prev]));
    setActiveId(created.id);
  }, [view, boardId]);

  const deleteNote = useCallback(
    async (id: string) => {
      const prev = notes.find((n) => n.id === id);
      // remove legacy image and any multi-photo files
      const paths: string[] = [];
      if (prev?.image_path) paths.push(prev.image_path);
      if (prev?.photos) paths.push(...prev.photos.map((p) => p.path));
      if (paths.length) removePhotoPaths(paths);
      setNotes((prevNotes) => prevNotes.filter((n) => n.id !== id));
      setActiveId(null);
      const { error } = await supabase.from("notes").delete().eq("id", id);
      if (error) {
        console.error(error);
        if (prev) setNotes((p) => [prev, ...p]);
        setError("Не удалось удалить заметку");
      }
    },
    [notes]
  );

  const updateNote = useCallback(
    async (id: string, patch: Partial<Pick<Note, "title" | "body" | "color" | "pos_x" | "pos_y" | "font" | "edit_mode" | "image_path" | "image_fit" | "image_height" | "image_align" | "photos">>) => {
      const base = notesRef.current.find((n) => n.id === id);
      if (base) {
        const list = sentSigs.current.get(id) ?? [];
        list.push(textSig({ ...base, ...patch }));
        sentSigs.current.set(id, list.slice(-20));
      }
      setNotes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, ...patch, updated_at: new Date().toISOString() } : n))
      );
      const { error } = await supabase
        .from("notes")
        .update({ ...patch })
        .eq("id", id);
      if (error) {
        console.error(error);
        setError("Не удалось сохранить заметку");
        // access may have been taken away: show what the server really has
        const { data: fresh } = await supabase.from("notes").select("*").eq("id", id).maybeSingle();
        if (fresh) setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...(fresh as Note) } : n)));
      }
    },
    []
  );

  // ---- dragging ----
  const onStickyPointerDown = (e: React.PointerEvent<HTMLDivElement>, note: Note) => {
    if (e.button !== 0) return;
    // only the author can drag on public / shared boards; on the private board everything is mine
    if (view !== "private" && !canEdit(note)) return;
    const board = boardRef.current;
    if (!board) return;
    const boardRect = board.getBoundingClientRect();
    dragState.current = {
      id: note.id,
      offsetX: e.clientX - boardRect.left - note.pos_x,
      offsetY: e.clientY - boardRect.top - note.pos_y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("dragging");
  };

  const onStickyPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st) return;
    const board = boardRef.current;
    if (!board) return;
    const boardRect = board.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - boardRect.left - st.offsetX, boardRect.width - 220));
    const y = Math.max(0, Math.min(e.clientY - boardRect.top - st.offsetY, boardRect.height - 160));
    setNotes((prev) => prev.map((n) => (n.id === st.id ? { ...n, pos_x: x, pos_y: y } : n)));
  };

  const onStickyPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st) return;
    const note = notes.find((n) => n.id === st.id);
    e.currentTarget.classList.remove("dragging");
    dragState.current = null;
    if (note) {
      supabase
        .from("notes")
        .update({ pos_x: note.pos_x, pos_y: note.pos_y })
        .eq("id", note.id)
        .then(({ error }) => {
          if (error) console.error(error);
        });
    }
  };

  // ---- photo objects: same drag code as stickers, plus select / open / edit ----
  const isGridLayout = () => window.matchMedia("(max-width: 639px)").matches;

  const addPhoto = useCallback(
    async (file: File) => {
      if (view === "public" || (view === "shared" && !boardId)) {
        notify("Фото можно добавлять на личную доску и на доски с друзьями", "error");
        return;
      }
      const problem = validatePhotoFile(file);
      if (problem) {
        notify(problem, "error");
        return;
      }
      setUploadingPhoto(true);
      try {
        const { url, aspect } = await uploadBoardPhoto(file, userId);
        const board = boardRef.current;
        const jitter = () => (Math.random() * 2 - 1) * 48;
        const x = Math.max(20, (board?.scrollLeft ?? 0) + (board?.clientWidth ?? window.innerWidth) / 2 - PHOTO_DEFAULT_W / 2 + jitter());
        const y = Math.max(128, (board?.scrollTop ?? 0) + (board?.clientHeight ?? window.innerHeight) / 2 - 130 + jitter());
        const { data, error: insertError } = await supabase
          .from("notes")
          .insert({
            type: "photo",
            title: "",
            body: "",
            color: "yellow",
            pos_x: x,
            pos_y: y,
            board: view,
            ...(view === "shared" ? { board_id: boardId } : {}),
            font: "default",
            image_url: url,
            width: PHOTO_DEFAULT_W,
            aspect,
            caption: null,
          })
          .select()
          .single();
        if (insertError) {
          removeBoardPhoto(url);
          throw insertError;
        }
        const created = data as Note;
        setNotes((prev) => (prev.some((n) => n.id === created.id) ? prev : [created, ...prev]));
        if (!isGridLayout()) setSelectedPhotoId(created.id);
        notify("Фото добавлено");
      } catch (e) {
        console.error("Стикеры: не удалось добавить фото", e);
        notify(photoErrorText(e, "Не удалось добавить фото. Попробуйте ещё раз"), "error");
      } finally {
        setUploadingPhoto(false);
      }
    },
    [view, boardId, userId, notify]
  );

  const addPhotos = useCallback(
    async (files: File[]) => {
      for (const file of files) await addPhoto(file);
    },
    [addPhoto]
  );

  const replacePhoto = async (file: File, note: Note) => {
    const problem = validatePhotoFile(file);
    if (problem) {
      notify(problem, "error");
      return;
    }
    setUploadingPhoto(true);
    try {
      const old = note.image_url;
      const { url, aspect } = await uploadBoardPhoto(file, userId);
      const { error: updateError } = await supabase.from("notes").update({ image_url: url, aspect }).eq("id", note.id);
      if (updateError) {
        removeBoardPhoto(url);
        throw updateError;
      }
      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, image_url: url, aspect } : n)));
      if (old) removeBoardPhoto(old);
      notify("Фото заменено");
    } catch (e) {
      console.error("Стикеры: не удалось заменить фото", e);
      notify(photoErrorText(e, "Не удалось заменить фото. Попробуйте ещё раз"), "error");
    } finally {
      setUploadingPhoto(false);
    }
  };

  // live size change (slider, presets, corner handle); saved 400 ms after the last change
  const setPhotoWidth = useCallback(
    (id: string, raw: number) => {
      const width = Math.round(Math.max(PHOTO_MIN_W, Math.min(PHOTO_MAX_W, raw)));
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, width } : n)));
      window.clearTimeout(widthTimers.current[id]);
      widthTimers.current[id] = window.setTimeout(async () => {
        const { error: saveError } = await supabase.from("notes").update({ width }).eq("id", id);
        if (saveError) {
          console.error(saveError);
          notify("Не удалось сохранить размер фото", "error");
        }
      }, 400);
    },
    [notify]
  );

  const setPhotoCaption = useCallback(
    async (id: string, caption: string | null) => {
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, caption } : n)));
      const { error: saveError } = await supabase.from("notes").update({ caption }).eq("id", id);
      if (saveError) {
        console.error(saveError);
        notify("Не удалось сохранить подпись", "error");
      } else {
        notify("Подпись сохранена");
      }
    },
    [notify]
  );

  const deletePhoto = useCallback(
    async (note: Note) => {
      setConfirmPhotoId(null);
      setSelectedPhotoId(null);
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      const { error: deleteError } = await supabase.from("notes").delete().eq("id", note.id);
      if (deleteError) {
        console.error(deleteError);
        setNotes((prev) => [note, ...prev]);
        notify("Не удалось удалить фото", "error");
        return;
      }
      if (note.image_url) removeBoardPhoto(note.image_url);
      notify("Фото удалено");
    },
    [notify]
  );

  const clearPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };

  const onPhotoPointerDown = (e: React.PointerEvent<HTMLDivElement>, note: Note) => {
    clearPress();
    press.current = { x: e.clientX, y: e.clientY, fired: false, moved: false, timer: 0 };
    if (isGridLayout() || e.pointerType === "touch") {
      // long press selects the photo and shows its panel
      press.current.timer = window.setTimeout(() => {
        if (press.current) press.current.fired = true;
        setSelectedPhotoId(note.id);
      }, 450);
    }
    onStickyPointerDown(e, note);
  };

  const onPhotoPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) {
      p.moved = true;
      window.clearTimeout(p.timer);
    }
  };

  const onPhotoPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    clearPress();
    onStickyPointerUp(e);
  };

  const onPhotoClick = (note: Note) => {
    const p = press.current;
    press.current = null;
    if (p?.fired || p?.moved) return;
    if (isGridLayout()) setViewerId(note.id);
    else setSelectedPhotoId(note.id);
  };

  const openNote = (id: string) => setActiveId(id);
  useEffect(() => {
    setSelectedPhotoId(null);
    setConfirmPhotoId(null);
  }, [view]);

  useEffect(() => {
    if (!confirmPhotoId) return;
    const timer = setTimeout(() => setConfirmPhotoId(null), 5000);
    return () => clearTimeout(timer);
  }, [confirmPhotoId]);

  // Esc unselects, Delete asks to delete the selected photo
  useEffect(() => {
    if (!selectedPhotoId) return;
    const onKey = (e: KeyboardEvent) => {
      if (viewerId || activeId || friendsOpen || profileOpen || newBoardOpen || manageOpen || fullId || bgOpen) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && (t as HTMLInputElement).type === "text"));
      if (typing) return;
      if (e.key === "Escape") {
        setSelectedPhotoId(null);
        setConfirmPhotoId(null);
      } else if (e.key === "Delete") {
        e.preventDefault();
        setConfirmPhotoId(selectedPhotoId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedPhotoId, viewerId, activeId, friendsOpen, profileOpen, newBoardOpen, manageOpen, fullId, bgOpen]);

  // Ctrl+V with an image in the clipboard adds a photo
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (activeId || friendsOpen || profileOpen || viewerId || newBoardOpen || manageOpen || fullId || bgOpen) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      addPhotos(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [activeId, friendsOpen, profileOpen, viewerId, newBoardOpen, manageOpen, fullId, bgOpen, addPhotos]);

  const canDelete = (note: Note) =>
    note.user_id === userId ||
    (view === "shared" ? isBoardOwner : me?.is_admin === true);
  const canEdit = (note: Note) =>
    note.user_id === userId ||
    (view === "shared" && note.edit_mode === "members" && note.type !== "photo");
  // the author closed access while I had the sticker open -> read-only + toast
  const openNoteForRights = activeNote ?? fullNote;
  const openCan = openNoteForRights ? canEdit(openNoteForRights) : false;
  const rightsRef = useRef<{ id: string; can: boolean } | null>(null);
  useEffect(() => {
    const n = openNoteForRights;
    if (!n) {
      rightsRef.current = null;
      return;
    }
    const prev = rightsRef.current;
    if (prev && prev.id === n.id && prev.can && !openCan && n.user_id !== userId) {
      notify("Автор закрыл доступ к редактированию. Стикер открыт для просмотра", "error");
    }
    rightsRef.current = { id: n.id, can: openCan };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNoteForRights?.id, openCan]);

  const themeBtn = (
    <button
      className="theme-btn"
      onClick={onToggleTheme}
      title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
      aria-label="Переключить тему"
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="4.5" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="2.5" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="21.5" />
            <line x1="2.5" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="21.5" y2="12" />
            <line x1="5" y1="5" x2="6.7" y2="6.7" />
            <line x1="17.3" y1="17.3" x2="19" y2="19" />
            <line x1="5" y1="19" x2="6.7" y2="17.3" />
            <line x1="17.3" y1="6.7" x2="19" y2="5" />
          </g>
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" fill="currentColor" />
        </svg>
      )}
    </button>
  );

  return (
    <>
      <div className="toolbar" role="toolbar" aria-label="Панель действий">
        <span className="app-title">Стикеры</span>
        <div className="board-switch">
          <button
            className={`switch-btn ${view === "private" ? "active" : ""}`}
            onClick={() => setView("private")}
          >
            Личная
          </button>
          <button
            className={`switch-btn ${view !== "private" ? "active" : ""}`}
            onClick={openBoardsTab}
          >
            Доски
          </button>
        </div>
        <button className="tool-btn primary" onClick={createNote} disabled={loading}>
          + Новый стикер
        </button>
        <button
          className="tool-btn photo-btn"
          onClick={() => addInputRef.current?.click()}
          disabled={loading || uploadingPhoto || view === "public"}
          title={view !== "public" ? "Добавить фото" : "Фото добавляются на личную доску и на доски с друзьями"}
          aria-label="Добавить фото"
        >
          {uploadingPhoto ? <span className="fr-spinner" aria-hidden="true" /> : <ImageIcon size={18} />}
          <span className="photo-btn-label">+ Фото</span>
        </button>
        <button className="tool-btn bg-btn" onClick={() => setBgOpen(true)} title="Фон доски" aria-label="Фон доски">
          <BackgroundIcon />
          <span className="photo-btn-label">Фон</span>
        </button>
        <span className="count">{visibleNotes.length} шт.</span>
        {me?.is_admin && <span className="admin-badge">Админ</span>}
        <button
          className="friends-btn"
          onClick={() => setFriendsOpen(true)}
          title="Друзья"
          aria-label={friendsApi.incoming.length > 0 ? `Друзья, новых заявок: ${friendsApi.incoming.length}` : "Друзья"}
        >
          <FriendsIcon />
          {friendsApi.incoming.length > 0 && (
            <span className="friends-badge" aria-hidden="true">
              {friendsApi.incoming.length > 99 ? "99+" : friendsApi.incoming.length}
            </span>
          )}
        </button>
        <button className="profile-btn" onClick={() => setProfileOpen(true)} title="Профиль" aria-label="Профиль">
          <Avatar name={me?.username ?? "?"} />
        </button>
        {themeBtn}
        <button className="tool-btn" onClick={onSignOut} title="Выйти" aria-label="Выйти">
          <span aria-hidden="true">↪</span><span className="logout-label">Выйти</span>
        </button>
      </div>

      {view !== "private" && (
        <BoardChips
          boards={boardsApi.boards}
          activeId={view === "shared" ? boardId : null}
          onPick={pickBoard}
          onNew={() => setNewBoardOpen(true)}
          onManage={() => setManageOpen(true)}
        />
      )}

      <BoardBackground bg={background.bg} photoUrl={background.photoUrl} />
      <div
        className={`board${view !== "private" ? " has-chips" : ""}${background.bg.kind !== "none" ? " custom-bg" : ""}`}
        ref={boardRef}
        onPointerMove={onStickyPointerMove}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) {
            setSelectedPhotoId(null);
            setConfirmPhotoId(null);
            setFabOpen(false);
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
          if (!files.length) return;
          e.preventDefault();
          addPhotos(files);
        }}
      >
        {error && (
          <div className="board-toast" role="status">
            <span className="board-toast-icon" aria-hidden="true">!</span>
            <span>{error}</span>
            <button className="board-toast-close" onClick={() => setError(null)} aria-label="Закрыть уведомление">×</button>
          </div>
        )}

        {authorFilter && (
          <div className="author-chip">
            <span>Доска: {authorFilter.username}</span>
            <button onClick={() => setAuthorFilter(null)} aria-label="Показать все стикеры общей доски">×</button>
          </div>
        )}

        {loading && notes.length === 0 && (
          <div className="empty-hint">
            <div className="big">Загрузка…</div>
          </div>
        )}

        {!loading && visibleNotes.length === 0 && (
          <div className="empty-hint">
            <div className="big">
              {authorFilter
                ? `У ${authorFilter.username} пока нет стикеров`
                : view === "private" ? "Личная доска пустая" : view === "shared" ? `Доска «${activeBoard?.name ?? ""}» пустая` : "Общая доска пустая"}
            </div>
            {!authorFilter && <div>Нажмите «+ Новый стикер», чтобы начать</div>}
          </div>
        )}

        {visibleNotes.map((note) => {
          if (note.type === "photo" && note.image_url) {
            const selected = selectedPhotoId === note.id;
            return (
              <div
                key={note.id}
                data-photo-id={note.id}
                className={`sticky photo-card${selected ? " selected" : ""}`}
                style={{
                  ["--note-x" as string]: `${note.pos_x}px`,
                  ["--note-y" as string]: `${note.pos_y}px`,
                  ["--photo-w" as string]: `${note.width ?? PHOTO_DEFAULT_W}px`,
                }}
                onPointerDown={(e) => onPhotoPointerDown(e, note)}
                onPointerMove={onPhotoPointerMove}
                onPointerUp={onPhotoPointerUp}
                onPointerCancel={clearPress}
                onClick={() => onPhotoClick(note)}
                onDoubleClick={() => {
                  if (!isGridLayout()) setViewerId(note.id);
                }}
                onContextMenu={(e) => e.preventDefault()}
              >
                <div className={`pc-paper${view === "shared" ? " with-author" : ""}`} style={{ transform: `rotate(${photoTilt(note.id)}deg)` }}>
                  <PhotoFrame url={note.image_url} aspect={note.aspect ?? 1} caption={note.caption} />
                  {view === "shared" && note.user_id && profiles[note.user_id] && (
                    <div className="pc-author">— {profiles[note.user_id].username}</div>
                  )}
                  {selected && note.user_id === userId && <PhotoResizeHandle width={note.width ?? PHOTO_DEFAULT_W} onWidth={(w) => setPhotoWidth(note.id, w)} />}
                </div>
              </div>
            );
          }
          const author = note.user_id ? profiles[note.user_id] : null;
          const photos = note.photos && note.photos.length > 0
            ? note.photos
            : defaultPhotosFromLegacy(note.image_path, imageUrl(note.image_path));
          const thumb = photos[0] ?? null;
          return (
            <div
              key={note.id}
              className="sticky"
              style={{
                ["--note-x" as string]: `${note.pos_x}px`,
                ["--note-y" as string]: `${note.pos_y}px`,
                background: NOTE_COLOR_HEX[note.color],
                ["--rot" as string]: `${randomTilt()}deg`,
                transform: `rotate(${randomTilt()}deg)`,
                fontFamily: FONT_STACK[note.font],
              }}
              onPointerDown={(e) => onStickyPointerDown(e, note)}
              onPointerUp={onStickyPointerUp}
              onClick={() => openNote(note.id)}
            >
              <button
                type="button"
                className="sticky-expand"
                aria-label="Развернуть на весь экран"
                title="На весь экран"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setFullId(note.id);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
                </svg>
              </button>
              {thumb && (
                <div className="sticky-photo-wrap">
                  <div
                    className="sticky-photo"
                    style={{
                      left: `${thumb.x}%`,
                      top: `${thumb.y}%`,
                      width: `${thumb.width}%`,
                    }}
                  >
                    <div className="photo-skeleton" />
                    <img
                      src={thumb.url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        const skel = img.previousElementSibling;
                        if (skel) skel.classList.add("hidden");
                        img.style.opacity = "1";
                      }}
                      onError={(e) => {
                        const img = e.currentTarget;
                        img.style.display = "none";
                        const skel = img.previousElementSibling;
                        if (skel) skel.classList.add("hidden");
                      }}
                      style={{ opacity: "0", transition: "opacity 200ms ease-out" }}
                    />
                  </div>
                  <svg className="sticky-photo-indicator" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <circle cx="9" cy="10" r="1.5" fill="currentColor" stroke="none" />
                    <path d="M3 17l5-4 4 3 3-2 6 4" />
                  </svg>
                </div>
              )}
              <h3 className="sticky-title">{note.title || "Без названия"}</h3>
              {preview(note.body) && <p className="sticky-preview">{preview(note.body)}</p>}
              <div className="sticky-foot">
                <span className="sticky-time">{formatTime(note.created_at)}</span>
                {view !== "private" && author && (
                  <span className="sticky-author">— {author.username}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {fullNote && (
        <NoteFullscreen
          key={fullNote.id}
          note={fullNote}
          canEdit={canEdit(fullNote)}
          canDelete={canDelete(fullNote)}
          onClose={() => setFullId(null)}
          onChange={(patch) => updateNote(fullNote.id, patch)}
          onDelete={() => {
            const id = fullNote.id;
            setFullId(null);
            deleteNote(id);
          }}
        />
      )}
      {activeNote && (
        <NoteEditor
          note={activeNote}
          canEdit={canEdit(activeNote)}
          isAuthor={activeNote.user_id === userId}
          showAccess={view === "shared" && activeNote.user_id === userId && activeNote.type !== "photo"}
          editMode={activeNote.edit_mode ?? "author"}
          onEditMode={(m) => updateNote(activeNote.id, { edit_mode: m })}
          canDelete={canDelete(activeNote)}
          onClose={() => setActiveId(null)}
          onChange={(patch) => updateNote(activeNote.id, patch)}
          onDelete={() => deleteNote(activeNote.id)}
        />
      )}
      {selectedPhoto && !viewerId && !activeNote && (
        <PhotoPanel
          key={selectedPhoto.id}
          note={selectedPhoto}
          confirming={confirmPhotoId === selectedPhoto.id}
          onConfirming={(v) => setConfirmPhotoId(v ? selectedPhoto.id : null)}
          onWidth={(w) => setPhotoWidth(selectedPhoto.id, w)}
          onCaption={(c) => setPhotoCaption(selectedPhoto.id, c)}
          onReplace={() => {
            replaceTarget.current = selectedPhoto.id;
            replaceInputRef.current?.click();
          }}
          onOpen={() => setViewerId(selectedPhoto.id)}
          onDelete={() => deletePhoto(selectedPhoto)}
          canEdit={selectedPhoto.user_id === userId}
          canDelete={canDelete(selectedPhoto)}
        />
      )}
      {viewerId && viewerPhotos.some((p) => p.id === viewerId) && (
        <PhotoViewer photos={viewerPhotos} startId={viewerId} onClose={() => setViewerId(null)} />
      )}
      <input
        ref={addInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) addPhotos(files);
        }}
      />
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          const target = notes.find((n) => n.id === replaceTarget.current);
          if (file && target) replacePhoto(file, target);
        }}
      />
      {!activeNote && !friendsOpen && !profileOpen && !newBoardOpen && !manageOpen && !fullId && !bgOpen && !viewerId && !selectedPhoto && (
        <div className="fab-wrap">
          {fabOpen && <div className="fab-backdrop" onClick={() => setFabOpen(false)} />}
          {fabOpen && (
            <div className="fab-menu" role="menu">
              <button
                role="menuitem"
                className="fab-item"
                onClick={() => {
                  setFabOpen(false);
                  createNote();
                }}
              >
                Новый стикер
              </button>
              <button
                role="menuitem"
                className="fab-item"
                onClick={() => {
                  setFabOpen(false);
                  setBgOpen(true);
                }}
              >
                <BackgroundIcon /> Фон
              </button>
              {view !== "public" && (
                <button
                  role="menuitem"
                  className="fab-item"
                  onClick={() => {
                    setFabOpen(false);
                    addInputRef.current?.click();
                  }}
                >
                  <ImageIcon size={18} /> Фото
                </button>
              )}
            </div>
          )}
          <button
            className={`fab ${fabOpen ? "open" : ""}`}
            onClick={() => setFabOpen((v) => !v)}
            aria-label={fabOpen ? "Закрыть меню" : "Добавить стикер или фото"}
            aria-expanded={fabOpen}
          >
            {uploadingPhoto ? <span className="fr-spinner" aria-hidden="true" /> : "+"}
          </button>
        </div>
      )}
      {bgOpen && <BackgroundDialog api={background} onClose={() => setBgOpen(false)} notify={notify} />}
      {newBoardOpen && (
        <NewBoardDialog
          friends={friendsApi}
          boards={boardsApi}
          notify={notify}
          onClose={() => setNewBoardOpen(false)}
          onCreated={(id) => {
            setNewBoardOpen(false);
            pickBoard(id);
          }}
        />
      )}
      {manageOpen && activeBoard && (
        <BoardDialog
          board={activeBoard}
          userId={userId}
          friends={friendsApi}
          boards={boardsApi}
          notify={notify}
          onClose={() => setManageOpen(false)}
          onGone={() => {
            setManageOpen(false);
            pickBoard(null);
          }}
        />
      )}
      {friendsOpen && (
        <FriendsDialog
          api={friendsApi}
          onClose={() => setFriendsOpen(false)}
          notify={notify}
          onOpenBoard={openFriendBoard}
        />
      )}
      {profileOpen && (
        <ProfileDialog
          username={me?.username ?? ""}
          api={friendsApi}
          onClose={() => setProfileOpen(false)}
          notify={notify}
        />
      )}
      <ToastView toast={toast} onClose={() => setToast(null)} />
    </>
  );
}

// signature of the parts of a sticker that people edit (used to tell my own echoes from others' edits)
function textSig(n: Pick<Note, "title" | "body" | "color" | "font">): string {
  return JSON.stringify([n.title, n.body, n.color, n.font]);
}

// ---------- note editor ----------
interface NoteEditorProps {
  note: Note;
  canEdit: boolean;
  isAuthor: boolean;
  showAccess: boolean;
  editMode: EditMode;
  onEditMode: (m: EditMode) => void;
  canDelete: boolean;
  onClose: () => void;
  onChange: (patch: Partial<Pick<Note, "title" | "body" | "color" | "font" | "photos">>) => void;
  onDelete: () => void;
}

function NoteEditor({ note, canEdit, isAuthor, showAccess, editMode, onEditMode, canDelete, onClose, onChange, onDelete }: NoteEditorProps) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [color, setColor] = useState<NoteColor>(note.color);
  const [font, setFont] = useState<NoteFont>(note.font);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving">("saved");
  const [showSaved, setShowSaved] = useState(false);
  const [photoSelected, setPhotoSelected] = useState(false);
  const [fullscreenPhoto, setFullscreenPhoto] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [photo, setPhoto] = useState<NotePhoto | null>(() => {
    const existing =
      note.photos && note.photos.length > 0
        ? note.photos
        : defaultPhotosFromLegacy(note.image_path, imageUrl(note.image_path));
    return existing[0] ?? null;
  });

  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
    setColor(note.color);
    setFont(note.font);
    const existing =
      note.photos && note.photos.length > 0
        ? note.photos
        : defaultPhotosFromLegacy(note.image_path, imageUrl(note.image_path));
    setPhoto(existing[0] ?? null);
    setConfirmDelete(false);
    setEditorError(null);
    setPhotoSelected(false);
  }, [note.id, note.title, note.body, note.color, note.font, note.image_path, note.photos]);

  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  useEffect(() => {
    const textarea = bodyRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxHeight = window.innerHeight * 0.4;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, [body]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateViewportHeight = () => document.documentElement.style.setProperty("--visual-height", `${viewport.height}px`);
    updateViewportHeight();
    viewport.addEventListener("resize", updateViewportHeight);
    return () => viewport.removeEventListener("resize", updateViewportHeight);
  }, []);

  useEffect(() => {
    if (!showSaved) return;
    const t = setTimeout(() => setShowSaved(false), 2000);
    return () => clearTimeout(t);
  }, [showSaved]);

  // debounced save (600ms)
  useEffect(() => {
    const initialExisting =
      note.photos && note.photos.length > 0
        ? note.photos
        : defaultPhotosFromLegacy(note.image_path, imageUrl(note.image_path));
    const initialPhoto = initialExisting[0] ?? null;
    const photoChanged = isAuthor && JSON.stringify(photo) !== JSON.stringify(initialPhoto);
    if (
      title === note.title &&
      body === note.body &&
      color === note.color &&
      font === note.font &&
      !photoChanged
    )
      return;
    setSaveStatus("saving");
    const t = setTimeout(() => {
      onChange(isAuthor ? { title, body, color, font, photos: photo ? [photo] : [] } : { title, body, color, font });
      setSaveStatus("saved");
      setShowSaved(true);
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, body, color, font, photo]);

  const replacePhoto = async (file: File) => {
    if (!canEdit || !isAuthor || !photo) return;
    setUploading(true);
    setEditorError(null);
    try {
      const newPhoto = await uploadPhoto(file, note.user_id ?? "anon", note.id);
      removePhotoPaths([photo.path]);
      setPhoto({ ...newPhoto, x: photo.x, y: photo.y, width: photo.width });
    } catch (e) {
      console.error(e);
      setEditorError("Не удалось заменить фото");
    } finally {
      setUploading(false);
    }
  };

  const updatePhoto = useCallback((patch: Partial<NotePhoto>) => {
    setPhoto((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const deletePhoto = useCallback(() => {
    setPhoto((prev) => {
      if (prev) removePhotoPaths([prev.path]);
      return null;
    });
    setPhotoSelected(false);
  }, []);

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="note-paper"
        ref={paperRef}
        style={{ background: NOTE_COLOR_HEX[color], fontFamily: FONT_STACK[font] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="note-scroll">
          <input
            className="title-input"
            value={title}
            placeholder="Заголовок стикера…"
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            readOnly={!canEdit}
          />
          <div className="note-canvas">
            <textarea
              className="body-input"
              value={body}
              placeholder={canEdit ? "Напишите заметку…" : "Чужая заметка — только просмотр"}
              ref={bodyRef}
              onChange={(e) => setBody(e.target.value)}
              readOnly={!canEdit}
            />
            {photo && (
              <PhotoLayer
                photo={photo}
                selected={photoSelected}
                canEdit={canEdit && isAuthor}
                onSelect={() => setPhotoSelected(true)}
                onDeselect={() => setPhotoSelected(false)}
                onChange={updatePhoto}
                onDelete={deletePhoto}
                onReplace={() => fileInputRef.current?.click()}
                onFullscreen={() => setFullscreenPhoto(photo.url)}
              />
            )}
            {uploading && <div className="photo-progress">Обработка фото…</div>}
          </div>

          {editorError && <div className="login-error">{editorError}</div>}

          <div className="picker-group">
            <div className="color-picker">
              {NOTE_COLORS.map((c) => (
                <button
                  key={c}
                  className={`color-dot ${c === color ? "active" : ""}`}
                  style={{ background: NOTE_COLOR_HEX[c] }}
                  onClick={() => canEdit && setColor(c)}
                  disabled={!canEdit}
                  aria-label={`Цвет ${c}`}
                  aria-pressed={c === color}
                />
              ))}
            </div>
            <div className="font-picker">
              {NOTE_FONTS.map((f) => (
                <button
                  key={f}
                  className={`font-dot ${f === font ? "active" : ""}`}
                  style={{ fontFamily: FONT_STACK[f] }}
                  onClick={() => canEdit && setFont(f)}
                  disabled={!canEdit}
                  title={NOTE_FONT_LABEL[f]}
                  aria-label={`Шрифт ${NOTE_FONT_LABEL[f]}`}
                  aria-pressed={f === font}
                >
                  Aa
                </button>
              ))}
            </div>
          </div>

          {showAccess && (
            <div className="access-group" role="radiogroup" aria-label="Кто может править стикер">
              <span className="access-label">Правка</span>
              {([
                ["author", "Только я", "M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z"],
                ["members", "Я и участники", "M16 11a3 3 0 100-6 3 3 0 000 6zM8 12a3 3 0 100-6 3 3 0 000 6zM2 20v-1a5 5 0 015-5h2a5 5 0 015 5v1M15 14.2a5 5 0 017 4.8v1"],
              ] as const).map(([mode, label, icon]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={editMode === mode}
                  className={`access-btn ${editMode === mode ? "active" : ""}`}
                  onClick={() => editMode !== mode && onEditMode(mode)}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg>
                  {label}
                </button>
              ))}
            </div>
          )}

          {photo && photoSelected && canEdit && isAuthor && (
            <div className="photo-size-controls">
              <span className="size-label">Размер</span>
              {([["small", 40, "Мал"], ["medium", 70, "Сред"], ["large", 95, "Большое"]] as const).map(([key, value, label]) => (
                <button
                  key={key}
                  className={`image-size-btn ${Math.round(photo.width) === value ? "active" : ""}`}
                  onClick={() => updatePhoto({ width: value })}
                >
                  {label}
                </button>
              ))}
              <input
                className="mobile-image-range"
                type="range"
                min={20}
                max={100}
                value={Math.round(photo.width)}
                onChange={(e) => updatePhoto({ width: Number(e.target.value) })}
                aria-label="Размер фото"
              />
            </div>
          )}
        </div>

        <div className="paper-foot">
          <div className="paper-actions">
            {canEdit && isAuthor && photo && (
              <input
                type="file"
                accept="image/*"
                hidden
                ref={fileInputRef}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) replacePhoto(f);
                  e.target.value = "";
                }}
              />
            )}
            {canDelete && (
              confirmDelete ? (
                <div className="delete-confirm" role="alertdialog" aria-label="Подтверждение удаления">
                  <span>Удалить стикер?</span>
                  <button className="delete-cancel" onClick={() => setConfirmDelete(false)}>Отмена</button>
                  <button className="btn-danger-confirm" onClick={onDelete}>Удалить</button>
                </div>
              ) : (
                <button className="btn-danger" onClick={() => setConfirmDelete(true)}>
                  Удалить
                </button>
              )
            )}
          </div>
          <div className="paper-actions paper-actions-right">
            {showSaved && <span className="save-status" aria-live="polite">Сохранено ✓</span>}
            <button className="btn-ghost" onClick={onClose}>
              Готово
            </button>
          </div>
        </div>
      </div>
      {fullscreenPhoto && (
        <div className="image-viewer" onClick={() => setFullscreenPhoto(null)}>
          <button className="image-viewer-close" onClick={() => setFullscreenPhoto(null)} aria-label="Закрыть фото">✕</button>
          <img src={fullscreenPhoto} alt="Фото стикера" loading="lazy" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

// ---------- auth screen ----------
type SupabaseAuthError = { message?: string; code?: string; status?: number };

function supabaseErrorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as SupabaseAuthError).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Неизвестная ошибка сервера";
}

function friendlyAuthError(error: unknown): string {
  const raw = supabaseErrorText(error).toLowerCase();
  if (raw.includes("already registered") || raw.includes("already exists") || raw.includes("user_already_exists")) {
    return "Этот email уже зарегистрирован";
  }
  if (raw.includes("rate limit") || raw.includes("too many") || raw.includes("email rate")) {
    return "Слишком много попыток. Подождите немного и попробуйте снова";
  }
  if (raw.includes("invalid login credentials")) return "Неверный email или пароль";
  if (raw.includes("password") && (raw.includes("6") || raw.includes("short"))) return "Пароль должен содержать минимум 6 символов";
  if (raw.includes("profiles_username_lower_key") || raw.includes("duplicate key") || raw.includes("unique")) {
    return "Этот ник уже занят";
  }
  if (raw.includes("email not confirmed")) return "Подтвердите email по ссылке из письма, затем войдите снова";
  return "Не удалось завершить операцию. Проверьте данные и попробуйте снова";
}

interface AuthScreenProps {
  theme: Theme;
  onToggleTheme: () => void;
}

function AuthScreen({ theme, onToggleTheme }: AuthScreenProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const showFailure = (failure: unknown, field: "email" | "username" | "password" | "general") => {
    const actualMessage = supabaseErrorText(failure);
    const friendlyMessage = friendlyAuthError(failure);
    console.error("Стикеры: ошибка авторизации", failure);
    setRawError(actualMessage);
    setError(field === "general" ? friendlyMessage : null);
    setEmailError(field === "email" ? friendlyMessage : null);
    setUsernameError(field === "username" ? friendlyMessage : null);
    setPasswordError(field === "password" ? friendlyMessage : null);
    setShake(false);
    requestAnimationFrame(() => setShake(true));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setEmailError(null);
    setUsernameError(null);
    setPasswordError(null);
    setRawError(null);
    setInfo(null);

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username.trim().replace(/\s+/g, " ");

    if (!normalizedEmail) {
      setEmailError("Введите email");
      return;
    }
    if (mode === "register" && !normalizedUsername) {
      setUsernameError("Введите ник");
      return;
    }
    if (password.length < 6) {
      setPasswordError("Пароль должен содержать минимум 6 символов");
      return;
    }

    setBusy(true);
    try {
      if (mode === "register") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: { data: { username: normalizedUsername } },
        });
        if (signUpError) {
          showFailure(signUpError, "email");
          return;
        }
        if (!data.user) {
          showFailure(new Error("Supabase не вернул созданного пользователя"), "general");
          return;
        }

        if (data.session) {
          const { error: profileError } = await supabase.rpc("register_profile", {
            p_username: normalizedUsername,
          });
          if (profileError) {
            await supabase.auth.signOut();
            showFailure(profileError, "username");
            return;
          }
          localStorage.removeItem("pending-sticky-profile");
          setInfo("Аккаунт создан. Открываем вашу доску…");
        } else {
          localStorage.setItem("pending-sticky-profile", JSON.stringify({ username: normalizedUsername }));
          setInfo("Аккаунт создан. Проверьте почту и перейдите по ссылке подтверждения, затем войдите снова.");
          setMode("login");
          setPassword("");
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: normalizedEmail,
          password,
        });
        if (signInError) {
          showFailure(signInError, "general");
          return;
        }

        const pendingProfile = localStorage.getItem("pending-sticky-profile");
        if (pendingProfile) {
          const parsed = JSON.parse(pendingProfile) as { username?: string };
          if (parsed.username) {
            const { error: profileError } = await supabase.rpc("register_profile", {
              p_username: parsed.username,
            });
            if (profileError) {
              await supabase.auth.signOut();
              showFailure(profileError, "username");
              return;
            }
            localStorage.removeItem("pending-sticky-profile");
          }
        }
      }
    } catch (failure) {
      showFailure(failure, "general");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <button
        className="theme-btn login-theme-btn"
        onClick={onToggleTheme}
        title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
        aria-label="Переключить тему"
      >
        {theme === "dark" ? (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <circle cx="12" cy="12" r="4.5" fill="currentColor" />
            <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="2.5" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="21.5" />
              <line x1="2.5" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="21.5" y2="12" />
              <line x1="5" y1="5" x2="6.7" y2="6.7" />
              <line x1="17.3" y1="17.3" x2="19" y2="19" />
              <line x1="5" y1="19" x2="6.7" y2="17.3" />
              <line x1="17.3" y1="6.7" x2="19" y2="5" />
            </g>
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" fill="currentColor" />
          </svg>
        )}
      </button>

      <form className={`login-card ${shake ? "shake" : ""}`} onSubmit={submit}>
        <div className="login-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="34" height="34">
            <rect x="4" y="6" width="16" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M8 6V5a4 4 0 0 1 8 0v1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="12" y1="12" x2="12" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        <h1 className="login-title">Стикеры</h1>
        <p className="login-subtitle">
          {mode === "login" ? "Войдите в аккаунт" : "Создайте аккаунт для личной доски"}
        </p>

        {mode === "register" && (
          <label className="login-field">
            <span>Ник</span>
            <input
              type="text"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setUsernameError(null); setRawError(null); }}
              placeholder="Ваш ник на общей доске"
              maxLength={24}
              autoFocus
              aria-invalid={Boolean(usernameError)}
            />
            {usernameError && <span className="field-error">{usernameError}</span>}
          </label>
        )}

        <label className="login-field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setEmailError(null); setRawError(null); }}
            autoComplete="email"
            placeholder="you@example.com"
            autoFocus={mode === "login"}
            inputMode="email"
            aria-invalid={Boolean(emailError)}
          />
          {emailError && <span className="field-error">{emailError}</span>}
        </label>

        <label className="login-field">
          <span>Пароль</span>
          <div className="password-wrap">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setPasswordError(null); setRawError(null); }}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={mode === "login" ? "Пароль" : "Минимум 6 символов"}
              minLength={6}
              aria-invalid={Boolean(passwordError)}
            />
            <button type="button" className="password-toggle" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}>
              {showPassword ? "◉" : "◌"}
            </button>
          </div>
          {passwordError && <span className="field-error">{passwordError}</span>}
        </label>

        {error && <div className="login-error">{error}</div>}
        {rawError && <div className="technical-error">Техническая причина: {rawError}</div>}
        {info && <div className="login-info">{info}</div>}

        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? "Подождите…" : mode === "login" ? "Войти" : "Зарегистрироваться"}
        </button>

        <div className="login-divider">
          <span>или</span>
        </div>

        <button
          type="button"
          className="login-public-btn"
          onClick={() => setMode((m) => (m === "login" ? "register" : "login"))}
        >
          {mode === "login" ? "Нет аккаунта? Регистрация" : "Уже есть аккаунт? Войти"}
        </button>
      </form>
    </div>
  );
}
