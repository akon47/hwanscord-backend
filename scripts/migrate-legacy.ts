/**
 * v1 → v2 data migration (idempotent). See docs/API.md "Legacy data".
 *
 *   node dist/scripts/migrate-legacy.js
 *   env: MONGODB_URI(_FILE), UPLOAD_DIR, LEGACY_AVATAR_DIR (default /legacy/avatar),
 *        LEGACY_ATTACHMENT_DIR (default /legacy/attachments)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mime from 'mime-types';
import mongoose, { Types } from 'mongoose';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { Attachment, Channel, Message, Meta, ReadState, User } from '../src/models/index.js';
import { ensureUploadDirs, safeExtension } from '../src/services/files.js';

export interface MigrateOptions {
  uploadDir: string;
  legacyAvatarDir?: string;
  legacyAttachmentDir?: string;
  log?: (message: string) => void;
}

export interface MigrateResult {
  skipped: boolean;
  users: number;
  avatars: number;
  channels: number;
  voiceChannels: number;
  messages: number;
  attachments: number;
}

const SCHEMA_VERSION = 2;
const LEGACY_ATTACHMENT_RE =
  /^(?:https?:\/\/api\.hwanscord\.kimhwan\.kr)?\/attachments\/([A-Za-z0-9._-]+)\/?$/;

type Raw = Record<string, unknown> & { _id: Types.ObjectId };

function dateOf(doc: Raw, ...keys: string[]): Date {
  for (const k of keys) {
    const v = doc[k];
    if (v instanceof Date) return v;
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v);
  }
  return doc._id.getTimestamp();
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const INDEX_NOT_FOUND = 27;
const NAMESPACE_NOT_FOUND = 26;

/**
 * Drops an index, retrying while other index builds on the collection are still running
 * (MongoDB 4.4 refuses dropIndex during a background build). Only "not found" is ignored;
 * anything else that persists is thrown instead of silently leaving the index in place.
 */
