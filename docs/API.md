# HWANSCORD API v2 — REST + Socket.IO contract

This is the single source of truth shared by `hwanscord-backend` and `hwanscord-frontend`.
Both sides must follow it exactly; change this file first when a change is needed.

- Base URL (production): same origin as the web app, `https://hwanscord.kimhwan.kr`
  - REST: `/api/v1/...`
  - Socket.IO: path `/socket.io/`
  - Uploaded files: `/uploads/avatars/<file>`, `/uploads/attachments/<file>`
  - Health: `GET /healthz` → `{ "status": "ok", "version": "<image tag>", "uptime": 12.3, "mongo": "connected" }`
- Local dev: backend `http://localhost:8080`, Vite dev server proxies `/api`, `/socket.io`, `/uploads`, `/healthz` to it.
- Auth: `Authorization: Bearer <jwt>` header. JWT payload `{ sub: userId, username }`, lifetime 7 days.
- IDs are MongoDB ObjectId strings. Timestamps are ISO-8601 UTC strings.
- All request/response bodies are JSON (`application/json`) except uploads (`multipart/form-data`).

## Errors

Every error response has this shape and a matching HTTP status:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "human readable", "details": { "fieldErrors": {} } } }
```

| status | code | when |
|---|---|---|
| 400 | `VALIDATION_ERROR` | zod validation failed (`details.fieldErrors` = `{ field: [messages] }`) |
| 400 | `BAD_REQUEST` | other client errors |
| 401 | `UNAUTHORIZED` | missing/invalid/expired token, wrong password |
| 403 | `FORBIDDEN` | not allowed (not author/admin, not a DM participant) |
| 404 | `NOT_FOUND` | unknown id |
| 409 | `CONFLICT` | duplicate username / channel name |
| 413 | `PAYLOAD_TOO_LARGE` | upload too big |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | avatar not an image |
| 429 | `RATE_LIMITED` | too many requests (`Retry-After` header) |
| 500 | `INTERNAL` | unexpected |
| 503 | `MAIL_DISABLED` | the endpoint needs to send mail and no Resend key is configured |
| 503 | `MAIL_QUOTA` | today's global mail budget (`MAIL_DAILY_LIMIT`) is used up; nothing was sent |

## Types

```ts
type Presence = 'online' | 'idle' | 'dnd' | 'offline';
type Status   = 'online' | 'idle' | 'dnd' | 'invisible';   // what the user chose

interface User {
  id: string;
  username: string;          // unique, lowercase for new accounts (legacy names kept as-is)
  displayName: string;       // 1–32 chars, defaults to username
  avatarUrl: string | null;  // e.g. "/uploads/avatars/<userId>-<hash>.webp"
  role: 'admin' | 'member';
  status: Status;            // chosen status
  presence: Presence;        // effective presence (offline when no live socket, offline when invisible — except for self)
  customStatus: string | null;  // ≤128 chars
  aboutMe: string | null;       // ≤190 chars
  createdAt: string;
  settings?: Record<string, unknown>; // only present on /users/me and auth responses (client preferences, ≤ 4 KB)
  hasPassword?: boolean;              // self only: false for accounts created through GitHub without a password yet
  connections?: { provider: 'github'; login: string }[]; // self only: linked OAuth identities
  email?: string | null;               // self only
  emailVerified?: boolean;             // self only
}

interface UserRef { id: string; username: string; displayName: string; avatarUrl: string | null }

