/** 공지 (patch notes), shown in the notification centre's 공지 tab as posts.
 *
 * A post is written here with every game patch: what changed, in words a
 * player understands (no technical detail), newest first. Each needs a unique
 * `id` (never reused or renamed: readers' "seen" marks are kept by id), the KST
 * `date` of the patch, a short `title`, a one-line `summary` and the changes as
 * `items`. A post stays unread, and keeps the bell's badge on, until the reader
 * opens it. */
export interface Notice {
  id: string;
  /** KST date of the patch, YYYY-MM-DD. */
  date: string;
  title: string;
  summary: string;
  items: readonly { title: string; body: string }[];
}

export const NOTICES: readonly Notice[] = [
  {
    id: '2026-11-23-toilet-burst',
    date: '2026-11-23',
    title: '새 게임 「변기 폭파」가 열렸어요',
    summary: '오전·오후 한 판씩, 돌아가며 볼일을 보다가 변기가 터지는 차례인 사람이 지는 게임이에요.',
    items: [
      { title: '하루 두 판, 모두 자동 참여',
        body: '오전(0시~12시)과 오후(12시~밤 11시 50분)에 한 판씩 열려요. 오늘의 게임에서 들어갈 수 있고, 활성 플레이어는 모두 자동으로 참여해요.' },
      { title: '돌아가며 볼일 보기',
        body: '정해진 순서대로 한 명씩 볼일을 보고 물을 내려요. 첫 차례는 판마다 한 칸씩 돌아가요(1-2-3 → 2-3-1 → 3-1-2).' },
      { title: '갈수록 아슬아슬',
        body: '변기는 참가자 수 × 3번 안에 반드시 한 번 터지고, 물을 내릴수록 다음에 터질 확률이 올라가요. 화면의 수위와 확률을 보며 마음의 준비를 하세요.' },
      { title: '점수',
        body: '터진 차례의 사람은 10점을 잃고, 나머지는 모두 5점을 받아요. 판이 끝날 때까지 안 터지면 그 판은 무효예요.' },
      { title: '자리를 비우면',
        body: '차례가 10분 넘게 멈춰 있으면 다른 사람이 대신 누를 수 있어요. 대신 누르다 터져도 원래 차례인 사람이 져요.' },
    ],
  },
  {
    id: '2026-11-23-touch-and-text',
    date: '2026-11-23',
    title: '작은 버튼이 더 잘 눌려요',
    summary: '누르기 어렵던 작은 버튼과 낱말 중간에서 끊기던 안내 글을 다듬었어요.',
    items: [
      { title: '작은 버튼을 넉넉하게',
        body: '뒤로 가기, 출석 달력의 달 넘기기, 홈의 "전체", 로또 "자동", 주식 뉴스의 종목 이름, 캐치마인드 오답 칸, 게임 방법 펼치기는 이제 주변을 눌러도 반응해요. 보이는 모양과 크기는 그대로예요.' },
      { title: '안내 글 줄바꿈',
        body: '게임 방법과 안내 글이 낱말 중간에서 끊기지 않고 낱말 단위로 줄이 바뀌어요.' },
      { title: '버튼 눌림 맞춤',
        body: '홈의 종 버튼과 게임 화면 아래 큰 버튼이 누를 때 유난히 많이 움츠러들던 것을 다른 버튼과 같게 맞췄어요.' },
      { title: '살짝만 눌리는 버튼',
        body: '작은 버튼을 누를 때 움츠러드는 정도를 조금 줄였어요.' },
      { title: '글과 사진 정돈',
        body: '안내 글 마지막 줄에 낱말 하나만 덩그러니 남지 않게 했고, 프로필 사진 가장자리에 옅은 테두리를 둘러 밝은 사진도 또렷하게 보여요.' },
      { title: '창이 부드럽게 닫혀요',
        body: '확인 창이나 아래에서 올라오는 창을 닫으면 툭 사라지지 않고 살짝 내려가며 사라져요.' },
    ],
  },
  {
    id: '2026-11-20-arcade-rules',
    date: '2026-11-20',
    title: '자유투·컬링·승부차기 규칙이 바뀌었어요',
    summary: '혼자 하기 게임 세 종의 규칙 변경과 공지 게시판, 고정된 상단 바 소식이에요.',
    items: [
      { title: '자유투 대결 — 30초 동안 마음껏',
        body: '10구 제한이 사라졌어요. 첫 공을 잡는 순간부터 30초 동안 계속 던질 수 있고, 던진 공이 날아가는 동안 다음 공이 바로 손에 들어와요. 넣은 공 1개마다 0.5점이에요(30골이면 15점). 골드는 그대로 1골마다 5G예요.' },
      { title: '컬링 — 가운데일수록 높은 점수',
        body: '이제 스톤이 놓인 자리에 따라 점수가 달라요. 빨간 원 안 10점 · 빨간 원에 걸치면 8점 · 흰 원 안 6점 · 흰 원에 걸치면 4점 · 파란 원 안 2점 · 파란 원에 걸치면 1점. 엔드가 끝났을 때 놓인 자리로 계산해요.' },
      { title: '승부차기 — 킥 10번',
        body: '한 세트가 5번에서 10번으로 늘었어요. 골키퍼도 10명이 차례로 나오고, 뒤로 갈수록 조금씩 더 잘 막아요.' },
      { title: '자유투 도전과제 조정',
        body: '30초 규칙에 맞춰 한 세트 5골·10골·20골로 바뀌었어요. 아직 받지 않은 예전 3골 보상은 자동으로 지급했어요.' },
      { title: '공지 게시판이 생겼어요',
        body: '알림 화면에서 알림 | 공지를 골라 볼 수 있어요. 업데이트 소식은 앞으로 여기에 올라와요. 읽지 않은 공지가 있으면 종 모양에 표시가 남아 있어요.' },
      { title: '상단 바가 따라다녀요',
        body: '화면을 아래로 내려도 뒤로 가기·제목·골드가 위에 붙어 있어요.' },
    ],
  },
];

const IDS: ReadonlySet<string> = new Set(NOTICES.map(notice => notice.id));
export const isNoticeId = (value: unknown): value is string => typeof value === 'string' && IDS.has(value);
/** The ids a reader has opened, from what is stored for them (unknown ids dropped). */
export function parseNoticesRead(json: string | null | undefined): string[] {
  try { const value: unknown = JSON.parse(json ?? '[]'); return Array.isArray(value) ? value.filter(isNoticeId) : []; } catch { return []; }
}
export const unreadNoticeCount = (read: readonly string[]): number => NOTICES.filter(notice => !read.includes(notice.id)).length;
/** "2026-11-20" → "2026년 11월 20일". */
export const noticeDateText = (date: string): string => { const [year, month, day] = date.split('-'); return `${year}년 ${Number(month)}월 ${Number(day)}일`; };
export interface NoticesReadInput { ids: string[] }
export interface NoticesReadResponse { noticesRead: string[] }
