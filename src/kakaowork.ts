// ─── 카카오웍스 연차/부재 연동 ────────────────────────────────────────────────
// 카카오웍스 캘린더 iCal(.ics) 공개 링크에서 연차/반차/부재 일정을 가져온다.
//
// 부재 이벤트는 전부 종일 이벤트(DTSTART;VALUE=DATE)이고 SUMMARY가 "[유형] 이름"
// 형태다. 종일이라 시간으로 오전/오후를 못 가르므로, 오전/오후 판단은 오직
// SUMMARY 키워드로만 한다.
//   예) SUMMARY:[오후 반차] 홍길동
//
// 매칭 키는 SUMMARY 끝의 "이름"을 쓴다. ORGANIZER 이메일은 휴가를 대리 등록하는
// 경우가 많아(관측상 절반 가량) 본인과 일치하지 않으므로 신뢰하지 않는다.
// 동명이인 구분용 접미사(예: "홍길동B")는 정규화 단계에서 제거한다.
// 이 캘린더를 쓰는 팀 내에는 동명이인이 없어 안전하다.

// day        = 종일 부재 (연차/출산휴가/예비군 등)
// morning    = 오전만 비움 (오전 반차 등)
// afternoon  = 오후만 비움 (오후 반차 등)
// 허들 면제(오전을 비우는가)는 day | morning 으로 판정한다.
export type LeaveKind = "day" | "morning" | "afternoon";

export interface LeaveEntry {
  name: string; // 정규화된 부재자 이름 (SUMMARY에서 추출, 접미사 제거)
  label: string; // 표시용 라벨 (예: "연차", "오후 반차")
  kind: LeaveKind;
}

interface RawEvent {
  summary?: string;
  startDate?: string; // YYYYMMDD (종일 이벤트만)
  endDate?: string; // YYYYMMDD (반열린 구간의 끝, 종일 이벤트만)
}

// 이름 정규화: 공백 제거 + 동명이인 구분 접미사(끝의 영문 1글자, 예: "홍길동B") 제거.
// Slack display_name 과 비교할 때 양쪽 모두 이 함수를 통과시킨다.
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, "").replace(/[A-Za-z]+$/, "");
}

// ─── 부재 유형 분류 규칙 ──────────────────────────────────────────────────────
// 위에서부터 먼저 매치되는 규칙을 채택한다(순서가 우선순위).
// keyword: SUMMARY의 "[...]" 안에서 부분 일치로 찾는다.
// 회사 캘린더 관례가 바뀌면 이 테이블만 고치면 된다.
const LEAVE_RULES: { keyword: string; label: string; kind: LeaveKind }[] = [
  { keyword: "오전 반차", label: "오전 반차", kind: "morning" },
  { keyword: "오후 반차", label: "오후 반차", kind: "afternoon" },
  { keyword: "잇올러-오후", label: "잇올러-오후", kind: "afternoon" },
  { keyword: "잇올러-오전", label: "잇올러-오전", kind: "morning" },
  { keyword: "잇올러", label: "잇올러", kind: "afternoon" }, // 시간 미표기 잇올러는 보수적으로 오후 취급(오전 참석 기대)
  { keyword: "연차", label: "연차", kind: "day" },
  { keyword: "출산휴가", label: "출산휴가", kind: "day" },
  { keyword: "육아휴직", label: "육아휴직", kind: "day" },
  { keyword: "병가", label: "병가", kind: "day" },
  { keyword: "100일휴가", label: "100일휴가", kind: "day" },
  { keyword: "예비군", label: "예비군", kind: "day" },
  { keyword: "민방위", label: "민방위", kind: "day" },
  { keyword: "출장", label: "출장", kind: "day" },
  { keyword: "오전", label: "오전 부재", kind: "morning" },
  { keyword: "오후", label: "오후 부재", kind: "afternoon" },
];

// SUMMARY를 부재 유형으로 분류한다. 부재 키워드가 없으면(= 일반 미팅 일정) null.
export function classifyLeave(
  summary: string
): { label: string; kind: LeaveKind } | null {
  // "[...]" 대괄호 안의 태그를 우선 검사. 없으면 전체 문자열에서 검사.
  const tagMatch = summary.match(/\[([^\]]+)\]/);
  const haystack = tagMatch ? tagMatch[1] : summary;

  for (const rule of LEAVE_RULES) {
    if (haystack.includes(rule.keyword)) {
      return { label: rule.label, kind: rule.kind };
    }
  }
  return null;
}

