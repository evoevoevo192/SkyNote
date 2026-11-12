import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import type { BoardInfo, BoardMember } from "./supabase";

export function boardsErrorText(error: unknown): string {
  const m =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : "";
  if (m.includes("BAD_NAME")) return "Название: от 1 до 40 символов";
  if (m.includes("TOO_MANY_MEMBERS")) return "На доске может быть не больше 7 друзей";
  if (m.includes("NOT_FRIEND")) return "Добавлять можно только друзей";
  if (m.includes("ALREADY_MEMBER")) return "Этот человек уже на доске";
  if (m.includes("NOT_OWNER")) return "Это может делать только владелец доски";
  return "Не удалось выполнить действие. Попробуйте ещё раз";
}

type Names = Record<string, string>;

/**
 * Shared boards I belong to + their members. Kept fresh with Realtime
 * (boards / board_members) and re-read on window focus as a safety net.
 */
export function useBoards(userId: string) {
  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [members, setMembers] = useState<BoardMember[]>([]);
  const [names, setNames] = useState<Names>({});
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const namesRef = useRef<Names>({});
  namesRef.current = names;

  const reload = useCallback(async () => {
    try {
      const [b, m] = await Promise.all([
        supabase.from("boards").select("id, owner_id, name, created_at").order("created_at", { ascending: true }),
        supabase.from("board_members").select("board_id, user_id"),
      ]);
      if (b.error) throw b.error;
      if (m.error) throw m.error;
      const memberRows = (m.data ?? []) as BoardMember[];
      const boardRows = (b.data ?? []) as BoardInfo[];
      const missing = Array.from(new Set(memberRows.map((r) => r.user_id))).filter((id) => !namesRef.current[id]);
      const added: Names = {};
      if (missing.length) {
        const { data } = await supabase.from("profiles").select("id, username").in("id", missing);
        for (const p of (data ?? []) as { id: string; username: string }[]) added[p.id] = p.username;
      }
      if (!alive.current) return;
      setBoards(boardRows);
      setMembers(memberRows);
      if (Object.keys(added).length) setNames((prev) => ({ ...prev, ...added }));
    } catch (e) {
      console.error("Стикеры: не удалось загрузить доски", e);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    reload();
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    const channel = supabase
      .channel(`boards-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "boards" }, () => reload())
      .on("postgres_changes", { event: "*", schema: "public", table: "board_members" }, () => reload())
      .subscribe();
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
      supabase.removeChannel(channel);
    };
  }, [reload, userId]);

  const create = useCallback(
    async (name: string, friendIds: string[]): Promise<{ id?: string; error: string | null }> => {
      const { data, error } = await supabase.rpc("create_board", { p_name: name, p_friends: friendIds });
      if (error) {
        console.error(error);
        return { error: boardsErrorText(error) };
      }
      await reload();
      return { id: data as string, error: null };
    },
    [reload]
  );

  const act = useCallback(
    async (fn: () => PromiseLike<{ error: unknown }>): Promise<string | null> => {
      const { error } = await fn();
      if (error) {
        console.error(error);
        return boardsErrorText(error);
      }
      await reload();
      return null;
    },
    [reload]
  );

  const rename = useCallback(
    (id: string, name: string) => act(() => supabase.from("boards").update({ name }).eq("id", id)),
    [act]
  );
  const addMember = useCallback(
    (id: string, user: string) => act(() => supabase.rpc("add_board_member", { p_board: id, p_user: user })),
    [act]
  );
  const removeMember = useCallback(
    (id: string, user: string) =>
      act(() => supabase.from("board_members").delete().eq("board_id", id).eq("user_id", user)),
    [act]
  );
  const remove = useCallback(
    (id: string) => act(() => supabase.from("boards").delete().eq("id", id)),
    [act]
  );

  return { boards, members, names, loading, reload, create, rename, addMember, removeMember, remove };
}

export type BoardsApi = ReturnType<typeof useBoards>;
