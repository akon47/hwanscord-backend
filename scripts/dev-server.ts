/**
 * Local development server backed by an in-memory MongoDB (no Docker needed).
 *   npm run dev:mem            → http://localhost:8080
 *   SEED=1 npm run dev:mem     → also seeds demo users/channels/messages
 * Demo accounts (SEED=1), password <name>1234, login with <name>@hwanscord.test:
 *   admin (admin), hwan, alice, bob — verified emails
 *   legacy — no email (v1-style account: logs in with the username and hits the email gate)
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { Channel, Message, User } from '../src/models/index.js';
import { hashPassword } from '../src/services/auth.js';
import { ensureUploadDirs } from '../src/services/files.js';
import { parseMentions } from '../src/services/mentions.js';

async function seed(log: (m: string) => void): Promise<void> {
  if ((await User.estimatedDocumentCount().exec()) > 0) return;
  const mk = async (
    username: string,
    displayName: string,
    role: 'admin' | 'member',
    about: string | null,
    withEmail = true,
  ) =>
    User.create({
      username,
      displayName,
      role,
      passwordHash: await hashPassword(`${username}1234`),
      aboutMe: about,
      ...(withEmail ? { email: `${username}@hwanscord.test`, emailVerifiedAt: new Date() } : {}),
    });
  const admin = await mk('admin', '관리자', 'admin', '서버 관리자입니다.');
  const hwan = await mk('hwan', '환', 'member', 'Vue 를 배우며 만든 환스코드 ✨');
  const alice = await mk('alice', 'Alice', 'member', null);
  const bob = await mk('bob', 'Bob', 'member', '🎮 게임 좋아함');
  await mk('legacy', '옛날사람', 'member', 'v1 시절 계정', false);
  const general = await Channel.create({
    type: 'text',
    name: 'general',
    topic: '잡담은 여기서',
    position: 0,
    createdBy: admin._id,
  });
  const random = await Channel.create({
    type: 'text',
    name: 'random',
    topic: null,
    position: 1,
    createdBy: hwan._id,
  });
  await Channel.create({ type: 'voice', name: 'lounge', position: 0, createdBy: admin._id });
  await Channel.create({ type: 'voice', name: 'game-room', position: 1, createdBy: bob._id });
  const dm = await Channel.create({
    type: 'dm',
    name: '',
    participants: [admin._id, hwan._id].sort((a, b) => a.toString().localeCompare(b.toString())),
    createdBy: admin._id,
  });

  const authors = [admin, hwan, alice, bob];
  const lines = [
    '안녕하세요! 환스코드 v2 에 오신 걸 환영합니다 👋',
    '**굵게**, *기울임*, ~~취소선~~, `코드` 도 됩니다.',
    `<@${hwan._id.toHexString()}> 새 버전 어때요?`,
    '```js\nconsole.log("hello hwanscord");\n```',
    '오늘 저녁에 음성 채널에서 봐요 🎧',
    '||스포일러는 이렇게||',
    'https://github.com/akon47/hwanscord-frontend 여기가 저장소',
    '@everyone 점검은 내일 새벽 2시입니다.',
    '> 인용문도 지원',
    '😀 😎 🚀 🔥',
  ];
  const now = Date.now();
  let i = 0;
  const created: Types.ObjectId[] = [];
  for (const channel of [general, random]) {
    for (let n = 0; n < 30; n += 1) {
      const author = authors[(i + n) % authors.length] as typeof admin;
      const content = `${lines[(i + n) % lines.length]}${n % 7 === 0 ? ` (#${n})` : ''}`;
      const { mentions, mentionEveryone } = await parseMentions(content);
      const createdAt = new Date(now - (60 - i - n) * 7 * 60_000);
      const doc = await Message.create({
        channelId: channel._id,
        authorId: author._id,
        content,
        mentions: mentions.map((m) => new Types.ObjectId(m)),
        mentionEveryone,
        replyTo: n % 9 === 4 && created.length > 0 ? created[created.length - 1] : null,
        reactions:
          n % 5 === 0
            ? [
                { emoji: '👍', userIds: [hwan._id, alice._id] },
                { emoji: '🔥', userIds: [bob._id] },
              ]
            : [],
        pinned: n === 3,
        pinnedAt: n === 3 ? createdAt : null,
        createdAt,
        updatedAt: createdAt,
      });
      created.push(doc._id);
      await Channel.updateOne(
        { _id: channel._id },
        { $set: { lastMessageId: doc._id, lastMessageAt: createdAt } },
      );
    }
    i += 30;
  }
  for (const [author, content] of [
    [admin, '환님, DM 테스트입니다.'],
    [hwan, '잘 오네요 👍'],
    [admin, '좋아요. 음성도 곧 테스트해요.'],
  ] as const) {
    const doc = await Message.create({ channelId: dm._id, authorId: author._id, content });
    await Channel.updateOne(
      { _id: dm._id },
      { $set: { lastMessageId: doc._id, lastMessageAt: doc.createdAt } },
    );
  }
  log(
    'seeded demo data: users admin/hwan/alice/bob (<name>@hwanscord.test) + legacy (no email), password <name>1234',
  );
}

async function main(): Promise<void> {
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'hwanscord' } });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    MONGODB_URI: mongod.getUri('hwanscord'),
    JWT_SECRET: process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me-please',
    UPLOAD_DIR: process.env.UPLOAD_DIR ?? './data/dev-uploads',
    CORS_ORIGINS: process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173',
    RATE_LIMIT: process.env.RATE_LIMIT ?? 'off',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  };
  const config = loadConfig(env);
  const logger = createLogger(config.logLevel, true);
  await ensureUploadDirs(config.uploadDir);
  await connectDb(config.mongoUri, logger);
  if (process.env.SEED === '1') await seed((m) => logger.info(m));
  const built = buildApp(config, { logger });
  await new Promise<void>((resolve) => built.server.listen(config.port, resolve));
  console.log(`DEV SERVER READY http://localhost:${config.port} (mongo ${mongod.getUri()})`);

  const stop = async () => {
    await built.close();
    await disconnectDb();
    await mongod.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
