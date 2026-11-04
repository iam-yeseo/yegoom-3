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
  SpeettoResponse, SpeettoPurchaseInput, SlotResponse, SlotSpinInput,
  CatchmindAction, CatchmindInput, CatchmindResponse, CatchmindPollResponse, CatchmindGalleryResponse,
  ClawResponse, ClawPlayInput, ClawCoinInput,
  LaunchGiftResponse, LuckPhotoResponse, PasswordChangeInput, RankingResponse,
} from "../shared/types";
import type { RankingPeriod } from "../shared/ranking-periods";
import type { ArtKey } from "../shared/characters";
import type { AdminState, AdminClawConfig, PredictionRules } from "../shared/admin";

export class ApiFailure extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
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
      (body as ApiError | null)?.error?.code,
    );
  return body as T;
}
export const api = {
  admin: () => request<AdminState>("/admin"),
  saveGameSettings: (id: GameId, rules: PredictionRules, effectiveFrom: string, expectedUserId: string) => request<AdminState>(`/admin/games/${id}`, {
    method: "PUT", body: JSON.stringify({ rules, effectiveFrom, expectedUserId }),
  }),
  saveClawSettings: (config: AdminClawConfig, expectedUserId: string) => request<AdminState>("/admin/claw", {
    method: "PUT", body: JSON.stringify({ ...config, expectedUserId }),
  }),
  updateProfile: (displayName: string, expectedUserId: string) => request<AuthResponse>("/me/profile", { method: "PUT", body: JSON.stringify({ displayName, expectedUserId }) }),
  uploadProfilePhoto: (photo: string, expectedUserId: string) => request<AuthResponse>("/me/photo", { method: "PUT", body: JSON.stringify({ photo, expectedUserId }) }),
  deleteProfilePhoto: (expectedUserId: string) => request<AuthResponse>("/me/photo", { method: "DELETE", body: JSON.stringify({ expectedUserId }) }),
  uploadLuckPhoto: (roundDate: string, image: string) => request<LuckPhotoResponse>("/games/luck/photo", { method: "PUT", body: JSON.stringify({ roundDate, image }) }),
  launchGift: () => request<LaunchGiftResponse>("/events/launch-gift", { method: "POST", body: "{}" }),
  claw: () => request<ClawResponse>("/claw"),
  buyClawCoins: (input: ClawCoinInput) => request<ClawResponse>("/claw/coins", { method: "POST", body: JSON.stringify(input) }),
  playClaw: (input: ClawPlayInput) => request<ClawResponse>("/claw/play", { method: "POST", body: JSON.stringify(input) }),
  catchmind: (since?: number) => request<CatchmindPollResponse>(`/catchmind${since === undefined ? "" : `?since=${since}`}`),
  catchmindGallery: (before?: number) => request<CatchmindGalleryResponse>(`/catchmind/gallery${before === undefined ? "" : `?before=${before}`}`),
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
  slot: () => request<SlotResponse>("/shop/slot"),
  buyKuji: (input: KujiPurchaseInput) => request<KujiResponse>("/shop/kuji", { method: "POST", body: JSON.stringify(input) }),
  buyLotto: (input: LottoPurchaseInput) => request<LottoResponse>("/shop/lotto", { method: "POST", body: JSON.stringify(input) }),
  buySpeetto: (input: SpeettoPurchaseInput) => request<SpeettoResponse>("/shop/speetto", { method: "POST", body: JSON.stringify(input) }),
  spinSlot: (input: SlotSpinInput) => request<SlotResponse>("/shop/slot", { method: "POST", body: JSON.stringify(input) }),
  history: (id: GameId) => request<HistoryResponse>(`/games/${id}/history`),
  wake: (roundDate: string) => request<GameResponse>("/games/wake/wake", {
    method: "POST",
    body: JSON.stringify({ roundDate }),
  }),
  bootstrap: () => request<BootstrapResponse>("/bootstrap"),
  ranking: (period: RankingPeriod, before?: string) => request<RankingResponse>(`/ranking?period=${period}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  changePassword: (input: PasswordChangeInput) => request<{ ok: true }>("/me/password", {
    method: "PUT", body: JSON.stringify(input),
  }),
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
