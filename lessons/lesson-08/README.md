# 第 8 课：MCP——手写 stdio 客户端 + 一个 demo server

内置工具只有五个，想接数据库、浏览器、公司内部系统怎么办？MCP（Model Context Protocol）给出了一套标准：工具由**独立的服务器进程**提供，Agent 通过 JSON-RPC 和它说话。

这一课不依赖官方 SDK，用 `child_process` + `readline` 手写一个最小客户端，再写一个 demo server，把协议本身看清楚。

本课新增 `mcp_client.js`、`demo_mcp_server.js`；`agent.js` 和 `bot.js` 在启动时加载 MCP 服务器。

## 先跑起来

先写配置到 `~/.agent-state/mcp.json`（和会话、任务同目录，**不在工作区**）：

```json
{
  "servers": {
    "demo": {
      "command": "node",
      "args": ["/绝对路径/pbxrt-agent/lessons/lesson-08/demo_mcp_server.js"],
      "safe_tools": ["now", "word_count"]
    }
  }
}
```

然后正常启动终端版或 Telegram 版：

```bash
AGENT_WORKSPACE=~/agent-workspace npm run lesson-08
# 或
AGENT_WORKSPACE=~/agent-workspace node lessons/lesson-08/bot.js
```

启动日志会显示：

```text
[MCP] demo：已接入 2 个工具
```

之后模型就能调用 `mcp__demo__now` 和 `mcp__demo__word_count`。

## 一句话原理

MCP 服务器是一个独立进程。客户端通过它的 **stdin** 写 JSON-RPC 请求，通过 **stdout** 读响应，**一行一条消息**。握手（`initialize`）之后问它有哪些工具（`tools/list`），再把每个工具注册进第 2 课的 `TOOLS` 表。模型看到的仍是同一张工具菜单，不知道（也不关心）哪些工具来自本地、哪些来自 MCP。

## 新增文件

| 文件 | 作用 |
|---|---|
| `mcp_client.js` | `MCPServer`（进程 + JSON-RPC）、`registerServer`、`loadServers` |
| `demo_mcp_server.js` | 只用标准库实现的示例服务器，提供 `now` 和 `word_count` |

## `mcp_client.js`：进程即连接

### 启动与收发

```js
this.proc = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'ignore'], // 服务器的日志走 stderr，这里直接丢掉
  env: { ...process.env, ...env },
});
this.lines = readline.createInterface({ input: this.proc.stdout });
this.lines.on('line', (line) => this.onLine(line));
```

- 只保留 stdin / stdout / stderr 三个标准流；stderr 直接丢弃，避免服务器日志混进协议消息（demo server 的日志就写在 stderr）；
- `readline` 按行切分 stdout，每行一个 JSON；
- `spawn` 的命令和参数来自配置文件，所以配置必须放在工作区之外——能改配置，就能让 Agent 启动任意程序。

### 请求与响应配对

```js
request(method, params = {}) {
  this.nextId += 1;
  const id = this.nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new MCPError('超时')), TIMEOUT);
    this.waiting.set(id, { resolve, reject, timer });
    this.send({ jsonrpc: '2.0', id, method, params });
  });
}
```

- 每个请求有自增 `id`，响应靠 `id` 找回对应的 Promise；
- 30 秒超时，避免一个卡死的服务器拖住整个 Agent；
- 服务器进程退出时，所有等待中的请求立即 reject，不会永久挂起；
- `notifications/initialized` 这类通知没有 `id`，不需要回复；服务器主动发来的通知这一版直接忽略。

### 握手与工具发现

```js
async initialize() {
  const info = await this.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'pbxrt-agent', version: '0.8' },
  });
  this.notify('notifications/initialized');
  return info;
}

async listTools() {
  const tools = [];
  let cursor;
  for (;;) {
    const result = await this.request('tools/list', cursor ? { cursor } : {});
    tools.push(...(result.tools ?? []));
    cursor = result.nextCursor;
    if (!cursor) return tools;
  }
}
```

`tools/list` 支持游标分页，工具多的时候要一直翻到没有 `nextCursor`。

### 调用工具

```js
async callTool(tool, args) {
  const result = await this.request('tools/call', { name: tool, arguments: args });
  const parts = (result.content ?? []).map((block) =>
    block.type === 'text' ? block.text : `[${block.type} 内容，已省略]`,
  );
  const text = parts.join('\n') || '(空结果)';
  return result.isError ? `Error: ${text}` : text;
}
```

MCP 的返回是内容块数组，可能是文本、图片、音频。教学版只把文本拼起来，其他类型用一句占位符告诉模型“有这么个东西”，不把二进制塞进上下文。`isError` 为真时转成 `Error:` 前缀，和本地工具的错误格式一致。

