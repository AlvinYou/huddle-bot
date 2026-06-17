// ─── 허들 출석 현황 메시지 생성 ──────────────────────────────────────────────
// Slack에 의존하지 않는 순수 로직. 부재 정보를 반영해 메시지 텍스트를 만든다.
import { LeaveEntry, normalizeName } from "./kakaowork";

export interface Member {
  id: string;
  name: string;
}

export interface Team {
  name: string;
  members: Member[];
}

// 정규화된 이름 → 오늘자 부재 정보. 한 사람이 오전/오후 둘 다일 수 있으니 배열.
export type LeaveMap = Map<string, LeaveEntry[]>;

// 메시지 구성:
//   1) 팀별 출석 현황 — 오전 부재(면제)자는 출석 분모에서 제외(태그는 안 붙임)
//   2) 하단 "오늘의 부재" 브리핑 — 오전/오후 부재자를 팀별로 한 번에 모아 표시
//
// 분류:
//   - 참여: 허들 참여자에 포함
//   - 오전 부재(면제): 미참여 계산/분모에서 제외 (하단 브리핑에만 노출)
//   - 미참여: 부재 사유 없이 허들에 안 들어온 사람 (실제 체크 대상)
// 오후 부재자는 오전엔 참석해야 하므로 참여/미참여 계산엔 정상 포함하고, 하단에만 표시.
export function buildMessage(
  teams: Team[],
  participants: Set<string>,
  leaveMap: LeaveMap = new Map()
): string {
  const lines: string[] = ["📋 *오늘 데일리 허들 출석 현황*\n"];
  let allReady = true;

  // 하단 브리핑용: { 팀명, 이름, 사유 } 누적
  const briefing: { team: string; name: string; label: string }[] = [];

  for (const team of teams) {
    // 오전을 비우는 부재자(종일/오전)는 허들 면제 → 출석 체크 대상에서 제외.
    const checkable = team.members.filter((m) => !exemptLeaveOf(m, leaveMap));

    const present = checkable.filter((m) => participants.has(m.id));
    const absent = checkable.filter((m) => !participants.has(m.id));
    const ratio = `${present.length}/${checkable.length}`;
    const status = absent.length === 0 ? "✅" : "⏳";
    if (absent.length > 0) allReady = false;

    const absentStr =
      absent.length > 0
        ? `  _(미참여: ${absent.map((m) => m.name).join(", ")})_`
        : "";

    lines.push(`${status} *${team.name}* ${ratio}${absentStr}`);

    // 종일/오전/오후 부재를 브리핑에 수집(멤버당 첫 항목).
    for (const m of team.members) {
      const leave = leaveOf(m, leaveMap);
      if (leave) {
        briefing.push({ team: team.name, name: m.name, label: leave.label });
      }
    }
  }

  if (allReady) lines.push("\n🟢 *출근 인원 전원 참여! 시작하세요!*");

  // ─── 하단 부재 브리핑 ───────────────────────────────────────────────────────
  if (briefing.length > 0) {
    lines.push("\n────────────");
    lines.push("🌴 *오늘의 부재*");
    for (const b of briefing) {
      lines.push(`· ${b.team} ${b.name} _(${b.label})_`);
    }
  }

  return lines.join("\n");
}

// 멤버의 부재 항목(종류 무관, 첫 항목). 브리핑/표시에 쓴다.
function leaveOf(m: Member, leaveMap: LeaveMap): LeaveEntry | undefined {
  return leaveMap.get(normalizeName(m.name))?.[0];
}

// 멤버의 허들 면제 부재(오전을 비우는 종일/오전). 있으면 출석 체크에서 제외.
export function exemptLeaveOf(
  m: Member,
  leaveMap: LeaveMap
): LeaveEntry | undefined {
  return leaveMap
    .get(normalizeName(m.name))
    ?.find((l) => l.kind === "day" || l.kind === "morning");
}
