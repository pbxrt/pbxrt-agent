# 第 2 课：工具注册表与统一执行器

第 1 课把工具名、函数、JSON Schema 分散在三处，加一个工具要改三遍。这一课把三张表合成一张注册表，主循环从此**不认识任何具体工具**；同时加上 REPL，让一个进程可以连续对话。

本课新增 `tools.js`、`env.js`，重写 `agent.js`。

## 先跑起来

```bash
# 项目根目录的 .env 里写好 API_KEY=你的模型密钥
npm run lesson-02
# 或者
node lessons/lesson-02/agent.js
```

进入后可以连续输入任务：

```text
你> 看看这个目录里有什么
你> 在当前目录写一个 hello.js，然后运行它
你> exit
```

`exit`、`quit`、空行或 Ctrl-D 都会退出。

## 一句话原理

**工具 = 一份给模型看的 Schema + 一个真正干活的 async 函数。** 两者放进同一张 `Map`，注册一次就同时完成“告诉模型”和“让代码能执行”两件事：

```js
tool('read_file', '读取一个文本文件的内容。', params({ path: '文件路径' }), ({ path: p }) =>
  fs.readFile(p, 'utf8'),
);
```

主循环只调用 `getSchemas()` 取说明书、调用 `execute(name, args)` 执行工具，不再出现 `TOOL_FUNCS.get('write_file')` 这种按名字写死的分支。

## 新增文件

| 文件 | 作用 |
|---|---|
| `env.js` | 读取项目根目录 `.env`，导出 `BASE_URL`、`MODEL`、`WORKSPACE`、`STATE_DIR` 和 `requireApiKey()` |
| `tools.js` | 工具注册表、五个工具、统一执行器 `execute` |

`agent.js` 从“跑一个任务就退出”改成“读一行、跑一轮、再读一行”的 REPL。

## `env.js`：配置只读一次

- 用 Node 20.12+ 内置的 `process.loadEnvFile` 读取 `<项目根>/.env`，不需要 `dotenv`。文件不存在就静默跳过，`export` 的环境变量照常可用；已经存在的环境变量优先，所以临时 `API_KEY=... node ...` 可以覆盖 `.env`。
- `MODEL` 默认 `deepseek-flash`，`BASE_URL` 默认 DeepSeek 的 OpenAI 兼容地址。
- `WORKSPACE` 默认是启动命令时的当前目录。本课还没有用它做限制，但第 3 课会拿它当权限边界，所以先把路径固定下来。
- `STATE_DIR` 默认 `~/.agent-state`，用来放会话、定时任务、记忆。它**故意放在工作区之外**：Agent 的文件工具够不到，只能通过专门注册的工具修改，后续课程会陆续用上。
- `realpathLoose` 展开路径里已存在部分的软链接，又允许路径末端尚不存在（比如待创建的文件）。macOS 上 `/tmp` 其实是 `/private/tmp`，不做这一步，工作区边界判断会被软链接绕过。
- `requireApiKey` 在缺密钥时给一句人话，而不是把 SDK 的英文堆栈丢给用户。

## `tools.js`：一张表管两头

### 注册与取用

```js
export const TOOLS = new Map(); // name -> { schema, func }

export function tool(name, description, parameters, func) {
  TOOLS.set(name, {
    schema: { type: 'function', function: { name, description, parameters } },
    func,
  });
  return func;
}

export const getSchemas = () => [...TOOLS.values()].map((t) => t.schema);
```

`tool()` 返回原函数，所以既可以当注册用，也可以把返回值导出成具名函数。`getSchemas()` 每次调用都从当前注册表生成，后面课程动态注册 MCP 工具、技能工具时，主循环一行都不用改。

`params()` 是一个小简写：把 `{ 参数名: 说明 }` 变成“全部必填的字符串参数”的 JSON Schema。它表达不了数字、枚举和可选参数，所以后面的 `load_skill`、`schedule_task` 等工具直接写完整 Schema。

### 五个工具

| 工具 | 实现要点 |
|---|---|
| `list_dir` | `readdir`，目录名后面加 `/`，空目录返回 `(空目录)` |
| `read_file` | 直接 `fs.readFile(p, 'utf8')` |
| `write_file` | 先 `mkdir -p` 父目录，再写入；返回字符数 |
| `run_shell` | `execAsync`，30 秒超时，非零退出也返回 `[exit N]` 而不是抛异常 |
| `fetch_url` | `fetch`，15 秒超时，返回响应正文；User-Agent 固定成 `pbxrt-agent` |

`fetch_url` 是本课新增的能力：模型可以让 Agent 去读一个网页或接口，而不只是碰本地文件。

### 统一执行器

`execute()` 是所有工具的唯一入口，它保证三件事：

