import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import mongoose, { Types } from 'mongoose';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateLegacy } from '../scripts/migrate-legacy.js';
import { Attachment, Channel, Message, User } from '../src/models/index.js';
import { findMessages } from '../src/services/messages.js';
import { startMongo, type TestMongo } from './mongo.js';

let mongod: TestMongo;
let workDir: string;

beforeAll(async () => {
  mongod = await startMongo('hwanscord-legacy');
  await mongoose.connect(mongod.uri);
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hwanscord-migrate-'));
});
afterAll(async () => {
  await mongod.stop();
  await mongoose.disconnect();
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('migrate-legacy', () => {
  it('converts v1 collections and files into the v2 shape, idempotently', async () => {
    const db = mongoose.connection.db!;
    const legacyAvatarDir = path.join(workDir, 'avatar');
    const legacyAttachmentDir = path.join(workDir, 'attachments');
    const uploadDir = path.join(workDir, 'uploads');
    await fs.mkdir(legacyAvatarDir, { recursive: true });
    await fs.mkdir(legacyAttachmentDir, { recursive: true });

    const u1 = new Types.ObjectId();
    const u2 = new Types.ObjectId();
    const c1 = new Types.ObjectId();
    const v1 = new Types.ObjectId();
    const hash = await bcrypt.hash('secret', 10);
    await db.collection('users').insertMany([
      { _id: u1, username: 'hwan', password: hash, insertedDate: new Date('2021-06-01T00:00:00Z') },
      { _id: u2, username: 'friend', password: hash, insertedDate: new Date('2021-06-02T00:00:00Z') },
    ]);
    // legacy unique index that must disappear (dm channels have no channelName)
    await db.collection('channels').createIndex({ channelName: 1 }, { unique: true });
    await db.collection('channels').insertMany([
      {
        _id: c1,
        channelName: 'Default',
        createdBy: u1,
        insertedDate: new Date('2021-06-01'),
        createdAt: new Date('2021-06-01'),
        updatedAt: new Date('2021-06-01'),
      },
      {
        channelName: 'Second',
        createdBy: u2,
        insertedDate: new Date('2021-06-03'),
        createdAt: new Date('2021-06-03'),
        updatedAt: new Date('2021-06-03'),
      },
    ]);
    await db
      .collection('voicechannels')
      .insertOne({ _id: v1, channelName: 'Voice', createdBy: u1, insertedDate: new Date('2021-06-01') });

    const png = await sharp({ create: { width: 6, height: 4, channels: 3, background: '#00ff00' } })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(legacyAvatarDir, 'abc123.png'), png);
    await fs.writeFile(path.join(legacyAttachmentDir, 'file001.png'), png);
    await db
      .collection('avatars')
      .insertOne({ localFilePath: '/app/avatar/abc123.png', createdBy: u1, insertedDate: new Date() });
    await db.collection('attachments').insertOne({
      localFilePath: 'attachments/file001.png',
      originalName: '스크린샷.png',
      md5: 'x',
      createdBy: u1,
      insertedDate: new Date(),
    });
    const t0 = new Date('2021-07-01T10:00:00Z');
    await db.collection('messages').insertMany([
      { message: 'hello', createdBy: u1, postedBy: c1, insertedDate: t0, createdAt: t0, updatedAt: t0 },
      {
        message: 'edited later',
        createdBy: u2,
        postedBy: c1,
        insertedDate: t0,
        createdAt: t0,
        updatedAt: new Date(t0.getTime() + 60_000),
      },
      {
        message: 'https://api.hwanscord.kimhwan.kr/attachments/file001.png',
        createdBy: u1,
        postedBy: c1,
        insertedDate: new Date(t0.getTime() + 120_000),
        createdAt: new Date(t0.getTime() + 120_000),
        updatedAt: new Date(t0.getTime() + 120_000),
      },
    ]);

    const result = await migrateLegacy({ uploadDir, legacyAvatarDir, legacyAttachmentDir });
    expect(result).toMatchObject({
      skipped: false,
      users: 2,
      avatars: 1,
      channels: 2,
      voiceChannels: 1,
      messages: 3,
      attachments: 1,
    });

    const hwan = await User.findById(u1).select('+password').lean();
    expect(hwan).toMatchObject({
      username: 'hwan',
      displayName: 'hwan',
      role: 'admin',
      passwordHash: hash,
      status: 'online',
    });
    expect(hwan?.password).toBeUndefined();
    expect(hwan?.avatarUrl).toBe(`/uploads/avatars/${u1.toHexString()}-legacy.png`);
    await fs.access(path.join(uploadDir, 'avatars', `${u1.toHexString()}-legacy.png`));
    const friend = await User.findById(u2).lean();
    expect(friend?.role).toBe('member');
    expect(await bcrypt.compare('secret', friend!.passwordHash as string)).toBe(true);

    const channels = await Channel.find().sort({ type: 1, position: 1 }).lean();
    expect(channels.map((c) => [c.type, c.name, c.position])).toEqual([
      ['text', 'Default', 0],
      ['text', 'Second', 1],
      ['voice', 'Voice', 0],
    ]);
    expect(channels[0]?.lastMessageId).toBeTruthy();
    expect((await db.listCollections({ name: 'voicechannels' }).toArray()).length).toBe(0);
    expect((await db.listCollections({ name: 'avatars' }).toArray()).length).toBe(0);
    const indexNames = (await db.collection('channels').indexes()).map((i) => i.name);
    expect(indexNames).not.toContain('channelName_1');

    const messages = await findMessages({ channelId: c1 }, { sort: { _id: 1 } });
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ content: 'hello', editedAt: null, author: { username: 'hwan' } });
    expect(messages[1]?.editedAt).not.toBeNull();
    expect(messages[2]?.content).toBe('');
    expect(messages[2]?.attachments[0]).toMatchObject({
      filename: '스크린샷.png',
      contentType: 'image/png',
      width: 6,
      height: 4,
    });
    const stored = await Attachment.findOne().lean();
    expect(stored?.messageId?.toString()).toBe(messages[2]?.id);
    await fs.access(path.join(uploadDir, 'attachments', stored!.storedName));
    expect(await db.collection('attachments').countDocuments({ localFilePath: { $exists: true } })).toBe(0);

    // text index exists and works
    expect(await Message.find({ $text: { $search: 'hello' } }).countDocuments()).toBe(1);

    const again = await migrateLegacy({ uploadDir, legacyAvatarDir, legacyAttachmentDir });
    expect(again.skipped).toBe(true);
  });
});
