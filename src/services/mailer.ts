import type { Config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import type { Logger } from '../logger.js';
import { Meta } from '../models/Meta.js';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const TIMEOUT_MS = 10_000;

function todayKey(): string {
  return `mail:sent:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Sends mail through Resend. A global per-UTC-day budget (counted atomically in the `meta` collection)
 * stops sending before the free tier runs out; the key and message bodies are never logged.
 */
export class Mailer {
  constructor(
    private readonly config: Config['mail'],
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return !!this.config.apiKey;
  }

  /** Throws MAIL_DISABLED, MAIL_QUOTA, or INTERNAL (Resend refused / unreachable). */
  async send(message: MailMessage): Promise<void> {
    if (!this.enabled) throw ApiError.mailDisabled();
    await this.reserve();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.apiBaseUrl}/emails`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.config.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      await this.release();
      this.logger.warn({ err: (err as Error).message }, 'resend request failed');
      throw ApiError.internal('메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    if (!res.ok) {
      await this.release();
      this.logger.warn({ status: res.status }, 'resend rejected the mail');
      throw ApiError.internal('메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    this.logger.info({ subject: message.subject }, 'mail sent');
  }

  /** Mails counted for today (UTC). */
  async sentToday(): Promise<number> {
    const doc = await Meta.findOne({ key: todayKey() }).lean<{ value?: unknown }>().exec();
    return typeof doc?.value === 'number' ? doc.value : 0;
  }

  /** Atomically takes one unit of today's budget, or throws MAIL_QUOTA without sending. */
  private async reserve(): Promise<void> {
    const doc = await Meta.findOneAndUpdate(
      { key: todayKey() },
      { $inc: { value: 1 } },
      { upsert: true, new: true },
    )
      .lean<{ value: number }>()
      .exec();
    if ((doc?.value ?? 0) > this.config.dailyLimit) {
      await this.release();
      this.logger.warn({ limit: this.config.dailyLimit }, 'daily mail budget exhausted');
      throw ApiError.mailQuota();
    }
  }

  private async release(): Promise<void> {
    await Meta.updateOne({ key: todayKey() }, { $inc: { value: -1 } }).exec();
  }
}
