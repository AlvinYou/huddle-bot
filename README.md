# huddle-bot

Slack 데일리 허들 출석 현황을 자동으로 체크하는 봇.

평일 09:15에 허들이 시작되면 스레드에 팀별 참여 현황을 올리고, 참여자가 바뀔 때마다 메시지를 업데이트한다. 전원 참여 시 조기 종료.

```
📋 오늘 데일리 허들 출석 현황

✅ 이사진 3/3
✅ PMO팀 2/2
⏳ UX/UI팀 1/2  (미참여: 홍길동)
✅ 인프라서비스개발팀 3/3
✅ 앱서비스개발팀 3/3
⏳ 웹서비스개발팀 2/3  (미참여: 김철수)
✅ AI CORE팀 2/2
```

## 기술 스택

- Node.js 20 / TypeScript
- AWS Lambda + EventBridge (AWS SAM)
- Slack Web API (`@slack/web-api`)

## 배포

[DEPLOY.md](./DEPLOY.md) 참고.

## 블로그

자세한 구현 내용은 블로그 글에서 확인할 수 있다.  
https://velog.io/@alvin_you/slack-huddle-daily-bot