## 注册进同一张表

```js
export async function registerServer(server, safe = []) {
  for (const t of await server.listTools()) {
    const full = `mcp__${server.name}__${t.name}`;
    TOOLS.set(full, {
      schema: {
        type: 'function',
        function: {
          name: full,
          description: `[MCP:${server.name}] ${(t.description ?? '').slice(0, 1000)}`,
          parameters: t.inputSchema ?? { type: 'object', properties: {} },
        },
      },
      func: (args) => server.callTool(t.name, args),
    });
    if (safe.includes(t.name)) TOOL_RISK.set(full, Risk.SAFE);
  }
  SERVERS.set(server.name, server);
}
```

几个设计点：

- **名字加前缀**：`mcp__<服务器>__<工具>`，避免不同服务器有同名工具，也方便看日志；
- **描述限长**：远程工具描述也会进入 system prompt，截到 1000 字符，防止一个服务器把上下文撑爆；
- **默认 `CONFIRM`**：没有在 `safe_tools` 里点名的工具都按有副作用处理，每次调用都要确认。只有明确知道是只读的工具才登记为 `SAFE`；
- **Schema 原样透传**：MCP 用的就是 JSON Schema，可以直接给 OpenAI function calling 用。

## 加载配置

```js
export const CONFIG_FILE = path.join(STATE_DIR, 'mcp.json');

export async function loadServers(configFile = CONFIG_FILE, log = console.log) {
  if (!fs.existsSync(configFile)) return;
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  for (const [name, spec] of Object.entries(config.servers ?? {})) {
    try {
      const server = new MCPServer(name, spec.command, spec.args ?? [], spec.env ?? {});
      await server.initialize();
      await registerServer(server, spec.safe_tools ?? []);
      log(`[MCP] ${name}：已接入 ... 个工具`);
    } catch (err) {
      log(`[MCP] ${name} 启动失败：${err.message}`);
    }
  }
}
```

- 配置文件不存在就静默跳过，不配 MCP 也能正常用；
- 每个服务器单独 `try/catch`：一个起不来，不影响其他服务器和本地工具；
- 配置里的 `env` 会叠加到子进程环境变量上，方便传 API Key；
- `agent.js` / `bot.js` 在创建 Session **之前**调用 `loadServers()`，这样第一个请求的工具菜单里就已经有 MCP 工具。

## demo server：协议的另一端

`demo_mcp_server.js` 只用 `readline`，逐行读 stdin、逐行写 stdout：

```js
for await (const line of lines) {
  const msg = JSON.parse(line);
  if (msg.id == null) continue; // 通知不需要回复
  const reply = { jsonrpc: '2.0', id: msg.id, result: handle(msg) };
  process.stdout.write(JSON.stringify(reply) + '\n');
  process.stderr.write(`[demo] 处理了 ${msg.method}\n`);
}
```

它实现三个方法：

| 方法 | 行为 |
|---|---|
| `initialize` | 返回协议版本、`capabilities.tools`、服务器信息 |
| `tools/list` | 返回 `now` 和 `word_count` 两个工具 |
| `tools/call` | 执行并返回 `{ content: [{ type: 'text', text }], isError }` |

两个工具都是只读的：`now` 返回当前时间，`word_count` 统计字符数和行数，所以在配置里可以把它们放进 `safe_tools`。

日志只能写 **stderr**。如果往 stdout 打一行普通文本，客户端会把它当成 JSON 解析失败，或者更糟——打乱协议。这是写 MCP 服务器最容易踩的坑。

## 设计取舍

- **手写客户端而不是用 SDK**：代码不到 200 行，能看清 JSON-RPC、握手、分页、内容块、超时这些协议细节；真实项目用官方 SDK 更省事。
- **stdio 传输**：不需要端口、网络和鉴权，服务器就是本地子进程；代价是不能跨机器。
- **配置放工作区之外**：启动任意程序的能力不能交给 Agent 自己改。
- **默认需要确认**：MCP 工具来源不可控，宁可多点一次，也不默认放行。
- **失败隔离**：单个服务器起不来只打日志，其余功能照常。

## 边界与下一课

第 8 课接上了外部工具，但上下文仍然是“一个 Agent 从头做到尾”：

- 要读很多文件、做很多调查时，中间过程会塞满主上下文；
- 没有并行调查能力；
- 没有计划模式；
- 没有长期记忆。

第 9 课加子 Agent：独立上下文、只把结论交回来，只读调查还能并行。完整路线见[项目 README](../../README.md)的课程表；上一课见[第 7 课 README](../lesson-07/README.md)。
