import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeCall {
  method: string;
  payload: Record<string, unknown>;
}

interface Failure {
  status: number;
  description: string;
}

/**
 * A stand-in for Telegram's Bot API, just enough to run the real grammY adapter
 * against: long polling for updates, sending and copying messages, and the
 * handful of lookups made at startup. Every request is recorded in `calls`.
 */
export class FakeTelegram {
  readonly calls: FakeCall[] = [];
  readonly token: string;
  /** Messages the bot sent, in order: what a member would see. */
  readonly sent: { chatId: number; text: string }[] = [];

  private server: Server | undefined;
  private updates: { update_id: number }[] = [];
  private nextUpdateId = 100;
  private nextMessageId = 9000;
  private nextReviewId = 500;
  private waiters: (() => void)[] = [];
  private failures = new Map<string, Failure[]>();
  private drops = new Map<string, number>();
  private readonly botId = 424242;
  private readonly username = 'quest_test_bot';
  /** The channel the review copies go to, as getChat reports it. */
  reviewChannelId = -1001234567890;
  /** Whether getChatMember says the bot may post there. */
  botCanPost = true;

  constructor(token: string) {
    this.token = token;
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    for (const wake of this.waiters.splice(0)) wake();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Delivers a message to the bot, as if a member had sent it. */
  push(message: Record<string, unknown>, kind: 'message' | 'edited_message' = 'message'): void {
    this.updates.push({ update_id: this.nextUpdateId++, [kind]: message });
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** Makes the next `times` calls of `method` fail the way Telegram does. */
  fail(method: string, status: number, description: string, times = 1): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...Array.from({ length: times }, () => ({ status, description }))]);
  }

  /** Makes the next `times` calls of `method` fail like a lost connection (no answer at all). */
  drop(method: string, times = 1): void {
    this.drops.set(method, (this.drops.get(method) ?? 0) + times);
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  get pendingUpdates(): number {
    return this.updates.length;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!match) return send(404, { ok: false, error_code: 404, description: 'Not Found' });
    const [, token, method] = match as unknown as [string, string, string];
    const payload = (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown>;
    this.calls.push({ method, payload });

    const dropsLeft = this.drops.get(method) ?? 0;
    if (dropsLeft > 0) {
      this.drops.set(method, dropsLeft - 1);
      req.socket.destroy();
      return;
    }
    if (token !== this.token) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const failure = this.failures.get(method)?.shift();
    if (failure) return send(failure.status, { ok: false, error_code: failure.status, description: failure.description });

    const ok = (result: unknown): void => send(200, { ok: true, result });
    switch (method) {
      case 'getMe':
        return ok({
          id: this.botId,
          is_bot: true,
          first_name: 'Quest Test',
          username: this.username,
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        });
      case 'deleteWebhook':
      case 'setMyCommands':
        return ok(true);
      case 'getChat':
        return ok({ id: this.reviewChannelId, type: 'channel', title: 'Review Channel' });
      case 'getChatMember':
        return ok(
          this.botCanPost
            ? { status: 'administrator', user: { id: this.botId, is_bot: true, first_name: 'Quest Test' }, can_post_messages: true }
            : { status: 'member', user: { id: this.botId, is_bot: true, first_name: 'Quest Test' } },
        );
      case 'sendMessage': {
        const chatId = Number(payload.chat_id);
        this.sent.push({ chatId, text: String(payload.text) });
        return ok({ message_id: this.nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: payload.text });
      }
      case 'copyMessage':
        return ok({ message_id: this.nextReviewId++ });
      case 'copyMessages':
        return ok((payload.message_ids as number[]).map(() => ({ message_id: this.nextReviewId++ })));
      case 'getUpdates':
        return void this.getUpdates(payload, ok);
      default:
        return send(404, { ok: false, error_code: 404, description: `Not Found: ${method}` });
    }
  }

  private async getUpdates(payload: Record<string, unknown>, ok: (result: unknown) => void): Promise<void> {
    const offset = typeof payload.offset === 'number' ? payload.offset : 0;
    this.updates = this.updates.filter((u) => u.update_id >= offset); // Telegram forgets what was acknowledged
    if (this.updates.length === 0 && Number(payload.timeout ?? 0) > 0) {
      // Long polling: wait for news, but only briefly so tests stay fast.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    ok(this.updates.filter((u) => u.update_id >= offset));
  }
}