interface Channel {
  id: string;
  type: 'text' | 'voice' | 'dm';
  name: string;                 // text/voice: 1–100 chars; dm: "" (client renders the other participant)
  topic: string | null;         // text only, ≤1024
  position: number;             // sort key within its type (ascending), default = creation order
  createdBy: string | null;     // userId; null for legacy/system channels
  participants: string[];       // dm only: exactly two userIds; [] otherwise
  lastMessageId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

interface Attachment {
  id: string;
  url: string;                  // "/uploads/attachments/<id>.<ext>"
  filename: string;             // original name, sanitized
  size: number;                 // bytes
  contentType: string;
  width: number | null;         // images only
  height: number | null;
}

interface Reaction { emoji: string; count: number; userIds: string[] }

interface Message {
  id: string;
  channelId: string;
  author: UserRef;
  content: string;              // 0–2000 chars; "" allowed only when attachments exist
  attachments: Attachment[];
  replyTo: { id: string; author: UserRef | null; content: string; deleted: boolean } | null; // content truncated to 200 chars
  mentions: string[];           // userIds parsed from "<@userId>" tokens in content
  mentionEveryone: boolean;     // content contains "@everyone"
  reactions: Reaction[];
  pinned: boolean;
  editedAt: string | null;
  createdAt: string;
  nonce?: string;               // echoed from POST so the sender can match its optimistic message
}

interface ReadState {
  channelId: string;
  lastReadMessageId: string | null;
  unreadCount: number;          // messages after lastReadMessageId not authored by me
  mentionCount: number;         // of those, mentioning me / @everyone; for DMs every unread message counts
}

interface VoiceMember { userId: string; socketId: string; muted: boolean; deafened: boolean; streaming: boolean }
interface VoiceState  { channelId: string; members: VoiceMember[] }

interface IceServer { urls: string[]; username?: string; credential?: string }
```

Mention syntax inside `content`: `<@userId>` for a user, literal `@everyone` for everyone. Clients render these tokens;
the server fills `mentions`/`mentionEveryone` from them on create/update.

## REST endpoints

All endpoints except `POST /auth/register`, `POST /auth/login` and `GET /healthz` require auth.

### Auth

| method | path | body | response |
|---|---|---|---|
| POST | `/auth/register` | `{ username, email, password, displayName? }` | `201 { token, user }` — username `^[a-z0-9_.]{2,32}$`, email ≤ 254 (stored lowercased), password 8–72 chars. `409` "이미 사용 중인 아이디입니다." / "이미 사용 중인 이메일입니다.". The **first** account ever created becomes `admin`. A verification mail is sent (failure to send never fails the registration); the account is usable immediately. |
| POST | `/auth/login` | `{ username, password }` | `200 { token, user }` — `username` may be the username **or** the email (contains `@`). `401 UNAUTHORIZED` with message "아이디 또는 비밀번호가 올바르지 않습니다." on failure (same message for unknown user / no password). Legacy bcrypt hashes (`$2a$/$2b$`) must keep working. |
| GET | `/auth/me` | | `200 { user }` (includes `settings`) |

Rate limit: 10 requests / minute / IP on register+login.

### Users

| method | path | body | response |
|---|---|---|---|
| GET | `/users` | | `{ users: User[] }` sorted by displayName (presence included) |
| GET | `/users/:id` | | `{ user }` |
| PATCH | `/users/me` | any of `{ displayName, aboutMe, customStatus, status, settings }` | `{ user }`; broadcasts `user:update` (and `presence:update` when status changed) |
| PATCH | `/users/me/password` | `{ currentPassword, newPassword }` | `200 { token }` — every other session is signed out (`tokenVersion` bump); the response carries a fresh token for this client. Wrong current password → `400 VALIDATION_ERROR` (`fieldErrors.currentPassword`), never 401 (the client signs out on 401). |
| PUT | `/users/me/avatar` | multipart field `avatar` (png/jpeg/gif/webp ≤ 8 MB) | `{ user }` — stored as 256×256 WebP (animated GIF stays animated), old file deleted; broadcasts `user:update` |
| DELETE | `/users/me/avatar` | | `{ user }` |

### Channels

| method | path | body | response |
|---|---|---|---|
| GET | `/channels` | | `{ channels: Channel[] }` — all text+voice channels plus DM channels where I am a participant |
| POST | `/channels` | `{ type: 'text'\|'voice', name, topic? }` | `201 { channel }`; name unique per type (`409 CONFLICT`); broadcasts `channel:create` |
| PATCH | `/channels/:id` | `{ name?, topic?, position? }` | `{ channel }` — creator or admin only; broadcasts `channel:update` |
| DELETE | `/channels/:id` | | `204` — creator or admin; deletes its messages, attachments files, read states; broadcasts `channel:delete`; voice members are kicked (`voice:state` with empty members) |
| POST | `/channels/dm` | `{ userId }` | `200 { channel }` get-or-create the DM with that user (`201` when created → emits `channel:create` to both participants only) |
| GET | `/channels/:id/pins` | | `{ messages: Message[] }` newest first |
| PUT | `/channels/:id/pins/:messageId` | | `{ message }` — any member for text, participants for dm; broadcasts `message:pin` |
| DELETE | `/channels/:id/pins/:messageId` | | `{ message }` |
| POST | `/channels/:id/ack` | `{ messageId }` | `{ readState }` — marks read up to messageId (ignored if older than current); emits `readstate:update` to my other sessions |
| GET | `/read-states` | | `{ readStates: ReadState[] }` for every channel visible to me |

DM channels are visible only to their two participants (404 for anyone else). Voice channels have no messages (`400 BAD_REQUEST`).

### Messages

| method | path | query/body | response |
|---|---|---|---|
| GET | `/channels/:id/messages` | `?limit=50 (1–100) &before=<messageId>` or `&after=<messageId>` | `{ messages: Message[], hasMore: boolean }` — ascending by id. Without cursor → latest `limit`. |
| POST | `/channels/:id/messages` | `{ content?, attachmentIds?: string[], replyTo?: string, nonce?: string }` | `201 { message }` — content ≤ 2000, up to 10 attachments that I uploaded and that are not yet attached; `replyTo` must be in the same channel. Updates channel.lastMessage*; broadcasts `message:create` (to all, or to the two DM participants). Rate limit 5/sec/user. |
| PATCH | `/channels/:id/messages/:mid` | `{ content }` | `{ message }` author only; sets `editedAt`; re-parses mentions; broadcasts `message:update` |
| DELETE | `/channels/:id/messages/:mid` | | `204` author or admin; deletes attachment files; broadcasts `message:delete` |
| PUT | `/channels/:id/messages/:mid/reactions/:emoji` | | `{ message }` — emoji is a URL-encoded unicode emoji (1–8 code points, ≤ 32 bytes); max 20 distinct emoji per message; broadcasts `message:reactions` |
| DELETE | `/channels/:id/messages/:mid/reactions/:emoji` | | `{ message }` |
| GET | `/messages/search` | `?q=<text> (1–100) &channelId? &authorId? &limit=25 (1–50) &offset=0` | `{ results: Message[], total: number }` newest first; uses a MongoDB text index on `content`; DM channels of other people are never searched |

### Attachments

| method | path | body | response |
|---|---|---|---|
| POST | `/attachments` | multipart field `file` (≤ 25 MB) | `201 { attachment }` — not yet bound to a message; unbound attachments older than 24 h are garbage-collected hourly. Rate limit 30/min/user. |

Files are served from `/uploads/...` with `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`,
and `Content-Disposition: attachment` for anything that is not image/*, video/*, audio/*, text/plain or application/pdf.

### OAuth (GitHub)

Only GitHub is supported. Enabled when `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are both set (empty = unset).
Register the GitHub OAuth App callback URL as `${PUBLIC_URL}/api/v1/auth/oauth/github/callback`.

| method | path | response |
|---|---|---|
| GET | `/auth/providers` | `{ github: boolean }` (no auth) |
| GET | `/auth/oauth/github/start?next=/path` | `302` to GitHub authorize (scope `read:user user:email`). Sets cookie `hs_oauth_state` (nonce; HttpOnly, SameSite=Lax, Secure in production, path `/api/v1/auth/oauth`, 10 min). `state` = JWT (purpose `oauth-state`, 10 min) `{ nonce, next, mode: 'login' }`. `next` must be a relative path starting with `/` (not `//`), otherwise `/`. Provider disabled → redirect `#error=disabled`. |
| POST | `/auth/oauth/github/link` (auth) | `{ url }` — same as start but `mode: 'link'` with the caller's `userId`; also sets the state cookie. The client navigates to `url`. |
| GET | `/auth/oauth/github/callback?code&state` | Verifies cookie nonce == state nonce (and clears the cookie), exchanges the code, reads `/user` and `/user/emails` (primary verified email is stored, never used to match accounts). Always redirects to `${PUBLIC_URL}/oauth/callback#…`: |

Callback outcomes (URL fragment, `URLSearchParams` encoded, so tokens never reach server logs):

- identity already linked → `#token=<session jwt>&next=<next>`
- `login` mode, unknown identity → `#signup=<jwt purpose oauth-signup, 15 min: githubId, login, name, avatarUrl, email>&next=<next>`
- `link` mode → identity linked to the user → `#linked=github&next=<next>`; owned by someone else → `#error=already_linked`
- failures → `#error=state_mismatch | denied | exchange_failed | disabled`

| method | path | body | response |
|---|---|---|---|
| POST | `/auth/oauth/github/complete` | `{ signupToken, username, displayName? }` | `201 { token, user }` — username rules as register, `409` when taken or when the GitHub identity got linked meanwhile; no password (`hasPassword: false`); GitHub avatar (≤ 2 MB) imported best effort. Rate limited like register. |
| DELETE | `/users/me/oauth/github` | | `{ user }`; `409 CONFLICT` "마지막 로그인 수단은 해제할 수 없습니다." when the user has no password |

`PATCH /users/me/password` does not require `currentPassword` while `hasPassword` is false (sets the first password).
Password login of an account without a password fails with the generic 401 message.
Session JWTs never carry a `purpose` claim; tokens with one (state/signup) are rejected as sessions.

### Email

Mail goes through Resend (`POST https://api.resend.com/emails`). Without `RESEND_API_KEY` mail is disabled: registration still
works, endpoints that exist only to send mail answer `503 MAIL_DISABLED`. A global budget of `MAIL_DAILY_LIMIT` mails per UTC day
(counted in `meta`) protects the free tier; when exhausted `503 MAIL_QUOTA` and nothing is sent.

User fields (self serialization only — nobody else ever sees an email): `email: string | null`, `emailVerified: boolean`.
Unique index on `email`, partial on `{ email: { $type: 'string' } }` (accounts without email are not indexed).

One-time tokens: 32 random bytes, base64url, sent only by mail; the server stores `sha256(token)` in `emailtokens`
`{ userId, purpose: 'verify'|'reset'|'change', email, hash, expiresAt (TTL index), usedAt, createdAt }`.
`verify`/`change` live 24 h, `reset` 30 min. Every token is single use; issuing a new token of the same purpose voids the user's
older unused ones.

| method | path | body | response |
|---|---|---|---|
| POST | `/auth/verify-email` | `{ token }` | `{ user }` — `verify`: marks the (unchanged) email verified; `change`: replaces the email with the confirmed new one (`409` if it got taken meanwhile). Invalid/used/expired → `400 BAD_REQUEST` "링크가 만료되었거나 이미 사용되었습니다." |
| POST | `/users/me/email/resend-verification` (auth) | | `204`; `400` without an email or when already verified; `429` more than once per 60 s or 5 per day |
| PATCH | `/users/me/email` (auth) | `{ email, currentPassword? }` | `204` — `currentPassword` required when the account has a password (wrong → `400 VALIDATION_ERROR`, `fieldErrors.currentPassword`). `409` when used by another account, `400` when it is already my email. Sends a `change` mail to the **new** address; nothing changes until it is confirmed. |
| POST | `/auth/password/forgot` | `{ login }` (username or email) | **always `204`** (no account enumeration, also for unknown/unverified/mail problems). Sends a reset mail only when the account has a verified email. Limits: 5/hour/IP, 3/hour/account (excess is silently dropped). |
| POST | `/auth/password/reset` | `{ token, newPassword }` | `204` — sets the password, uses the token, bumps `tokenVersion` (all sessions and sockets of the user are signed out). Invalid/used/expired → `400`. |

Session invalidation: users have `tokenVersion` (default 0); session JWTs carry `tv`. `requireAuth` and the socket gateway reject a
token whose `tv` differs from the user's (tokens without `tv` count as 0). Bumped by password reset, password change and admin
temporary passwords; live sockets of that user are disconnected.

Mail links: `${PUBLIC_URL}/verify-email#token=…`, `${PUBLIC_URL}/reset-password#token=…` — the token is in the URL fragment, which browsers never send to a server, so it stays out of the gateway, frontend and ELK access logs. The pages also accept the older `?token=` form. Korean HTML + plain-text bodies.

### Admin (role `admin`)

| method | path | response |
|---|---|---|
| GET | `/admin/users` | `{ users: (User & { email, emailVerified, hasPassword, connections })[] }` |
| POST | `/admin/users/:id/temporary-password` | `{ temporaryPassword }` (12 chars, shown once) — bumps the user's `tokenVersion`; `400` for yourself (use password change) |

### RTC

| method | path | response |
|---|---|---|
| GET | `/rtc/ice-servers` | `{ iceServers: IceServer[], ttl: number, relay: boolean }` — Google STUN always included; Cloudflare Realtime TURN credentials appended when configured **and** this month's TURN egress is under `TURN_MONTHLY_BUDGET_GB` (default 800 of the free 1000 GB). `relay=false` means STUN-only. Rate limit 10 / 10 min / user. |
| GET | `/rtc/usage` | admin only: `{ month: "2026-10", egressGB: number, budgetGB: number, relayEnabled: boolean }` |

## Socket.IO

Connect with `io(origin, { path: '/socket.io/', auth: { token }, transports: ['websocket', 'polling'] })`.
Invalid token → `connect_error` whose `message` is `"unauthorized"`; the client must log out.

Every socket joins room `user:<userId>`. Text/voice channel events go to **all** connected sockets; DM events go only to
the two participants' user rooms.

### Server → client

| event | payload |
|---|---|
| `ready` | `{ sessionId: string (= socket.id), user: User, presences: Record<userId, Presence>, voiceStates: VoiceState[] }` |
| `message:create` | `Message` |
| `message:update` | `Message` |
| `message:delete` | `{ channelId, messageId }` |
| `message:reactions` | `{ channelId, messageId, reactions: Reaction[] }` |
| `message:pin` | `{ channelId, messageId, pinned: boolean }` |
| `channel:create` | `Channel` |
| `channel:update` | `Channel` |
| `channel:delete` | `{ channelId }` |
| `user:create` | `User` (new registration) |
| `user:update` | `User` |
| `presence:update` | `{ userId, presence }` |
| `typing` | `{ channelId, userId }` (client shows "typing" for 8 s, refreshed by repeats) |
| `readstate:update` | `ReadState` (to my own sessions after an ack) |
| `voice:state` | `VoiceState` (the full member list of one channel; empty `members` = nobody) |
| `rtc:signal` | `{ from: socketId, scope: 'voice'\|'screen', type: 'offer'\|'answer'\|'candidate', payload }` |
| `screen:watch` | `{ from: socketId }` (a viewer wants my stream) |
| `screen:unwatch` | `{ from: socketId }` |

### Client → server (every event supports an ack callback `(res: { ok: true, data? } | { ok: false, error: { code, message } }) => void`)

| event | payload | effect |
|---|---|---|
| `typing` | `{ channelId }` | relayed as `typing` to the channel audience (not back to sender); rate limited 1/2s |
| `voice:join` | `{ channelId }` | leaves any current voice channel, joins; ack `data: VoiceState`; broadcasts `voice:state` for both channels |
| `voice:leave` | `{}` | ack; broadcasts `voice:state` |
| `voice:update` | `{ muted?, deafened?, streaming? }` | ack; broadcasts `voice:state`. When `streaming` turns false the server sends `screen:unwatch` to nobody — viewers notice via `voice:state`. |
| `rtc:signal` | `{ to: socketId, scope, type, payload }` | relayed to `to` as `rtc:signal` with `from` = sender. Only allowed between sockets in the same voice channel. |
| `screen:watch` | `{ to: socketId }` | relayed to the sharer (must be `streaming`) |
| `screen:unwatch` | `{ to: socketId }` | relayed |

A socket disconnect = `voice:leave` + presence recomputation. One user may have several sockets (tabs); presence is
`offline` only when none remain. Voice membership is per socket.

### WebRTC negotiation rules (both sides must agree)

- **Voice (scope `voice`)**: full mesh of `RTCPeerConnection`s, one per other member socket. The **joining** socket
  creates the offer to every existing member listed in the `voice:join` ack. Existing members create a connection on
  the first incoming offer from an unknown socket. ICE candidates are trickled with `type: 'candidate'`
  (`payload` = `RTCIceCandidateInit`). Audio only; `getUserMedia({ audio: { echoCancellation, noiseSuppression, autoGainControl }, video: false })`.
- **Screen share (scope `screen`)**: the sharer calls `voice:update { streaming: true }` after `getDisplayMedia`. Each
  viewer that wants to watch sends `screen:watch { to: sharerSocketId }`; the sharer creates a **separate**
  `RTCPeerConnection` per viewer, adds the display tracks, and sends the offer. Viewer answers. Viewer sends
  `screen:unwatch` to stop; the sharer closes that connection. When the sharer stops (`streaming: false`) it closes all
  viewer connections. Viewers reset their screen connections when `voice:state` shows `streaming: false`.
- Both use `iceServers` from `GET /rtc/ice-servers` (fetched once per voice session; refresh when `ttl` is half spent).
- Mute = disable local audio track (`track.enabled = false`), still connected. Deafen = mute + set every remote audio
  element volume to 0.

## Config (environment)

| var | default | meaning |
|---|---|---|
| `PORT` | `8080` | |
| `MONGODB_URI` / `MONGODB_URI_FILE` | `mongodb://localhost:27017/hwanscord` | |
| `JWT_SECRET` / `JWT_SECRET_FILE` | required in production | ≥ 32 chars |
| `UPLOAD_DIR` | `./data/uploads` | contains `avatars/` and `attachments/` |
| `CORS_ORIGINS` | empty (same-origin only) | comma separated extra origins (dev: `http://localhost:5173`) |
| `TRUST_PROXY` | `1` | express `trust proxy` (nginx in front) |
| `CF_TURN_KEY_ID(_FILE)`, `CF_TURN_API_TOKEN(_FILE)` | unset → STUN only | Cloudflare Realtime TURN key |
| `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN(_FILE)` | unset → budget guard disabled (relay allowed) | GraphQL `callsTurnUsageAdaptiveGroups` monthly egress |
| `TURN_MONTHLY_BUDGET_GB` | `800` | stop handing out TURN credentials above this |
| `TURN_CREDENTIAL_TTL` | `86400` | seconds |
| `APP_VERSION` | `dev` | reported by `/healthz` |
| `RESEND_API_KEY(_FILE)` | unset → mail disabled | Resend API key (sending access) |
| `MAIL_FROM` | `HWANSCORD <noreply@kimhwan.kr>` | sender |
| `MAIL_DAILY_LIMIT` | `80` | global mails per UTC day |
| `RESEND_API_BASE_URL` | `https://api.resend.com` | override for local tests only |
| `PUBLIC_URL` | `http://localhost:5173` | public origin of the web app (OAuth redirect_uri and result redirects) |
| `GITHUB_CLIENT_ID(_FILE)`, `GITHUB_CLIENT_SECRET(_FILE)` | unset → GitHub login disabled | GitHub OAuth App |
| `GITHUB_OAUTH_BASE_URL`, `GITHUB_API_BASE_URL` | `https://github.com`, `https://api.github.com` | overrides for local end-to-end tests only |
| `LOG_LEVEL` | `info` | pino |

## Legacy data (v1 → v2 migration)

The v1 database (`hwanscord`) has collections `users {username,password,insertedDate}`, `channels {channelName,createdBy,insertedDate,createdAt,updatedAt}`,
`voicechannels {same}`, `messages {message,createdBy,postedBy,insertedDate,createdAt,updatedAt}`, `avatars {localFilePath,createdBy}`,
`attachments {localFilePath,originalName,md5,createdBy}`. `scripts/migrate-legacy.ts` converts in place (idempotent, guarded by
`meta { key: 'schemaVersion', value: 2 }`):

- users: `password` → `passwordHash`, add `displayName=username`, `role` (`admin` for the earliest user), `status='online'`, `settings={}`; avatar file from `avatars` moved to `UPLOAD_DIR/avatars/` and `avatarUrl` set.
- channels: add `type:'text'`, `name=channelName`, `position` by `insertedDate`; `voicechannels` documents are inserted into `channels` with `type:'voice'` (same `_id`) and the collection is dropped.
- messages: `message`→`content`, `postedBy`→`channelId`, `createdBy`→`authorId`; a message whose whole content is a legacy attachment URL
  (`https://api.hwanscord.kimhwan.kr/attachments/<file>` or `/attachments/<file>`) becomes `content=""` with one attachment, the file is moved to `UPLOAD_DIR/attachments/`.
- `avatars`, `attachments` collections are dropped after use; a text index on `messages.content` is created.
