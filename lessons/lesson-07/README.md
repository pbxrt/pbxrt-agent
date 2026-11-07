# 第 7 课：定时任务与心跳

第 6 课的 Agent 只在你发消息时工作。这一课让它能到点自己做事：每天 9 点汇总一次信息、每 30 分钟检查一次状态。关键问题是——**无人值守时，谁来确认有副作用的操作？**

答案不是“默认允许”，而是“创建任务时就把权限收窄”：任务只能预授权 `fetch_url` 和 `write_file`，其余操作一律拒绝。

本课新增 `scheduler.js`，`bot.js` 接入调度循环，`permissions.js` 登记三个新工具。

## 先跑起来

需要先按第 6 课配置好 Telegram：

```bash
AGENT_WORKSPACE=~/agent-workspace node lessons/lesson-07/bot.js
```

在聊天里让 Agent 创建任务：

```text
每天早上 9 点汇总一下 Hacker News 首页，发给我
```

模型会调用：

```text
schedule_task({ spec: "daily 09:00", prompt: "汇总 Hacker News 首页...", allow: "fetch_url" })
```

也可以用 `/tasks` 查看当前聊天的任务。到点后结果会以 `⏰ 任务 <id>` 开头发回聊天。

## 一句话原理

调度器把任务存进 `STATE_DIR/tasks.json`（工作区之外）。主循环每轮先处理消息，再检查有没有到期任务；到期任务用一个新的、**不持久化**的 Session 执行，权限检查换成 `makeTaskAsk(task)`——只放行任务里预授权过的工具。

## 新增文件

| 文件 | 作用 |
|---|---|
| `scheduler.js` | 任务模型、时间规则、持久化、三个工具、预授权确认、心跳 |

`bot.js` 增加 `/tasks` 命令、`runDueTasks`、`POLL_TIMEOUT = 10`（缩短轮询，给调度器留检查机会）。`agent.js` 只加了一行 `import './scheduler.js'`，导入即注册工具。

## 任务模型

```json
{
  "id": "a1b2c3",
  "spec": "daily 09:00",
  "prompt": "汇总 Hacker News 首页",
  "chat_id": 123456789,
  "allow": ["fetch_url"],
  "kind": "task",
  "next_run": "2026-11-08T01:00:00Z"
}
```

- 文件在 `STATE_DIR/tasks.json`，和会话、记忆一样在工作区之外，Agent 的文件工具碰不到；
- 写入用“临时文件 + `rename`”原子替换，写一半崩溃不会留下坏 JSON；
- 最多 20 个任务，防止无限堆积；
- `id` 是 UUID 去掉横线后取前 6 位，够短、够用；
- `chat_id` 决定结果发回哪个聊天，也决定 `list_tasks` / `cancel_task` 的作用域——一个聊天看不到、也取消不了别的聊天的任务。

## 时间规则

只支持两种写法，够教学也够日常：

```text
every 30m     每 30 分钟
every 2h      每 2 小时
daily 09:00   每天 9 点
```

`nextRun` 的细节：

- 间隔不能小于 5 分钟（`MIN_INTERVAL_MS`），防止任务把模型额度打爆；
- `daily` 如果今天的时间已过，就排到明天；
- 时间统一存成秒级 ISO 字符串（`2026-11-08T01:00:00Z`），和 `tasks.json` 里看到的格式一致；
- 看不懂的规则直接抛错，工具会把错误字符串回给模型。

## 三个工具

| 工具 | 风险 | 作用 |
|---|---|---|
| `schedule_task` | `CONFIRM` | 创建任务，需要用户确认 |
| `list_tasks` | `SAFE` | 列出当前聊天的任务 |
| `cancel_task` | `CONFIRM` | 取消任务 |

`schedule_task` 只能在消息渠道里调用：

```js
if (CURRENT.chatId === null) return 'Error: 只能在消息渠道里创建定时任务';
```

`CURRENT.chatId` 由 `bot.js` 在处理消息前设置、处理完清空。终端 REPL 里没有“把结果发回哪个聊天”的概念，所以直接拒绝，避免创建出没人收结果的任务。

## 无人值守的权限

这是本课的核心设计。任务执行时没有人盯着，不能弹确认框；但又不能放开所有权限。做法是：

