# 第 4 课：上下文——截断、清理、摘要，会话持久化

第 3 课的 Agent 已经能安全地干活，但聊得越久，`messages` 越长。模型窗口是有限的，token 也是要花钱的。这一课给上下文做三层保护，并把会话存到工作区之外，退出后还能接着聊。

本课新增 `context.js`，`agent.js` 改成按真实 token 数决定何时清理、何时压缩。

## 先跑起来

```bash
AGENT_WORKSPACE=~/agent-workspace npm run lesson-04
```

连聊几轮后退出，再启动一次，它会从 `~/.agent-state/sessions/default.json` 恢复：

```bash
# 换一个状态目录，验证会话确实是持久化的
AGENT_STATE_DIR=~/agent-state-2 npm run lesson-04
```

## 一句话原理

上下文管理分三层，代价从低到高：

1. **截断**：单个工具结果太长，只保留头尾；
2. **清理**：旧工具结果换成一句占位符，保留消息结构和配对；
3. **压缩**：在 user 消息边界把旧对话交给模型摘要，只保留最近几轮。

会话持久化则把整份 `messages` 原样写进 JSON 文件，放在 `AGENT_STATE_DIR` 里，Agent 的文件工具碰不到。

## 新增文件

| 文件 | 作用 |
|---|---|
| `context.js` | 三层上下文处理 + `saveSession` / `loadSession` |

`agent.js` 新增了 `SOFT_LIMIT`、`HARD_LIMIT`、`usage.promptTokens`，并在每次调用模型后记录真实的 `prompt_tokens`。

## 第 1 层：截断工具结果

```js
export function truncateToolResult(text, limit = MAX_TOOL_CHARS) {
  const s = String(text);
  if (s.length <= limit) return s;
  const half = Math.floor(limit / 2);
  return `${s.slice(0, half)}\n...[中间省略 ${s.length - limit} 字符]...\n${s.slice(-half)}`;
}
```

`MAX_TOOL_CHARS = 4000`。保留头尾而不是只留开头，是因为命令输出和日志的关键信息经常在最后几行（退出码、错误、最终结果）。中间明确写出省略了多少字符，模型知道这里被截过，需要时可以重新调用工具。

这一层在**工具结果进入 `messages` 之前**执行：

```js
messages.push({
  role: 'tool',
  tool_call_id: call.id,
  content: truncateToolResult(result),
});
```

注意 `tools.js` 的 `execute` 还有一层 8000 字符上限。两层目的不同：`execute` 保护单次工具调用的内存和响应，`context` 保护长期对话的上下文。

## 第 2 层：清理旧工具结果

```js
export function clearOldToolResults(messages, keep = KEEP_RECENT_TOOL_RESULTS) {
  const toolIdx = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  const old = keep > 0 ? toolIdx.slice(0, -keep) : toolIdx;
  for (const i of old) messages[i].content = PLACEHOLDER;
}
```

`KEEP_RECENT_TOOL_RESULTS = 3`，只保留最近三条工具结果，更早的内容替换成：

```text
[旧工具结果已清理，如需要请重新调用工具]
```

关键点是**只改 `content`，不删消息**。`assistant` 的 `tool_calls` 和 `tool` 消息靠 `tool_call_id` 一一配对，删掉任何一条都会让下一轮请求被 API 拒绝。占位符虽然丢了原文，但保留了结构，模型也能从占位符知道“这里原来有内容，需要的话重新查”。

第 5 课的技能内容会以 `[skill]` 开头，到那时这一层会跳过它们，因为技能说明是后续推理的依据，清掉等于让模型忘记怎么用技能。

## 第 3 层：摘要压缩

当上下文还是太大，就把旧对话交给模型压缩。`splitForCompact` 只在 **user 消息处**切：

```js
const userIdx = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
if (userIdx.length <= keepTurns) return null;
const cut = userIdx[userIdx.length - keepTurns];
return [messages.slice(1, cut), messages.slice(cut)];
```

