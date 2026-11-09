import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";

export type FriendshipStatus = "pending" | "accepted" | "blocked";

export interface Friendship {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: FriendshipStatus;
  created_at: string;
}

export interface Person {
  id: string;
  username: string;
}

export interface FriendEntry {
  friendshipId: string;
  person: Person;
  lastActive: string | null;
}

export interface RequestEntry {
  friendshipId: string;
  person: Person;
  createdAt: string;
}

export interface SendResult {
  error: string | null;
  status?: "sent" | "accepted";
  username?: string;
}

export const MAX_REQUESTS_PER_DAY = 10;

/** Uppercases, drops everything except letters/digits, limits to 8 chars and inserts the dash: XXXX-XXXX. */
export function formatPublicIdInput(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export function friendsErrorText(error: unknown): string {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : "";
  if (message.includes("USER_NOT_FOUND")) return "Пользователь не найден";
  if (message.includes("ALREADY_SENT")) return "Заявка уже отправлена";
  if (message.includes("ALREADY_FRIENDS")) return "Вы уже друзья";
  if (message.includes("RATE_LIMIT")) {
    return `Лимит исчерпан: не больше ${MAX_REQUESTS_PER_DAY} заявок в сутки. Попробуйте завтра`;
  }
  if (message.includes("SELF")) return "Это ваш собственный ID";
  if (message.includes("YOU_BLOCKED")) {
    return "Вы заблокировали этого пользователя. Разблокируйте его в профиле";
  }
  if (message.includes("duplicate key")) return "Заявка уже отправлена";
  return "Не удалось выполнить действие. Попробуйте ещё раз";
}

export function formatLastActive(iso: string | null): string {
  if (!iso) return "Нет активности на общей доске";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "Нет активности на общей доске";
  const minutes = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (minutes < 2) return "Был(а) активен(на) только что";
  if (minutes < 60) return `Активность: ${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Активность: ${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `Активность: ${days} дн. назад`;
  return `Активность: ${new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}`;
}

export async function fetchMyPublicId(): Promise<string | null> {
  const { data, error } = await supabase.rpc("get_my_public_id");
  if (error || typeof data !== "string") return null;
  return data;
}

type MutationResult = PromiseLike<{ error: unknown }>;

export function useFriends(userId: string) {
  const [rows, setRows] = useState<Friendship[]>([]);
  const [people, setPeople] = useState<Record<string, Person>>({});
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("friendships")
        .select("id, requester_id, addressee_id, status, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      const list = (data ?? []) as Friendship[];

      const ids = Array.from(
        new Set(list.map((r) => (r.requester_id === userId ? r.addressee_id : r.requester_id)))
      );
      const nextPeople: Record<string, Person> = {};
      if (ids.length) {
        const { data: pdata } = await supabase.from("profiles").select("id, username").in("id", ids);
        for (const p of (pdata ?? []) as Person[]) nextPeople[p.id] = p;
      }

      const nextActivity: Record<string, string> = {};
      if (list.some((r) => r.status === "accepted")) {
        const { data: adata } = await supabase.rpc("friends_last_activity");
        for (const a of (adata ?? []) as { user_id: string; last_active: string }[]) {
          nextActivity[a.user_id] = a.last_active;
        }
      }

      if (!alive.current) return;
      setRows(list);
      setPeople(nextPeople);
      setActivity(nextActivity);
      setLoadError(null);
    } catch (e) {
      console.error("Стикеры: не удалось загрузить друзей", e);
      if (alive.current) setLoadError("Не удалось загрузить список друзей");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    alive.current = true;
    reload();
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(reload, 60000);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [reload]);

  const { friends, incoming, outgoing, blocked } = useMemo(() => {
    const otherOf = (r: Friendship): Person =>
      people[r.requester_id === userId ? r.addressee_id : r.requester_id] ?? {
        id: r.requester_id === userId ? r.addressee_id : r.requester_id,
        username: "Пользователь",
      };
    const friends: FriendEntry[] = [];
    const incoming: RequestEntry[] = [];
    const outgoing: RequestEntry[] = [];
    const blocked: RequestEntry[] = [];
    for (const r of rows) {
      const person = otherOf(r);
      if (r.status === "accepted") {
        friends.push({ friendshipId: r.id, person, lastActive: activity[person.id] ?? null });
      } else if (r.status === "pending") {
        const entry = { friendshipId: r.id, person, createdAt: r.created_at };
        (r.addressee_id === userId ? incoming : outgoing).push(entry);
      } else if (r.status === "blocked" && r.requester_id === userId) {
        blocked.push({ friendshipId: r.id, person, createdAt: r.created_at });
      }
    }
    friends.sort((a, b) => a.person.username.localeCompare(b.person.username, "ru"));
    return { friends, incoming, outgoing, blocked };
  }, [rows, people, activity, userId]);

  const run = useCallback(
    async (fn: () => MutationResult): Promise<string | null> => {
      try {
        const { error } = await fn();
        if (error) {
          console.error("Стикеры: ошибка действия с друзьями", error);
          return friendsErrorText(error);
        }
        await reload();
        return null;
      } catch (e) {
        console.error("Стикеры: ошибка действия с друзьями", e);
        return friendsErrorText(e);
      }
    },
    [reload]
  );

  const sendRequest = useCallback(
    async (code: string): Promise<SendResult> => {
      try {
        const { data, error } = await supabase.rpc("send_friend_request", { p_public_id: code });
        if (error) return { error: friendsErrorText(error) };
        await reload();
        const result = data as { status: "sent" | "accepted"; username: string };
        return { error: null, status: result.status, username: result.username };
      } catch (e) {
        return { error: friendsErrorText(e) };
      }
    },
    [reload]
  );

  const accept = useCallback(
    (friendshipId: string) =>
      run(() => supabase.from("friendships").update({ status: "accepted" }).eq("id", friendshipId)),
    [run]
  );

  // decline, cancel, remove friend and unblock are all "delete the row"
  const remove = useCallback(
    (friendshipId: string) => run(() => supabase.from("friendships").delete().eq("id", friendshipId)),
    [run]
  );

  const block = useCallback(
    (personId: string) => run(() => supabase.rpc("block_user", { p_user: personId })),
    [run]
  );

  return {
    friends,
    incoming,
    outgoing,
    blocked,
    loading,
    loadError,
    reload,
    sendRequest,
    accept,
    remove,
    block,
  };
}

export type FriendsApi = ReturnType<typeof useFriends>;
