import type {
  ApiError,
  AuthResponse,
  BootstrapResponse,
  GameId,
  GameResponse,
  HistoryResponse,
  AttendanceState,
  AttendanceClaimResponse,
  ShopState, KujiResponse, KujiPurchaseInput, LottoResponse, LottoPurchaseInput,
  SpeettoResponse, SpeettoPurchaseInput,
  CatchmindAction, CatchmindInput, CatchmindResponse,
} from "../shared/types";
import type { ArtKey } from "../shared/characters";

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
  catchmind: () => request<CatchmindResponse>("/catchmind"),
  catchmindAction: (action: CatchmindAction, input: CatchmindInput) => request<CatchmindResponse>(`/catchmind/${action}`, { method: "POST", body: JSON.stringify(input) }),
  attendance: (month: string) => request<{ attendance: AttendanceState }>(`/me/attendance?month=${encodeURIComponent(month)}`),
  claimAttendance: () => request<AttendanceClaimResponse>("/me/attendance", { method: "POST", body: "{}" }),
  character: (character: ArtKey, migrate = false, expectedUserId?: string) => request<AuthResponse>("/me/character", {
    method: "PUT", body: JSON.stringify({ character, migrate, ...(migrate ? { expectedUserId } : {}) }),
  }),
  shop: () => request<ShopState>("/shop"),
  kuji: () => request<KujiResponse>("/shop/kuji"),
  lotto: () => request<LottoResponse>("/shop/lotto"),
  speetto: () => request<SpeettoResponse>("/shop/speetto"),
  buyKuji: (input: KujiPurchaseInput) => request<KujiResponse>("/shop/kuji", { method: "POST", body: JSON.stringify(input) }),
  buyLotto: (input: LottoPurchaseInput) => request<LottoResponse>("/shop/lotto", { method: "POST", body: JSON.stringify(input) }),
  buySpeetto: (input: SpeettoPurchaseInput) => request<SpeettoResponse>("/shop/speetto", { method: "POST", body: JSON.stringify(input) }),
  history: (id: GameId) => request<HistoryResponse>(`/games/${id}/history`),
  wake: (roundDate: string) => request<GameResponse>("/games/wake/wake", {
    method: "POST",
    body: JSON.stringify({ roundDate }),
  }),
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
