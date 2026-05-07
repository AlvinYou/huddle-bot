import { WebClient } from "@slack/web-api";
import "dotenv/config";

// ─── 설정 ────────────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID!;
const POLL_INTERVAL_MS = 10_000;   // 10초마다 참여자 갱신
const POLL_DURATION_MS = 5 * 60 * 1000; // 09:15 ~ 09:20 (5분간 실행)

const slack = new WebClient(SLACK_BOT_TOKEN);
let BOT_USER_ID: string; // 최초 1회 조회 후 캐싱

// Slack User Group 핸들 목록 — 순서가 메시지 표시 순서
const USER_GROUP_HANDLES = [
  "executives",    // 이사진
  "pmo",           // PMO팀
  "ux-ui",         // UX/UI팀
  "infra-service", // 인프라서비스개발팀
  "app-service",   // 앱서비스개발팀
  "web-service",   // 웹서비스개발팀
  "ai-core",       // AI CORE팀
];

// ─── 타입 ────────────────────────────────────────────────────────────────────
interface Member {
  id: string;
  name: string;
}

interface Team {
  name: string;
  groupId: string;
  members: Member[];
}

interface HuddleInfo {
  ts: string;
  participants: Set<string>;
}

interface HuddleMessage {
  subtype?: string;
  ts: string;
  user?: string;
  room?: { has_ended: boolean; participants?: string[] };
}

// ─── 팀/멤버 조회 ─────────────────────────────────────────────────────────────
// Slack User Group에서 팀과 멤버를 동적으로 가져온다.
// 멤버 변경 시 Slack User Group만 수정하면 자동 반영된다.
async function fetchTeams(): Promise<Team[]> {
  const groupsRes = await slack.usergroups.list({ include_users: false });
  const allGroups = groupsRes.usergroups ?? [];

  const matched = USER_GROUP_HANDLES.map((handle) => {
    const group = allGroups.find((g) => g.handle === handle);
    if (!group) throw new Error(`User Group @${handle} 를 찾을 수 없습니다.`);
    return { name: group.name!, groupId: group.id! };
  });

  return Promise.all(
    matched.map(async ({ name, groupId }) => {
      const usersRes = await slack.usergroups.users.list({ usergroup: groupId });
      const userIds = usersRes.users ?? [];

      const members: Member[] = await Promise.all(
        userIds.map(async (id) => {
          const info = await slack.users.info({ user: id });
          const profile = info.user?.profile;
          const displayName = profile?.display_name || profile?.real_name || id;
          return { id, name: displayName };
        })
      );

      return { name, groupId, members };
    })
  );
}

// ─── 허들 감지 ────────────────────────────────────────────────────────────────
// 채널 히스토리에서 진행 중인 허들 메시지를 찾는다.
// 허들 메시지는 subtype=huddle_thread이며 room.participants에 참여자 ID가 담겨있다.
async function findHuddle(): Promise<HuddleInfo | null> {
  const res = await slack.conversations.history({
    channel: CHANNEL_ID,
    limit: 20,
  });

  const huddleMsg = (res.messages as HuddleMessage[]).find(
    (m) => m.subtype === "huddle_thread" && m.room != null && !m.room.has_ended
  );

  if (!huddleMsg) return null;

  return {
    ts: huddleMsg.ts,
    participants: new Set<string>(huddleMsg.room!.participants ?? []),
  };
}

// ─── 메시지 생성 ──────────────────────────────────────────────────────────────
function buildMessage(teams: Team[], participants: Set<string>): string {
  const lines: string[] = ["📋 *오늘 데일리 허들 출석 현황*\n"];
  let allReady = true;

  for (const team of teams) {
    const present = team.members.filter((m) => participants.has(m.id));
    const absent = team.members.filter((m) => !participants.has(m.id));
    const ratio = `${present.length}/${team.members.length}`;
    const status = absent.length === 0 ? "✅" : "⏳";
    if (absent.length > 0) allReady = false;

    const absentStr =
      absent.length > 0
        ? `  _(미참여: ${absent.map((m) => m.name).join(", ")})_`
        : "";
    lines.push(`${status} *${team.name}* ${ratio}${absentStr}`);
  }

  if (allReady) lines.push("\n🟢 *전 팀 준비 완료! 시작하세요!*");

  return lines.join("\n");
}

// ─── 스레드 메시지 생성/업데이트 ─────────────────────────────────────────────
// 허들 스레드에 봇이 보낸 메시지가 있으면 update, 없으면 새로 post한다.
// Lambda는 stateless라 전역변수로 ts를 저장할 수 없기 때문에 매번 스레드를 조회한다.
async function findOrCreateReply(text: string, huddleTs: string): Promise<void> {
  const res = await slack.conversations.replies({
    channel: CHANNEL_ID,
    ts: huddleTs,
  });

  if (!BOT_USER_ID) BOT_USER_ID = (await slack.auth.test()).user_id!;
  const existing = (res.messages as HuddleMessage[]).find(
    (m) => m.user === BOT_USER_ID && m.ts !== huddleTs
  );

  if (existing) {
    await slack.chat.update({ channel: CHANNEL_ID, ts: existing.ts!, text });
  } else {
    await slack.chat.postMessage({
      channel: CHANNEL_ID,
      thread_ts: huddleTs,
      text,
    });
  }
}

// ─── Lambda 핸들러 ────────────────────────────────────────────────────────────
// EventBridge가 09:15에 1번 호출 → 5분간 10초마다 폴링 → 종료
// 전원 참여 시 조기 종료
export const handler = async () => {
  const teams = await fetchTeams();
  const start = Date.now();

  // 허들이 아직 시작 안 됐을 수 있어서 최대 2분 대기
  let huddle = await findHuddle();
  while (!huddle && Date.now() - start < 2 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    huddle = await findHuddle();
  }

  if (!huddle) {
    console.log("허들을 찾지 못했습니다. 종료합니다.");
    return;
  }

  while (Date.now() - start < POLL_DURATION_MS) {
    const latest = await findHuddle();
    const participants = latest?.participants ?? new Set<string>();
    const message = buildMessage(teams, participants);
    await findOrCreateReply(message, huddle.ts);

    const allPresent = teams.every((team) =>
      team.members.every((m) => participants.has(m.id))
    );
    if (allPresent) break;

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
};
