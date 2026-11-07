# 第 6 课：接 Telegram——长轮询、聊天内确认、白名单

前五课的 Agent 只能在终端里用：你离开电脑，它就停了。这一课把它接到 Telegram，让它成为一个常驻进程——你在手机上发消息，Agent 在本机执行，有问题就在聊天里问你。

本课新增 `telegram.js`、`bot.js`，并把 `agent.js` 重构成可复用的库。

## 先跑起来

1. 在 Telegram 里找 `@BotFather`，创建机器人，拿到 token。
2. 找到你自己的 Telegram 用户 ID（可以给 `@userinfobot` 发消息）。
3. 写进项目根目录的 `.env`：

```bash
TG_BOT_TOKEN=123456:你的机器人token
TG_ALLOWED_USERS=你的用户ID
```

4. 启动：

```bash
AGENT_WORKSPACE=~/agent-workspace node lessons/lesson-06/bot.js
```

然后在 Telegram 里私聊机器人。`/reset` 会清掉当前聊天的会话和会话文件。

> 白名单是必须的。不设置 `TG_ALLOWED_USERS`，程序会直接退出——否则任何知道你机器人的人都能操作你的电脑。

## 一句话原理

`telegram.js` 用 `getUpdates` 长轮询收私聊文本，`bot.js` 把每个聊天映射成一个 `Session`，把用户消息交给第 6 课重构后的 `run()`；遇到需要确认的操作，就发一条聊天消息，并在 120 秒内等待 `y` / `n` / `a` 回复。

## 新增文件

| 文件 | 作用 |
|---|---|
| `telegram.js` | 极简 Telegram Bot API 客户端：长轮询、发消息、待处理消息队列 |
| `bot.js` | 常驻入口：白名单、会话管理、聊天内确认、错误回滚 |

`agent.js` 的变化最大：它不再自己启动 REPL，而是导出 `makeClient`、`buildSystem`、`Session`、`run`、`handleCall`；只有直接运行 `node lessons/lesson-06/agent.js` 时才进入终端循环。

## `telegram.js`：只做三件事

### 长轮询

```js
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
```

- 用 `offset` 确认消息，避免重复处理；
- 只接受**私聊文本**：群聊、图片、语音、贴纸都忽略。教学版不做多模态，也不希望在群里被随意触发；
- 长轮询本身不需要公网 IP 或 webhook，适合在个人电脑上跑。

### 发送与拆分

Telegram 单条消息上限 4096 字符，`send` 按 4000 字符切块发送：

```js
for (let i = 0; i < body.length; i += MAX_LEN) {
  await this.call('sendMessage', { chat_id: chatId, text: body.slice(i, i + MAX_LEN) });
}
```

空回复发 `（空回复）`，避免 Telegram 拒绝空字符串。

### 待处理消息

确认期间如果收到别的消息（别的聊天，或当前聊天里不是 `y/n/a` 的内容），不能丢。`poll()` 先交出 `pending` 里积压的消息，再去拉新的；`bot.js` 的确认循环把非确认消息推进 `pending`，等确认结束后的主循环再处理。

## `bot.js`：会话、白名单、确认

### 白名单

```js
const ALLOWED = new Set(
  (process.env.TG_ALLOWED_USERS || '').split(',').filter((x) => x.trim()).map(Number),
);
```

启动时检查 `ALLOWED.size` 和 `TG_BOT_TOKEN`，缺一个就退出。每条消息再按 `userId` 检查一次。这是本课最重要的安全措施：**机器人 token 泄露不等于电脑被控制，攻击者还得在你的白名单里。**

### 每个聊天一个 Session

```js
let s = sessions.get(chatId);
if (!s) {
  s = new Session(`tg-${chatId}`, { ask: makeChatAsk(tg, chatId) });
  sessions.set(chatId, s);
}
```

- 会话名 `tg-<chatId>`，会话文件保存在 `STATE_DIR/sessions/`；
- `PermissionManager` 也是每个聊天一个，所以“本会话一直允许”只对当前聊天生效；
- `/reset` 删除内存里的会话和磁盘文件。

### 聊天内确认

`makeChatAsk` 返回一个符合 `PermissionManager` 约定的 `ask(name, args)` 函数：

1. 发一条消息，展示工具名、`renderCall` 渲染的真实内容、可选回复；
2. 在 120 秒内轮询 `getUpdates`，只接受当前聊天发来的 `y` / `n` / `a`；
3. 其他消息推进 `channel.pending`，不丢；
4. 超时返回 `['n', '确认超时']`。

`a` 只对 `REMEMBERABLE` 里的工具有效（目前只有 `write_file`）；`run_shell` 每条都要确认。

### 错误回滚

```js
const backup = [...s.messages];
try {
  reply = await run(s, text, client);
} catch (err) {
  s.messages.splice(0, s.messages.length, ...backup); // 回滚，避免留下没有配对的 tool_calls
  reply = `[出错，本轮已撤销] ${err.name}: ${err.message}`;
}
s.save();
```

模型调用可能中途失败。如果此时 `messages` 里已经有 `assistant.tool_calls` 却没有对应的 `tool` 消息，下一轮请求会被 API 拒绝，整个会话就废了。回滚到本轮开始前是最简单可靠的修复。

## `agent.js`：从脚本变成库

第 5 课的 `agent.js` 直接 `await main()`。本课拆成：

```js
export function makeClient() { ... }
export function buildSystem() { ... }

export class Session {
  constructor(name, { ask = null, persist = true } = {}) { ... }
  save() { ... }
}

export async function run(session, userInput, client, model = MODEL, log = console.log) { ... }
```

以及文件末尾的直接运行判断：

```js
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  await main();
}
```

这样 `bot.js` 可以 `import { run, Session }` 而不触发终端 REPL；直接 `node agent.js` 仍然保留原来的终端用法。用 `realpath` 是为了兼容软链接路径。

`run()` 的日志改成可注入的 `log`，`bot.js` 可以决定是否打印工具调用；`session.promptTokens` 从模块级变量挪进 `Session`，每个聊天独立计算上下文阈值。

## 设计取舍

- **长轮询而不是 webhook**：不需要公网地址、证书和端口映射，个人电脑上跑最省事。
- **白名单是硬门槛**：没有白名单就不启动，避免“先跑起来再说”的危险默认值。
- **确认走同一个聊天**：用户在哪儿下指令，就在哪儿确认，不用切终端。
- **等待确认时继续收消息**：把其他消息排队，避免确认框把机器人卡死。
- **每个聊天独立会话/权限**：家庭群或多人使用时，历史和“一直允许”不会串。
- **错误回滚整轮**：宁可丢掉这一轮，也不留下会毒化后续请求的半截消息。

## 边界与下一课

第 6 课让 Agent 能远程使用，但它仍然只在“收到消息”时才工作：

- 没有定时任务，不能到点自己做事；
- 没有心跳，不能主动检查什么；
- 没有 MCP、子 Agent、计划、记忆；
- 一个进程只接一个机器人，所有聊天串行处理。

第 7 课加定时任务与心跳：到点自动执行，无人值守时只放行创建任务时预授权过的工具。完整路线见[项目 README](../../README.md)的课程表；上一课见[第 5 课 README](../lesson-05/README.md)。
