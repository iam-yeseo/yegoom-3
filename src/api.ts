import type {
  ApiError,
  AuthResponse,
  BootstrapResponse,
  GameId,
  GameResponse,
} from "../shared/types";

export class ApiFailure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!navigator.onLine)
    throw new ApiFailure(
      0,
      "인터넷 연결을 확인해 주세요. 입력한 내용은 아직 저장되지 않았어요.",
    );
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiFailure(0, "연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiFailure(
      response.status,
      (body as ApiError | null)?.error?.message ??
        "요청을 처리하지 못했어요. 다시 시도해 주세요.",
    );
  return body as T;
}
export const api = {
  bootstrap: () => request<BootstrapResponse>("/bootstrap"),
  login: (username: string, password: string) =>
    request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  predict: (id: GameId, value: string, roundDate: string) =>
    request<GameResponse>(`/games/${id}/prediction`, {
      method: "PUT",
      body: JSON.stringify({ value, roundDate }),
    }),
  answer: (id: GameId, value: string, hint: string, roundDate: string) =>
    request<GameResponse>(`/games/${id}/answer`, {
      method: "PUT",
      body: JSON.stringify({ value, hint, roundDate }),
    }),
  reveal: (id: GameId, roundDate: string) =>
    request<GameResponse>(`/games/${id}/reveal`, {
      method: "POST",
      body: JSON.stringify({ roundDate }),
    }),
};