1. **永远返回字符串**：`String(await entry.func(args))`，模型只能读文本。
2. **永远不抛异常**：工具抛错就转成 `Error: ...` 字符串，作为 `tool` 消息回给模型。模型看到错误后可以换参数重试，整个 Agent 不会崩。
3. **统一截断**：超过 `MAX_OUTPUT = 8000` 字符，保留前 8000 字符并追加“已截断，共 N 字符”。输出上限是上下文保护的一部分，第 4 课会把它做得更细。

找不到工具时也返回字符串，并列出当前可用工具名，方便模型自查。

## `agent.js`：主循环只认注册表

### 从单任务到 REPL

第 1 课每次运行只处理一个命令行任务。本课把 `messages` 提到循环外，一个进程内持续复用：

```js
const messages = [{ role: 'system', content: SYSTEM }];
while (true) {
  const q = (await rl.question('你> ')).trim();
  if (!q || q === 'exit' || q === 'quit') break;
  console.log(`\n${await run(q, messages)}\n`);
}
```

`messages` 就是整个会话的短期记忆。每轮 `run()` 都往里追加一条 `user`，工具结果也继续追加，所以模型能看到之前所有轮次。第 4 课才会教它怎么在变长时清理和压缩。

### 主循环

```js
const resp = await client.chat.completions.create({
  model: MODEL,
  messages,
  tools: getSchemas(),
});
const msg = resp.choices[0].message;
messages.push(assistantMessage(msg));

if (!msg.tool_calls?.length) return msg.content || '';

for (const call of msg.tool_calls) {
  const args = JSON.parse(call.function.arguments || '{}');
  const result = await execute(call.function.name, args);
  messages.push({ role: 'tool', tool_call_id: call.id, content: result });
}
```

细节：

- **按注册表取 Schema**：`tools: getSchemas()` 而不是手写数组。注册表变了，模型看到的菜单自动跟着变。
- **一轮多个工具调用**：模型可能一次返回多个 `tool_call`，每个都必须回一条对应 `tool_call_id` 的 `tool` 消息，否则下一轮请求会被 API 拒绝。内层是串行 `await`，不是并行。
- **参数解析失败**：`JSON.parse` 抛错时回 `Error: 参数不是合法的 JSON`，仍然是一条合法的工具结果。
- **步数上限**：`MAX_STEPS = 20`，防止模型反复调工具停不下来。达到上限返回一句提示，进程继续等下一轮输入。

### `assistantMessage` 仍然保留

模型返回的 SDK 对象可能带额外字段，直接塞回 `messages` 有风险。这里继续只保留 `role`、`content`、`tool_calls` 的四个必要字段和可选的 `reasoning_content`。`content` 用 `?? null`，因为带工具调用时它常常是 `null`，不能变成 `undefined`。

## 本课暂时失去的东西

第 1 课在 `run_shell` 里逐条问 `y/n`；这一课把 shell 实现搬进 `tools.js` 后，工具函数不再直接读终端，**确认逻辑暂时缺席**。同样，`env.js` 虽然算出了 `WORKSPACE`，但文件工具还没有用它做边界检查，写 `../..` 依然能跑。

这不是退步，而是把“权限”从工具实现里抽出来的中间状态：第 3 课会在 `agent.js` 和工具执行之间插入统一的权限层，把终端、工作区边界、危险命令规则一起补回来，而且比第 1 课的逐条确认更完整。

## 设计取舍

- **注册表用 `Map` 而不是两个平行数组**：一个 key 同时拿到 Schema 和函数，不可能出现“说明书里有、后厨里没有”的错位。
- **Schema 和实现放在同一个 `tool()` 调用里**：加工具是加一行注册，不是改三处。
- **`execute` 兜底所有异常**：工具作者可以放心抛错，错误会变成模型可读的输入。
- **REPL 而不是一次性命令**：为后面的会话持久化、聊天渠道、定时任务做铺垫——它们都需要一个长期活着的进程。
- **`env.js` 独立**：主循环、工具、权限、会话都要读配置，集中在一处避免每课复制粘贴路径逻辑。

## 边界与下一课

第 2 课能连续对话，也能访问网络了，但还很不安全：

- 文件工具没有工作区限制，`read_file('/etc/passwd')` 也能读；
- `run_shell` 没有任何确认或黑名单，模型让跑什么就跑什么；
- 上下文只做了 8000 字符的工具结果截断，聊久了会一直变长；
- 所有轮次共用一个进程内存，退出就没了。

第 3 课先解决安全边界：工作区、危险命令黑名单、风险分级和人工确认。之后每课加一个能力，完整路线见[项目 README](../../README.md)的课程表；上一课的逐段说明见[第 1 课 README](../lesson-01/README.md)。
