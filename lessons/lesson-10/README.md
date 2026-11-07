# 第 10 课：计划——待办清单 + 由代码强制只读的计划模式

长任务有两个常见问题：

1. 做到一半忘了还剩什么，重复劳动或者漏掉步骤；
2. Agent 一边想一边改，用户直到最后才看到结果，方向错了已经来不及。

这一课加两样东西：`update_plan` 让模型把步骤写下来并持续更新；`/plan` 进入**由代码强制只读**的计划模式，模型先调查、再提交方案，用户批准后才允许动手。

本课新增 `planning.js`；`permissions.js` 增加计划模式，`agent.js` / `bot.js` 支持 `/plan`。

## 先跑起来

终端里：

```bash
AGENT_WORKSPACE=~/agent-workspace npm run lesson-10
```

```text
你> /plan 把 tools.js 里的 run_shell 超时改成可配置的，并补测试
```

Telegram 里同样：

```text
/plan 把 tools.js 里的 run_shell 超时改成可配置的，并补测试
```

Agent 会先调查、给出分步计划，确认框里会显示计划全文；按 `y` 批准后退出计划模式，开始执行。普通任务（不带 `/plan`）也可以让模型用 `update_plan` 记录待办，但不会强制只读。

## 一句话原理

- **待办清单**：`update_plan` 把完整步骤列表存在 `session.plan`，同时把渲染后的清单作为工具结果回给模型；旧版本在上下文里替换成一句“已过期”，只保留最新一版。
- **计划模式**：`PermissionManager.mode = 'plan'` 时，**所有非 `SAFE` 工具一律拒绝，连问都不问**；唯一例外是 `submit_plan`（`CONFIRM` 级）。用户批准计划后，`mode` 切回 `normal`。

只读不是提示词里的“请不要修改”，而是权限层的硬判断。

## 新增文件

| 文件 | 作用 |
|---|---|
| `planning.js` | `update_plan`、`submit_plan`、计划渲染、进入计划模式的前缀 |

`permissions.js` 的变化：

- `PermissionManager` 增加 `mode = 'normal'`；
- `check()` 在风险分级之后、人工确认之前插入计划模式判断；
- `update_plan` 登记为 `SAFE`，`submit_plan` 登记为 `CONFIRM`；
- `renderCall` 对 `submit_plan` 展示计划全文。

`agent.js` / `bot.js` 识别 `/plan ` 前缀，调用 `enterPlanMode`；`subagent.js` 让子 Agent 继承父 Agent 的模式，并禁止子 Agent 提交计划。

## `update_plan`：让步骤可见

```js
update_plan({
  steps: [
    { step: "读 tools.js 和现有测试", status: "completed" },
    { step: "把超时改成参数", status: "in_progress" },
    { step: "补测试并运行", status: "pending" },
  ],
})
```

规则：

- 状态只有 `pending`（`[ ]`）、`in_progress`（`[→]`）、`completed`（`[x]`）；
- 每次传**完整列表**，不是增量；
- 同一时间最多一个 `in_progress`；
- 返回当前计划，例如：

```text
[plan] 当前计划（1/3 完成）
[x] 读 tools.js 和现有测试
[→] 把超时改成参数
[ ] 补测试并运行
```

为什么每次传完整列表？增量更新需要模型维护“第几条”，容易错位；完整列表让模型每次重新审视全局，也更适合被替换。

### 旧计划只留一版

```js
for (const m of s.messages) {
  if (m.role === 'tool' && String(m.content).startsWith(PLAN_MARK)) m.content = OLD_PLAN;
}
```

每调用一次 `update_plan`，上下文里就多一份计划。旧版本没有保留价值，全部替换成：

```text
[plan] 这是旧版计划，已被后面的版本取代
```

只保留最新一版，既省 token，也避免模型把旧计划当成当前目标。注意这里只改内容、不删消息，`tool_calls` 与 `tool` 的配对仍然完整。

`session.plan` 保存的是结构化数组，但目前没有别的代码读它——它的作用是让后续扩展（比如把计划写进 system prompt、在 UI 里展示）有地方拿数据。

## 计划模式：由代码强制只读

### 进入

计划模式由**用户**触发，不是模型自己决定：

