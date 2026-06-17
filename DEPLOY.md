# huddle-bot 배포 가이드

## 사전 준비

### 1. Slack App 생성 (api.slack.com/apps)

Manifest로 생성:

```yaml
display_information:
  name: Huddle Bot
  background_color: "#2c2d30"

features:
  bot_user:
    display_name: Huddle Bot
    always_online: true

oauth_config:
  scopes:
    bot:
      - channels:read
      - channels:history
      - chat:write
      - chat:write.public
      - users:read
      - usergroups:read    # 유료 플랜 전용

settings:
  socket_mode_enabled: false
  org_deploy_enabled: false
  token_rotation_enabled: false
```

앱 설치 후 **Bot Token** (`xoxb-...`) 발급: OAuth & Permissions → Bot User OAuth Token

채널 ID: 허들 채널 우클릭 → 채널 세부 정보 → 맨 아래 (`C`로 시작하는 문자열)

### 2. SSM Parameter Store에 값 저장

```bash
aws ssm put-parameter --name /huddle-bot/slack-bot-token \
  --value "xoxb-..." --type String

aws ssm put-parameter --name /huddle-bot/channel-id \
  --value "CXXXXXXXXXX" --type String
```

#### (선택) 카카오웍스 연차/부재 연동

카카오웍스 캘린더의 iCal 공개 링크를 등록하면, 해당 날짜의 연차/반차/부재
일정을 출석 현황 메시지에 함께 표시한다. **이 설정이 없으면 연동 없이
기존 출석 체크만 동작한다.**

```bash
aws ssm put-parameter --name /huddle-bot/kakaowork-ical-url \
  --value "https://calendar.kakaowork.com/ical/calendars/<calendar-id>/public/basic.ics" --type String
```

그리고 `template.yaml`의 `KAKAOWORK_ICAL_URL` 줄 주석을 해제한 뒤 배포한다.

iCal 링크는 카카오웍스 캘린더 → 캘린더 설정 → "외부로 공유" 에서 발급한다.

### 3. AWS SAM CLI 설치 확인

```bash
sam --version
```

---

## 배포

```bash
npm run deploy
```

---

## 동작 방식

- **평일 09:15 (KST)** 자동 실행
- 5분간 10초마다 허들 참여자 폴링
- 처음 실행 시 허들 스레드에 현황 메시지 생성, 이후 동일 메시지 업데이트
- 전원 참여 시 조기 종료 + 🟢 완료 메시지
- (연차 연동 시) 오전 부재자(연차/오전 반차/예비군 등)는 출석 분모에서 제외하고
  사유와 함께 별도 표시. 오후 부재자는 미참여 명단에 사유 꼬리표만 붙인다.

## 메시지 예시

```
📋 오늘 데일리 허들 출석 현황

✅ 이사진 3/3
✅ PMO팀 2/2
⏳ UX/UI팀 1/2  (미참여: 홍길동)
✅ 인프라서비스개발팀 3/3
✅ 앱서비스개발팀 2/2
⏳ 웹서비스개발팀 2/3  (미참여: 김철수)
✅ AI CORE팀 2/2
```

---

## 팀/멤버 변경 시

`src/index.ts`의 `USER_GROUP_HANDLES` 배열에 자신의 Slack User Group 핸들을 등록한다.

```typescript
const USER_GROUP_HANDLES = [
  "your-group-handle",  // Slack User Group 핸들
  ...
];
```

이후 멤버가 바뀌어도 Slack User Group만 수정하면 자동 반영된다. 코드/배포 불필요.

User Group 관리: https://slack.com/admin → User Groups