// SUMMARY 에서 부재자 이름을 추출(정규화)한다.
// 두 가지 형식을 지원한다:
//   "[출산휴가] 홍길동"      ← 대괄호 태그 + 이름
//   "출산휴가 : 홍길동"      ← "유형 : 이름" 콜론 형식
// 이름 뒤에 직급/부가설명이 붙는 경우(예: "홍길동 차장 (오후)", "홍길동 이천 출장")는
// 한글 이름 토큰만 취한다. 매칭에 쓸 한글 이름을 못 뽑으면 null.
export function extractName(summary: string): string | null {
  let rest = summary.trim();

  // 1) 앞쪽 "[...]" 태그 제거
  rest = rest.replace(/^\[[^\]]*\]\s*/, "");

  // 2) "유형 : 이름" 콜론 형식이면 콜론 뒤를 이름 후보로
  if (rest.includes(":")) {
    rest = rest.slice(rest.lastIndexOf(":") + 1);
  }

  rest = rest.trim();
  if (!rest) return null;

  // 3) 이름은 맨 앞 한글 토큰. 뒤따르는 직급/괄호/부가설명은 버린다.
  //    (한글 이름 사이에 공백이 없다는 전제 — 한국 이름 관례)
  const m = rest.match(/^[가-힣]+/);
  if (!m) return null;

  return normalizeName(m[0]) || null;
}

// ─── iCal 파싱 ────────────────────────────────────────────────────────────────
// 외부 라이브러리 없이 직접 파싱한다(형식이 단순/일정하고 의존성을 늘리지 않기 위해).
// RFC 5545 line-folding(다음 줄이 공백/탭으로 시작하면 이전 줄에 이어붙임)을 먼저 푼다.
function unfoldLines(text: string): string[] {
  const rawLines = text.split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

export function parseICal(text: string): RawEvent[] {
  const lines = unfoldLines(text);
  const events: RawEvent[] = [];
  let current: RawEvent | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const namePart = line.slice(0, colon); // 파라미터 포함 (예: DTSTART;VALUE=DATE)
    const value = line.slice(colon + 1);
    const key = namePart.split(";")[0].toUpperCase();

    if (key === "SUMMARY") {
      current.summary = value;
    } else if (key === "DTSTART") {
      // 종일 이벤트만 다룬다. VALUE=DATE 면 "20260608" 형태.
      if (/VALUE=DATE\b/i.test(namePart) || /^\d{8}$/.test(value)) {
        current.startDate = value.slice(0, 8);
      }
    } else if (key === "DTEND") {
      if (/VALUE=DATE\b/i.test(namePart) || /^\d{8}$/.test(value)) {
        current.endDate = value.slice(0, 8);
      }
    }
  }
  return events;
}

// ─── 오늘 날짜 필터 + 부재 추출 ──────────────────────────────────────────────
// 종일 이벤트는 [startDate, endDate) 반열린 구간. 대상 날짜가 이 구간에 들어가면 해당.
function dateInRange(target: string, start?: string, end?: string): boolean {
  if (!start) return false;
  if (target < start) return false;
  if (end && target >= end) return false; // 반열린 구간
  if (!end && target !== start) return false; // 끝이 없으면 당일만
  return true;
}

// 대상 날짜(KST 기준 YYYYMMDD)에 걸친 부재 이벤트만 LeaveEntry로 변환한다.
export function extractLeaves(text: string, targetYmd: string): LeaveEntry[] {
  const events = parseICal(text);
  const entries: LeaveEntry[] = [];

  for (const ev of events) {
    if (!ev.summary) continue;
    if (!ev.startDate) continue; // 종일 이벤트가 아니면(시간 미팅) 부재로 안 봄
    if (!dateInRange(targetYmd, ev.startDate, ev.endDate)) continue;

    const cls = classifyLeave(ev.summary);
    if (!cls) continue; // 부재 키워드 없는 종일 이벤트(예: 휴일 표시 등)는 무시

    const name = extractName(ev.summary);
    if (!name) continue; // 이름 없는 부재 이벤트는 매칭 불가 → 무시

    entries.push({ name, label: cls.label, kind: cls.kind });
  }
  return entries;
}

// KST 기준 오늘 날짜를 YYYYMMDD로 반환.
export function todayYmdKST(now: Date = new Date()): string {
  // UTC+9. toLocaleDateString 대신 직접 계산해 환경 로캘에 의존하지 않게 한다.
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// ─── 외부 진입점 ──────────────────────────────────────────────────────────────
// iCal URL에서 오늘자 부재 목록을 가져온다. 실패하면 빈 배열(연동만 건너뜀).
export async function fetchLeaves(
  icalUrl: string,
  targetYmd: string = todayYmdKST()
): Promise<LeaveEntry[]> {
  const res = await fetch(icalUrl);
  if (!res.ok) {
    throw new Error(`iCal fetch 실패: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return extractLeaves(text, targetYmd);
}