`KEEP_LAST_TURNS = 2`，最近两轮用户对话原样保留，之前的消息（从 system 之后到切点之前）送进摘要器。切在 user 边界，是为了不把一轮工具调用拆成两半。

摘要提示词要求保留：用户目标、已完成步骤、关键结论、重要文件路径和参数、未解决问题；丢弃寒暄、重复内容、大段工具原文；不超过 500 字。摘要结果被包装成一对消息插回开头：

```js
[
  messages[0],                                              // 原 system
  { role: 'user', content: `[以下是此前对话的摘要]\n${summary}` },
  { role: 'assistant', content: '好的，我已了解之前的进展，继续。' },
  ...recent,
]
```

这对 `user` / `assistant` 是刻意加的：很多模型要求消息在 user 之后交替，直接把摘要塞成 system 或 assistant 都可能破坏结构。摘要本身也是“历史”，所以明确标注来源，避免模型把摘要当成用户的新指令。

## 什么时候触发

```js
if (usage.promptTokens > HARD_LIMIT) {
  messages.splice(0, messages.length, ...(await compact(client, MODEL, messages)));
} else if (usage.promptTokens > SOFT_LIMIT) {
  clearOldToolResults(messages);
}
```

- `SOFT_LIMIT = 16000`：超过就清理旧工具结果；
- `HARD_LIMIT = 24000`：超过就摘要压缩；
- `usage.promptTokens` 来自**上一次**模型响应的 `resp.usage.prompt_tokens`。请求发出前不知道这次会有多少 token，所以只能用上一次的真实值做决策，这是一个简单但有效的近似；
- 每次模型响应后更新 `usage.promptTokens`，下一轮再判断。

这两个数字是演示值，不是通用建议。真实项目应该根据模型窗口大小、输出预留和成本来设。

## 会话持久化

```js
export function saveSession(name, messages) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSION_DIR, `${name}.json`), JSON.stringify(messages, null, 2), 'utf8');
}
```

`SESSION_DIR = path.join(STATE_DIR, 'sessions')`。`STATE_DIR` 默认 `~/.agent-state`，在工作区之外，所以 Agent 的 `write_file` / `read_file` 工具够不到会话文件——它只能通过程序自己的保存逻辑修改。

启动时：

```js
const messages = loadSession('default') || [{ role: 'system', content: SYSTEM }];
```

每轮用户输入处理完就 `saveSession('default', messages)`。这样即使进程被杀，最多丢当前这一轮。第 6 课会把会话名换成 `tg-<chatId>`，让每个聊天有独立的历史。

一个细节：压缩后的摘要和清理后的占位符也会被保存。下次启动时，模型看到的是“压缩过的历史”，而不是完整原文。这是有意的取舍——未被压缩掉的对话原文留在磁盘上，可供第 11 课检索，但不是每一轮都塞进 prompt。

## 设计取舍

- **先便宜后昂贵**：截断不花钱，清理不调用模型，只有必要时才摘要。
- **清理不删消息**：保住 `tool_calls` 与 `tool` 的配对，避免 API 报错。
- **在 user 边界切**：一轮工具调用是一个整体，不能从中间切开。
- **摘要由模型生成**：规则压缩会丢语义，模型更擅长保留“目标、结论、未完成事项”。
- **会话文件是普通 JSON**：方便查看、备份和后面做全文检索；不引入数据库。
- **状态在工作区之外**：Agent 不能通过文件工具篡改自己的会话历史。

## 边界与下一课

第 4 课解决了“聊久了会爆”和“退出就丢”，但 Agent 还是只会通用工具：

- 没有项目级说明，每次都要重复交代背景；
- 没有按需加载的能力说明书；
- 没有聊天渠道，只能在终端里用；
- 没有定时任务、MCP、子 Agent、计划、记忆。

第 5 课加“技能”：`AGENTS.md` 常驻 system prompt，`SKILL.md` 按需加载，并且技能目录对 Agent 只读。完整路线见[项目 README](../../README.md)的课程表；上一课见[第 3 课 README](../lesson-03/README.md)。