```js
const PREAUTHORIZABLE = new Set(['fetch_url', 'write_file']);

export function makeTaskAsk(task) {
  const allowed = new Set(task.allow ?? []);
  return async (name) => {
    if (allowed.has(name)) return ['y', ''];
    return ['n', '这是无人值守的定时任务，该操作没有被预授权'];
  };
}
```

- 创建任务时 `allow` 只能从 `fetch_url`、`write_file` 里选；`run_shell` **不能**预授权，因为一条 shell 命令能做的事太多，无法用“工具名”约束；
- 执行时，预授权工具直接放行，其他工具（包括 `run_shell`）一律拒绝；
- 拒绝原因会回给模型，它可以调整方案，但不能越权；
- 权限检查仍然走第 3 课的 `PermissionManager`，只是 `ask` 换成了 `makeTaskAsk`。硬规则（工作区、危险命令）照常生效。

为什么允许 `write_file` 预授权？因为定时任务常见的需求就是“把结果写到某个文件”。工作区边界仍然在，写不到外面去。

## 执行到期任务

```js
for (const task of sched.due()) {
  sched.markStarted(task); // 先记下一次，再执行：任务崩了也不会反复重跑
  const s = new Session(`task-${task.id}`, {
    ask: scheduler.makeTaskAsk(task),
    persist: false,
  });
  const reply = await run(s, scheduler.taskInput(task), client);
  await tg.send(task.chat_id, `⏰ 任务 ${task.id}\n${reply}`);
}
```

几个关键点：

- **先 `markStarted` 再执行**：从“现在”算下一次，而不是从原定时间算。这样停机期间错过的不补跑，任务崩了也不会在同一轮被反复取出；
- **任务 Session 不持久化**：每次执行都是干净的上下文，不会把上一次任务的消息带进来；任务之间的隔离比“记住上次做到哪”更重要；
- **任务输入有前缀**：`[定时任务 <id>，无人值守，需要确认的操作会被拒绝]`，让模型知道自己的处境；
- **结果发回原聊天**：即使任务执行时用户不在线，下次打开 Telegram 也能看到。

### 心跳

`kind: 'heartbeat'` 的任务用于“例行检查，没事就别打扰我”：

```js
if (task.kind === 'heartbeat' && reply.trim() === scheduler.HEARTBEAT_OK) {
  console.log(`[心跳] ${task.id} 无事`);
  continue;
}
```

`taskInput` 会给心跳任务加上提示词：没有需要汇报的内容就只回复 `HEARTBEAT_OK`。只有回复不是这个标记时才发消息，避免每 30 分钟一条“一切正常”。

## 调度循环

`bot.js` 把 Telegram 轮询超时从 30 秒降到 10 秒：

```js
while (true) {
  const batch = await tg.poll();
  for (const [chatId, userId, text] of batch) await handleMessage(...);
  await runDueTasks(tg, client);
}
```

- 每轮先处理消息，再跑到期任务，用户消息优先；
- 任务顺序执行，不并行；一个任务跑久了会推迟后面的任务；
- Telegram 轮询出错时等 5 秒重试，不会让调度器一起退出；
- 任务执行失败会发一条 `[定时任务出错]`，不会让常驻进程崩掉。

## 设计取舍

- **任务存在 JSON 文件里**：和会话、记忆一致，简单、可查看、可备份；不引入数据库。
- **从“现在”排下一次**：宁可漏跑一次，也不在重启后把错过的任务一次性全部补跑，避免雪崩。
- **预授权按工具名**：比“全部允许”安全，比“每次问人”现实；`run_shell` 明确排除。
- **任务会话不持久化**：隔离优先，避免历史上下文影响判断。
- **心跳用特殊标记**：把“要不要打扰用户”交给模型判断，同时用精确字符串匹配避免误发。

## 边界与下一课

第 7 课让 Agent 能自己启动，但它的工具仍然只有内置的五个：

- 接不上外部工具生态；
- 没有子 Agent，复杂调查只能在一个上下文里做完；
- 没有计划模式，长任务缺少“先看方案再动手”的环节；
- 没有长期记忆。

第 8 课加 MCP：手写一个 stdio 客户端，把外部服务器的工具注册进同一张表。完整路线见[项目 README](../../README.md)的课程表；上一课见[第 6 课 README](../lesson-06/README.md)。
