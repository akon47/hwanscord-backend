import { Types } from 'mongoose';

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);
}

export function toObjectId(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export function idToString(value: Types.ObjectId | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : value.toHexString();
}

/** ObjectId hex strings sort chronologically (timestamp prefix), so plain string compare is enough. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