async function dropIndexIfExists(
  collection: { dropIndex(name: string): Promise<unknown> },
  name: string,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await collection.dropIndex(name);
      return;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === INDEX_NOT_FOUND || code === NAMESPACE_NOT_FOUND) return;
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export async function migrateLegacy(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const db = mongoose.connection.db;
  if (!db) throw new Error('mongoose is not connected');
  const result: MigrateResult = {
    skipped: false,
    users: 0,
    avatars: 0,
    channels: 0,
    voiceChannels: 0,
    messages: 0,
    attachments: 0,
  };

  const meta = db.collection('meta');
  const version = await meta.findOne({ key: 'schemaVersion' });
  if (version && Number(version.value) >= SCHEMA_VERSION) {
    log(`schema already at version ${String(version.value)}; nothing to do`);
    return { ...result, skipped: true };
  }
  await ensureUploadDirs(options.uploadDir);
  // let Mongoose finish its own background index builds first, so they cannot race the index cleanup below
  await Promise.all([User, Channel, Message, Attachment, ReadState, Meta].map((model) => model.init()));

  // ---- users -------------------------------------------------------------
  const users = db.collection<Raw>('users');
  const legacyUsers = await users
    .find({ passwordHash: { $exists: false } })
    .sort({ insertedDate: 1, _id: 1 })
    .toArray();
  const hasAdmin = (await users.countDocuments({ role: 'admin' })) > 0;
  let index = 0;
  for (const u of legacyUsers) {
    const createdAt = dateOf(u, 'createdAt', 'insertedDate');
    await users.updateOne(
      { _id: u._id },
      {
        $set: {
          passwordHash: u.password ?? '',
          displayName: (u.displayName as string | undefined) ?? (u.username as string),
          role: !hasAdmin && index === 0 ? 'admin' : 'member',
          status: 'online',
          customStatus: null,
          aboutMe: null,
          avatarUrl: (u.avatarUrl as string | undefined) ?? null,
          settings: {},
          createdAt,
          updatedAt: dateOf(u, 'updatedAt', 'createdAt', 'insertedDate'),
        },
        $unset: { password: '' },
      },
    );
    index += 1;
    result.users += 1;
  }
  log(`users migrated: ${result.users}`);

  // ---- avatars -----------------------------------------------------------
  const avatarsCol = db.collection<Raw>('avatars');
  const avatarDocs = await avatarsCol.find({}).sort({ createdAt: -1, _id: -1 }).toArray();
  const avatarDone = new Set<string>();
  for (const a of avatarDocs) {
    const userId = a.createdBy as Types.ObjectId | undefined;
    const local = a.localFilePath as string | undefined;
    if (!userId || !local || avatarDone.has(userId.toString())) continue;
    avatarDone.add(userId.toString());
    const base = path.basename(local.replace(/\\/g, '/'));
    if (!options.legacyAvatarDir) continue;
    const src = path.join(options.legacyAvatarDir, base);
    if (!(await exists(src))) {
      log(`avatar file missing, skipping: ${base}`);
      continue;
    }
    const ext = safeExtension(base, mime.lookup(base) || 'image/png') || 'png';
    const destName = `${userId.toString()}-legacy.${ext}`;
    await fs.copyFile(src, path.join(options.uploadDir, 'avatars', destName));
    await users.updateOne({ _id: userId }, { $set: { avatarUrl: `/uploads/avatars/${destName}` } });
    result.avatars += 1;
  }
  log(`avatars migrated: ${result.avatars}`);

  // ---- channels ----------------------------------------------------------
  const channels = db.collection<Raw>('channels');
  // v1 had a unique index on channelName; unsetting the field would collide on null
  await dropIndexIfExists(channels, 'channelName_1');
  const legacyChannels = await channels
    .find({ type: { $exists: false } })
    .sort({ insertedDate: 1, _id: 1 })
    .toArray();
  let position = 0;
  for (const c of legacyChannels) {
    await channels.updateOne(
      { _id: c._id },
      {
        $set: {
          type: 'text',
          name: (c.channelName as string | undefined) ?? `channel-${c._id.toString().slice(-6)}`,
          topic: null,
          position,
          createdBy: (c.createdBy as Types.ObjectId | undefined) ?? null,
          participants: [],
          lastMessageId: null,
          lastMessageAt: null,
          createdAt: dateOf(c, 'createdAt', 'insertedDate'),
          updatedAt: dateOf(c, 'updatedAt', 'createdAt', 'insertedDate'),
        },
        $unset: { channelName: '' },
      },
    );
    position += 1;
    result.channels += 1;
  }
  log(`text channels migrated: ${result.channels}`);

  const collectionNames = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );
  if (collectionNames.has('voicechannels')) {
    const voice = db.collection<Raw>('voicechannels');
    const legacyVoice = await voice.find({}).sort({ insertedDate: 1, _id: 1 }).toArray();
    let vpos = 0;
    for (const v of legacyVoice) {
      const already = await channels.findOne({ _id: v._id });
      if (!already) {
        await channels.insertOne({
          _id: v._id,
          type: 'voice',
          name: (v.channelName as string | undefined) ?? `voice-${v._id.toString().slice(-6)}`,
          topic: null,
          position: vpos,
          createdBy: (v.createdBy as Types.ObjectId | undefined) ?? null,
          participants: [],
          lastMessageId: null,
          lastMessageAt: null,
          createdAt: dateOf(v, 'createdAt', 'insertedDate'),
          updatedAt: dateOf(v, 'updatedAt', 'createdAt', 'insertedDate'),
        } as Raw);
      }
      vpos += 1;
      result.voiceChannels += 1;
    }
    await voice.drop();
    log(`voice channels migrated: ${result.voiceChannels}`);
  }

  // ---- messages + attachments -------------------------------------------
  const messages = db.collection<Raw>('messages');
  const attachments = db.collection<Raw>('attachments');
  const legacyAttachments = await attachments.find({ localFilePath: { $exists: true } }).toArray();
  const attachmentByName = new Map<string, Raw>();
  for (const a of legacyAttachments) {
    attachmentByName.set(path.basename((a.localFilePath as string).replace(/\\/g, '/')), a);
  }

  const cursor = messages.find({ content: { $exists: false } });
  for await (const m of cursor) {
    const rawContent = typeof m.message === 'string' ? m.message : '';
    const channelId = m.postedBy as Types.ObjectId | undefined;
    const authorId = m.createdBy as Types.ObjectId | undefined;
    const createdAt = dateOf(m, 'createdAt', 'insertedDate');
    const updatedAt = dateOf(m, 'updatedAt', 'createdAt', 'insertedDate');
    const editedAt = updatedAt.getTime() - createdAt.getTime() > 1000 ? updatedAt : null;
    let content = rawContent;
    const attachmentIds: Types.ObjectId[] = [];

    const match = rawContent.trim().match(LEGACY_ATTACHMENT_RE);
    if (match && options.legacyAttachmentDir) {
      const fileName = match[1] as string;
      const src = path.join(options.legacyAttachmentDir, fileName);
      if (await exists(src)) {
        const legacy = attachmentByName.get(fileName);
        const newId = new Types.ObjectId();
        const contentType = mime.lookup(fileName) || 'application/octet-stream';
        const ext = safeExtension(fileName, contentType);
        const storedName = ext ? `${newId.toString()}.${ext}` : newId.toString();
        await fs.copyFile(src, path.join(options.uploadDir, 'attachments', storedName));
        const stat = await fs.stat(src);
        let width: number | null = null;
        let height: number | null = null;
        if (contentType.startsWith('image/')) {
          try {
            const info = await sharp(src).metadata();
            width = info.width ?? null;
            height = info.height ?? null;
          } catch {
            /* not decodable */
          }
        }
        await attachments.insertOne({
          _id: newId,
          storedName,
          filename: (legacy?.originalName as string | undefined) ?? fileName,
          size: stat.size,
          contentType,
          width,
          height,
          uploaderId: (legacy?.createdBy as Types.ObjectId | undefined) ?? authorId ?? null,
          messageId: m._id,
          channelId: channelId ?? null,
          createdAt,
          updatedAt: createdAt,
        } as Raw);
        attachmentIds.push(newId);
        content = '';
        result.attachments += 1;
      }
    }

    await messages.updateOne(
      { _id: m._id },
      {
        $set: {
          content,
          channelId: channelId ?? null,
          authorId: authorId ?? null,
          attachmentIds,
          replyTo: null,
          mentions: [],
          mentionEveryone: false,
          reactions: [],
          pinned: false,
          pinnedAt: null,
          editedAt,
          createdAt,
          updatedAt,
        },
        $unset: { message: '', postedBy: '', createdBy: '' },
      },
    );
    result.messages += 1;
  }
  // orphans (channel/author gone) would break serialization — drop them
  await messages.deleteMany({ $or: [{ channelId: null }, { authorId: null }] });
  await attachments.deleteMany({ localFilePath: { $exists: true } });
  if (collectionNames.has('avatars')) await avatarsCol.drop();
  log(`messages migrated: ${result.messages}, attachments: ${result.attachments}`);

  // ---- channel.lastMessage ----------------------------------------------
  const latest = await messages
    .aggregate<{ _id: Types.ObjectId; lastId: Types.ObjectId; lastAt: Date }>([
      { $group: { _id: '$channelId', lastId: { $max: '$_id' }, lastAt: { $max: '$createdAt' } } },
    ])
    .toArray();
  for (const l of latest) {
    await channels.updateOne({ _id: l._id }, { $set: { lastMessageId: l.lastId, lastMessageAt: l.lastAt } });
  }

  // ---- indexes (drops legacy unique indexes such as channels.channelName_1) ----
  await Promise.all(
    [User, Channel, Message, Attachment, ReadState, Meta].map((model) => model.syncIndexes()),
  );

  await meta.updateOne({ key: 'schemaVersion' }, { $set: { value: SCHEMA_VERSION } }, { upsert: true });
  log('schema version set to 2');
  return result;
}

async function main(): Promise<void> {
  const config = loadConfig();
  await connectDb(config.mongoUri);
  try {
    const result = await migrateLegacy({
      uploadDir: config.uploadDir,
      legacyAvatarDir: process.env.LEGACY_AVATAR_DIR ?? '/legacy/avatar',
      legacyAttachmentDir: process.env.LEGACY_ATTACHMENT_DIR ?? '/legacy/attachments',
      log: (m) => console.log(`[migrate] ${m}`),
    });
    console.log(JSON.stringify(result));
  } finally {
    await disconnectDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
