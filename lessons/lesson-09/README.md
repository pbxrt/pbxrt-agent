# 第 9 课：子 Agent——独立上下文、并行只读

一个复杂任务往往要读十几个文件、查几轮资料。这些中间过程如果全塞进主 Agent 的上下文，很快就会把窗口填满，而且大部分细节对最终结论没有用。

这一课加“子 Agent”：主 Agent 把一件边界清楚的子任务派出去，子 Agent 在自己的上下文里做完，**只把结论交回来**。中间读了多少文件、试错了多少次，都不进主 Agent 的上下文。

本课新增 `subagent.js`；`agent.js` 引入 `AsyncLocalStorage`，`Session` 支持限定工具、替换 system、记录深度。

## 先跑起来

不需要新配置，启动任意入口即可：

```bash
AGENT_WORKSPACE=~/agent-workspace npm run lesson-09
```

然后给它一个适合拆分的任务，例如：

```text
先查一下 lessons/lesson-09 里每个文件大概做什么，再告诉我子 Agent 是怎么隔离上下文的。
```

模型可能调用：

```text
delegate({ task: "阅读 lessons/lesson-09/subagent.js，总结 explore 和 worker 的区别", kind: "explore" })
delegate_parallel({ tasks: ["查 A 文件...", "查 B 文件...", "查 C 文件..."] })
```

## 一句话原理

子 Agent 就是一个新的 `Session`：自己的 `messages`、自己的工具清单、自己的步数上限。父 Agent 只拿回它最后一段文字：

```text
[子Agent 的结论]
……
```

并行版本则是 `Promise.all` 同时跑多个只读子 Agent，再把结论拼起来。

## 新增文件

| 文件 | 作用 |
|---|---|
| `subagent.js` | 两种委派工具、子 Agent 工具集、深度限制、结果截断 |

`agent.js` 的变化：

- `Session` 增加 `tools`（可用工具集合）、`system`（替换 system prompt）、`depth`（第几层）；
- `run()` 增加 `maxSteps` 参数，内部用 `AsyncLocalStorage` 保存“当前是谁在跑”；
- `handleCall` 增加 `allowed` 检查，模型请求了没发给它的工具也会被拒绝；
- `schemas()` 按 `session.tools` 过滤工具菜单。

## 两种子 Agent

### `delegate`：一个子任务

```js
delegate({
  task: "完整的任务说明",
  kind: "explore", // 或 "worker"
})
```

- `explore`：只拿只读工具（`TOOL_RISK` 为 `SAFE` 的工具）；
- `worker`：除“派生”和“定时任务”之外的全部工具，可以写文件、执行命令，但每个有副作用的操作照样要用户确认。

### `delegate_parallel`：多个只读调查

```js
delegate_parallel({
  tasks: ["调查 A", "调查 B", "调查 C"],
})
```

- 最多 `MAX_PARALLEL = 3` 个；
- 全部是 `explore`，只能读，不能写；
- 用 `Promise.all` 同时跑，任何一个子 Agent 出错都会变成一段错误文本，不会让整批失败。

为什么并行版只允许只读？因为多个 `worker` 同时写文件、同时弹确认框，冲突和体验都很难处理。只读调查天然可以并行。

## 工具集怎么筛

```js
const NEVER_FOR_SUB = new Set([
  'delegate',
  'delegate_parallel',
  'schedule_task',
  'cancel_task',
  'list_tasks',
]);

export function toolset(kind) {
  let names = [...TOOLS.keys()].filter((n) => !NEVER_FOR_SUB.has(n));
  if (kind === 'explore') names = names.filter((n) => TOOL_RISK.get(n) === Risk.SAFE);
  return new Set(names);
}
```

- **不能再派生**：`delegate` / `delegate_parallel` 永远不给子 Agent，避免无限套娃；
- **不能碰定时任务**：定时任务属于“常驻进程”的职责，子 Agent 是临时的，不应该创建长期任务；
- **explore 只拿 `SAFE`**：`read_file`、`list_dir`、`load_skill`、`list_tasks`、`delegate`（已排除）等；`write_file`、`run_shell`、`fetch_url` 都不给；
- **worker 拿其余全部**：包括 MCP 工具。MCP 工具默认 `CONFIRM`，所以 worker 调用时仍然要用户确认。

`Session.schemas()` 把这份集合应用到发给模型的 `tools` 参数：

```js
schemas() {
  const all = getSchemas();
  if (this.tools === null) return all;
  return all.filter((s) => this.tools.has(s.function.name));
}
```

