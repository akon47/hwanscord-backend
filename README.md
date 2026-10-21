# 환스코드 백엔드 (hwanscord-backend)

디스코드를 본뜬 토이 프로젝트 [환스코드](https://hwanscord.kimhwan.kr) 의 API 서버입니다.
텍스트 채팅·DM·반응·답장·첨부·고정·검색, 음성 채널과 화면 공유를 위한 WebRTC 시그널링을 제공합니다.
프론트엔드는 [hwanscord-frontend](https://github.com/akon47/hwanscord-frontend) 입니다.

- API 규격(REST + Socket.IO): **[docs/API.md](docs/API.md)** — 프론트엔드와 공유하는 단일 기준 문서
- 스택: Node 22 · TypeScript · Express 5 · Mongoose 8 (MongoDB 7) · Socket.IO 4 · zod · pino · sharp
- WebRTC TURN: Cloudflare Realtime TURN. 무료 한도(월 1,000 GB) 안에서만 TURN 자격을 발급하도록 월 사용량을 Cloudflare 분석 API 로 확인하는 예산 가드가 있습니다(`TURN_MONTHLY_BUDGET_GB`, 기본 800). 한도를 넘으면 STUN 만 내려줍니다.

## 로컬 개발

```bash
npm install
npm run dev:mem          # 인메모리 MongoDB 로 http://localhost:8080 실행
SEED=1 npm run dev:mem   # 데모 데이터 포함 (admin/admin1234, hwan/hwan1234, alice/alice1234, bob/bob1234)
```

실제 MongoDB 를 쓰려면 `.env.example` 을 `.env` 로 복사해 `MONGODB_URI` 를 지정하고 `npm run dev` 를 실행합니다.

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # vitest (mongodb-memory-server 가 mongod 7.0 바이너리를 내려받습니다)
npm run build       # dist/
```

## 배포 흐름

`master` 에 push → Jenkins 잡 `hwanscord-backend`(build.kimhwan.kr) → `docker build --target test`(lint·typecheck·테스트)
→ `akon47/hwanscord-backend:<빌드번호>` 를 Docker Hub 에 push → ssh 로 VM(10.10.10.75) 의 `/srv/hwanscord/backend` 에 `deploy/` 복사
→ `deploy.sh`(`docker compose pull && up -d`) → `/healthz` 의 version 이 빌드번호와 같은지 확인.

VM 쪽 구성:

- `/srv/hwanscord/backend/` — `compose.yaml`, `mongo-init.js`, `deploy.sh`, `backup.sh`, `migrate-from-v1.sh`
- `/srv/hwanscord/data/uploads/` — 아바타·첨부 파일 (컨테이너 `/data/uploads`, uid 1000)
- `/srv/hwanscord/data/mongo/` — MongoDB 데이터
- `/srv/hwanscord/backups/` — `backup.sh` 결과 (매일 mongodump 14개, 매주 uploads tar 4개 보관)
- 컨테이너: `hwanscord-api`(:8080 공개), `hwanscord-mongo`(비공개), 네트워크 `hwanscord`(프론트 nginx 가 `hwanscord-api:8080` 으로 프록시)

### 비밀 파일 (`/srv/hwanscord/secrets/` 0700 디렉터리, 파일 0644 — 컨테이너 uid 가 읽어야 함, 값은 저장소에 두지 않음)

| 파일 | 내용 |
|---|---|
| `jwt-secret` | 32자 이상 임의 문자열 |
| `mongo-root-password` | MongoDB root 비밀번호 (첫 기동 시 생성) |
| `mongo-app-password` | 앱 사용자 `hwanscord` 비밀번호 (첫 기동 시 생성) |
| `mongodb-uri` | `mongodb://hwanscord:<mongo-app-password>@mongo:27017/hwanscord?authSource=hwanscord` |
| `cf-turn-key-id` | Cloudflare Realtime TURN 키 ID |
| `cf-turn-api-token` | 그 키의 API 토큰 |
| `cf-analytics-token` | Account Analytics Read 권한만 있는 Cloudflare API 토큰 (TURN 사용량 조회) |
| `github-client-id` | (선택) GitHub OAuth App Client ID. 비어 있으면 GitHub 로그인 꺼짐 (deploy.sh 가 빈 파일을 만들어 둠) |
| `github-client-secret` | (선택) 그 앱의 Client Secret |

GitHub OAuth App 설정: Homepage `https://hwanscord.kimhwan.kr`, Authorization callback URL
`https://hwanscord.kimhwan.kr/api/v1/auth/oauth/github/callback`. 키를 넣은 뒤 `docker compose up -d api` 로 재시작합니다.

운영자 PC 원본은 `~/.homelab/services/hwanscord/` 에 둡니다.

## v1 → v2 데이터 이전

v1(Node 14 + mongo 4.4, 컬렉션 `users/channels/voicechannels/messages/avatars/attachments`) 데이터를 유지합니다.

1. v2 스택을 먼저 올립니다(`deploy.sh`). DB 는 비어 있어야 합니다.
2. `./migrate-from-v1.sh <v1 mongo 컨테이너> <v1 avatar 디렉터리> <v1 attachments 디렉터리>`
   - v1 mongo 에서 `mongodump` → `hwanscord-mongo` 에 `mongorestore --drop`
   - 아바타·첨부 파일을 `/srv/hwanscord/legacy/` 로 복사
   - `node dist/scripts/migrate-legacy.js` 가 스키마를 v2 로 바꾸고(`meta.schemaVersion = 2`) 파일을 `uploads/` 로 옮깁니다. 여러 번 실행해도 안전합니다.
3. `/healthz` 와 로그인(기존 bcrypt 해시 그대로 사용 가능)을 확인한 뒤 v1 스택을 내립니다.

## 환경 변수

`docs/API.md` 의 Config 표를 따릅니다. 비밀값은 `*_FILE` 로 파일 경로를 넘길 수 있습니다.