```js
export function enterPlanMode(s, task) {
  s.perms.mode = 'plan';
  return PLAN_MODE_PREFIX + task;
}
```

`PLAN_MODE_PREFIX` 会加在用户任务前面：

```text
[计划模式] 先调查，不要修改任何东西（有副作用的工具会被拒绝）。
想清楚之后调用 submit_plan 提交一份分步骤的计划，等用户批准后再执行。
任务：……
```

`agent.js` 的 REPL 和 `bot.js` 的消息处理都识别 `/plan ` 前缀，调用这个函数。没有 `/plan` 就不会进计划模式——要不要先看方案，由人决定。

### 拦截

```js
if (this.mode === 'plan' && risk !== Risk.SAFE && name !== 'submit_plan') {
  return deny('当前是计划模式，只能读和调查。想好后调用 submit_plan 提交计划，批准后才能动手。');
}
```

这段在风险分级之后、人工确认之前：

- `SAFE` 工具（读文件、列目录、加载技能、搜索会话等）照常放行；
- `CONFIRM` 工具（写文件、跑命令、抓网页、创建任务等）直接拒绝，**不弹确认框**；
- `DENY` 工具仍然拒绝；
- `submit_plan` 是唯一例外，因为提交计划本身就是计划模式的出口。

拒绝消息会告诉模型下一步该做什么，避免它反复尝试写文件。

### 提交与批准

```js
export const submitPlan = tool(
  'submit_plan',
  '计划模式下使用：提交完整的执行计划给用户审批。批准后退出计划模式，可以开始修改。',
  { ... },
  async () => {
    const s = await session();
    if (s.perms.mode !== 'plan') return 'Error: 当前不在计划模式，直接执行即可';
    s.perms.mode = 'normal';
    return '用户批准了计划。已退出计划模式，现在按计划执行；执行中如果需要偏离计划，先说明原因。';
  },
);
```

`submit_plan` 登记为 `CONFIRM`，所以走到工具函数之前，用户已经在确认界面看过计划。`renderCall` 为它单独渲染：

```js
if (name === 'submit_plan') return indent(args.plan ?? '', '  ');
```

计划全文都会展示，不截断——这是用户做决定的依据。用户按 `y` 批准后，工具函数把 `mode` 切回 `normal`；按 `n` 则继续留在计划模式，模型可以修改方案再提交。

## 子 Agent 的计划模式

```js
sub.perms.mode = parent.perms.mode; // 计划模式下派出去的子 Agent 也只能读
```

如果主 Agent 在计划模式里派 `explore` 子 Agent，子 Agent 当然只能读；派 `worker` 时如果不继承模式，子 Agent 就会绕过“先批准再动手”的约束。所以模式必须显式传下去。

同时，`NEVER_FOR_SUB` 增加 `submit_plan`：

```js
'submit_plan', // 计划只能由主 Agent 提交
```

计划是主 Agent 和用户之间的约定，子 Agent 不应该替主 Agent 提交或批准。

## 设计取舍

- **只读由权限层强制**：提示词约束不可靠，模型可能“忘记”；`PermissionManager` 的拒绝是代码级的。
- **计划模式由人触发**：模型不能自己决定“先只读再动手”，否则它可能用这个模式拖延或绕过确认。
- **提交计划也是一次确认**：复用第 3 课的确认机制，不需要新界面；确认框展示全文，用户看到的就是要批准的内容。
- **计划只留最新一版**：避免上下文里堆满历史计划。
- **待办清单不强制**：短任务不需要计划，硬性要求只会增加噪音；工具描述里建议“超过 3 步再写”。
- **模式不进会话文件**：重启后回到 `normal`，不会意外地把新会话锁在只读状态。

## 边界与下一课

第 10 课让 Agent 学会“先计划、后执行”，但它仍然不记得你：

- 每次新会话都要重新交代偏好和项目约定；
- 过去聊过的内容只能靠翻会话文件；
- 没有跨会话的长期记忆。

第 11 课加记忆：`MEMORY.md` 保存少量长期事实（每条经用户确认），`search_sessions` 按关键词检索历史会话。完整路线见[项目 README](../../README.md)的课程表；上一课见[第 9 课 README](../lesson-09/README.md)。