`handleCall` 还会再检查一次：

```js
if (allowed !== null && !allowed.has(name)) return `Error: 当前不能使用工具 ${name}`;
```

模型有时会“幻觉”出一个没在菜单里的工具名。只过滤菜单不够，执行入口也要拦。

## `AsyncLocalStorage`：知道“谁派的我”

子 Agent 是在工具调用里同步/异步地启动的，`delegate` 需要拿到父 Session、client、model 等信息。把这些一路作为参数传下去会污染所有函数签名，所以用 Node 的 `AsyncLocalStorage`：

```js
export const CURRENT = new AsyncLocalStorage();

export async function run(session, userInput, client, model = MODEL, log = console.log, maxSteps = MAX_STEPS) {
  return CURRENT.run({ session, client, model, log }, () =>
    loop(session, userInput, client, model, log, maxSteps),
  );
}
```

`CURRENT.run(store, fn)` 在 `fn` 及其所有异步后续里都能通过 `CURRENT.getStore()` 拿到这份上下文，**跨 `await` 也不会丢**。`delegate_parallel` 用 `Promise.all` 同时跑多个子 Agent，每个子 Agent 在自己的异步链里看到自己的 store，不会串。

Python 版对应的是 `contextvars`；这是同一类问题的两种语言解法。

## 子 Agent 的一生

```js
const sub = new Session(`${parent.name}/${tag}`, {
  ask: parent.perms.ask,
  persist: false,
  tools: toolset(kind),
  system: SUB_SYSTEM,
  depth: parent.depth + 1,
});
const result = await run(sub, task, client, model, (m) => log(`  [${tag}] ${m}`), SUB_MAX_STEPS);
```

- **会话名带层级**：`default/子Agent`、`default/子Agent1`，调试时能看出是谁；
- **不持久化**：子 Agent 的中间过程没有保存价值，还会污染会话目录；
- **复用父 Agent 的 `ask`**：终端里子 Agent 的确认框仍然弹在同一个终端；Telegram 里仍然发到同一个聊天；
- **`SUB_MAX_STEPS = 15`**：比主 Agent 的 20 步更紧，防止一个子任务无限转；
- **独立 system prompt**：子 Agent 看不到主 Agent 和用户的对话，所以任务说明必须自包含。`SUB_SYSTEM` 明确要求“写清依据、不要贴大段原文、做不到就说明原因”。

结果截断：

```js
if (result.length > RESULT_LIMIT) {
  result = result.slice(0, RESULT_LIMIT) + '\n...（子 Agent 的结论过长，已截断）';
}
```

`RESULT_LIMIT = 3000`。子 Agent 的价值就是压缩信息，如果它交回 2 万字，等于没隔离。

## 深度限制

```js
const MAX_DEPTH = 1;

async function current() {
  const cur = CURRENT.getStore();
  if (!cur) throw new Error('只能在 Agent 运行时调用');
  if (cur.session.depth >= MAX_DEPTH) throw new Error('子 Agent 不能再派生子 Agent');
  return cur;
}
```

只允许一层。原因：

- 两层以上的收益递减，成本（token、时间、确认框）指数上升；
- 调试困难，出了问题很难定位是哪一层的决策；
- 子 Agent 的工具集已经排除了 `delegate`，深度检查是第二道保险。

## 设计取舍

- **隔离的是上下文，不是权限**：子 Agent 仍然走同一个 `PermissionManager`，有副作用的操作照样要人确认。它不会因为“是子 Agent”就获得额外权限。
- **只回传结论**：父 Agent 看不到子 Agent 的中间消息，这是本课最重要的约束，也是省 token 的关键。
- **explore / worker 两类**：用风险等级自动推导工具集，不需要为每个子 Agent 手写白名单。
- **并行只读**：避免写冲突和确认框风暴。
- **结果限长**：强行让子 Agent 学会“汇报结论，而不是倾倒日志”。

## 边界与下一课

第 9 课让 Agent 能拆分任务，但长任务还有两个问题：

- 做到一半可能忘了还剩什么，需要一份待办清单；
- 有些任务应该先给用户看方案，批准后再动手，而不是边想边改。

第 10 课加计划：`update_plan` 记录步骤，`/plan` 进入由代码强制只读的计划模式，`submit_plan` 经用户批准后才放行写操作。完整路线见[项目 README](../../README.md)的课程表；上一课见[第 8 课 README](../lesson-08/README.md)。
