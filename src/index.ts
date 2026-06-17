import { WebClient } from "@slack/web-api";
import "dotenv/config";
import { fetchLeaves } from "./kakaowork";
import {
  buildMessage,
  exemptLeaveOf,
  Member,
  Team,
  LeaveMap,
} from "./message";

// ─── 설정 ────────────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID!;
// 카카오웍스 캘린더 iCal 공개 링크. 설정된 경우에만 연차/부재 연동이 동작한다.
const KAKAOWORK_ICAL_URL = process.env.KAKAOWORK_ICAL_URL;
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
// Member / Team / LeaveMap 은 ./message 에서 가져온다.
// Team 은 groupId 가 추가로 필요하므로 여기서 확장한다.
interface TeamWithGroup extends Team {
  groupId: string;
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
async function fetchTeams(): Promise<TeamWithGroup[]> {
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
// 메시지 생성 로직(buildMessage)은 ./message 로 분리(Slack 비의존 순수 함수).

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

  // 카카오웍스 연차/부재 연동: env가 설정된 경우에만 동작.
  // fetch/파싱 실패해도 출석 체크는 정상 진행해야 하므로 조용히 건너뛴다.
  const leaveMap: LeaveMap = new Map();
  if (KAKAOWORK_ICAL_URL) {
    try {
      const leaves = await fetchLeaves(KAKAOWORK_ICAL_URL);
      for (const leave of leaves) {
        const list = leaveMap.get(leave.name) ?? [];
        list.push(leave);
        leaveMap.set(leave.name, list);
      }
      console.log(`카카오웍스 부재 ${leaves.length}건 로드 완료.`);
    } catch (e) {
      console.warn("카카오웍스 부재 정보 로드 실패, 연동 없이 진행합니다.", e);
    }
  }

  // 오전 부재(면제) 여부 — 조기 종료 판단에도 쓴다.
  const isExempt = (m: Member): boolean => !!exemptLeaveOf(m, leaveMap);

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
    const message = buildMessage(teams, participants, leaveMap);
    await findOrCreateReply(message, huddle.ts);

    // 오전 부재(면제)자는 안 들어와도 됨 → 조기 종료 판단에서 제외.
    const allPresent = teams.every((team) =>
      team.members.every((m) => isExempt(m) || participants.has(m.id))
    );
    if (allPresent) break;

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
};
