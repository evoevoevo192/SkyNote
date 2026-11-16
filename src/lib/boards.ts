import { useCallback, useMemo } from "react";
import { supabase } from "./supabase";
import { local, useTable } from "./localdb";
import { useOnline, isOnline, refreshBoards } from "./sync";
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

const NO_NET = "Нет сети. Доски с друзьями можно менять только онлайн";

/**
 * Shared boards I belong to + their members, from the local database (the last known state is shown
 * without a network). Creating and changing boards needs the network: those actions are not queued.
 */
export function useBoards(userId: string) {
  void userId;
  const boardRows = useTable(local.boards);
  const memberRows = useTable(local.members);
  const profileRows = useTable(local.profiles);
  const metaRows = useTable(local.meta);
  const online = useOnline();
  const boards = useMemo(() => boardRows.slice().sort((a, b) => (a.created_at > b.created_at ? 1 : -1)), [boardRows]);
  const members = useMemo<BoardMember[]>(() => memberRows.map((m) => ({ board_id: m.board_id, user_id: m.user_id })), [memberRows]);
  const names = useMemo<Names>(() => Object.fromEntries(profileRows.map((p) => [p.id, p.username])), [profileRows]);
  // the list is "loading" only until the first successful synchronisation on this device
  const loading = !metaRows.some((m) => m.key === "lastSync") && online;

  const reload = useCallback(async () => {
    await refreshBoards();
  }, []);

  const create = useCallback(
    async (name: string, friendIds: string[]): Promise<{ id?: string; error: string | null }> => {
      if (!isOnline()) return { error: NO_NET };
      const { data, error } = await supabase.rpc("create_board", { p_name: name, p_friends: friendIds });
      if (error) {
        console.error(error);
        return { error: boardsErrorText(error) };
      }
      await refreshBoards();
      return { id: data as string, error: null };
    },
    []
  );

  const act = useCallback(
    async (fn: () => PromiseLike<{ error: unknown }>): Promise<string | null> => {
      if (!isOnline()) return NO_NET;
      const { error } = await fn();
      if (error) {
        console.error(error);
        return boardsErrorText(error);
      }
      await refreshBoards();
      return null;
    },
    []
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
