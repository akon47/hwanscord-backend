import { User } from '../models/User.js';
import { isObjectId } from '../lib/ids.js';

const MENTION_RE = /<@([0-9a-fA-F]{24})>/g;
const EVERYONE_RE = /(^|[^\w])@everyone(?![\w])/;

export interface ParsedMentions {
  mentions: string[];
  mentionEveryone: boolean;
}

/** Extracts `<@userId>` tokens (only for users that exist) and the literal `@everyone`. */
export async function parseMentions(content: string): Promise<ParsedMentions> {
  const ids = new Set<string>();
  for (const match of content.matchAll(MENTION_RE)) {
    const id = match[1];
    if (id && isObjectId(id)) ids.add(id.toLowerCase());
  }
  let mentions: string[] = [];
  if (ids.size > 0) {
    const existing = await User.find({ _id: { $in: [...ids] } })
      .select('_id')
      .lean<{ _id: { toHexString(): string } }[]>()
      .exec();
    mentions = existing.map((u) => u._id.toHexString());
  }
  return { mentions, mentionEveryone: EVERYONE_RE.test(content) };
}
