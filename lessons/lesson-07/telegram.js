/** telegram.js —— 第 6 课：Telegram 渠道（长轮询，不需要公网 IP） */
const MAX_LEN = 4000; // Telegram 单条上限 4096，留点余量

export class Telegram {
  constructor(token, { timeout = 30 } = {}) {
    this.base = `https://api.telegram.org/bot${token}/`;
    this.timeout = timeout;
    this.offset = 0;
    this.pending = []; // 等待确认期间收到的"别的消息"，稍后处理
  }

  async call(method, params = {}) {
    const resp = await fetch(this.base + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout((this.timeout + 10) * 1000),
    });
    const body = await resp.json();
    if (!body.ok) throw new Error(`Telegram API 错误：${JSON.stringify(body)}`);
    return body.result;
  }

  /** 只拉新消息。返回 [[chatId, userId, text]]，只要私聊文本。 */
  async fetch(timeout) {
    const updates = await this.call('getUpdates', {
      offset: this.offset,
      timeout: timeout ?? this.timeout,
    });
    const out = [];
    for (const u of updates) {
      this.offset = u.update_id + 1; // 确认已收到，下次不再返回
      const m = u.message;
      if (m && 'text' in m && m.chat?.type === 'private') out.push([m.chat.id, m.from.id, m.text]);
    }
    return out;
  }

  /** 先交出积压的消息，没有积压再去拉新的。 */
  async poll(timeout) {
    if (this.pending.length) {
      const out = this.pending;
      this.pending = [];
      return out;
    }
    return this.fetch(timeout);
  }

  async send(chatId, text) {
    const body = text || '（空回复）';
    for (let i = 0; i < body.length; i += MAX_LEN) {
      await this.call('sendMessage', { chat_id: chatId, text: body.slice(i, i + MAX_LEN) });
    }
  }
}
