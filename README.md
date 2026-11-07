# pbxrt-agent

一个能从 0 读到 1 的本地 Agent：**11 课，每课一个可运行的快照**。从 160 行左右的最小循环开始，一课加一个能力——工具注册表、权限、上下文管理、技能、聊天渠道、定时任务、MCP、子 Agent、计划、记忆——最后得到一个能在自己电脑上干活的 Agent。

只依赖 `openai` 一个包，没有 Agent 框架；跑起来不需要任何云服务。

课程代码在 `lessons/lesson-01` … `lessons/lesson-11`。每一课都是学完这一课时的完整代码，可以直接运行，也可以和相邻两课 diff：第 N 课就是第 N-1 课加一个文件。

## 快速开始

需要 Node.js 20.12+（用到 `process.loadEnvFile`、`import.meta.dirname`）。

```bash
npm install

# 把密钥写进项目根目录的 .env（这个文件已经在 .gitignore 里）
#   API_KEY=sk-...
# 也可以临时 export API_KEY=...

node lessons/lesson-01/agent.js "在当前目录创建 hello.js，打印 hello，并运行它"
npm run lesson-11        # 最终版，交互式
```

第 3 课起 Agent 只能操作工作区，默认是**启动命令时所在的目录**。建议显式指定，别指向主目录：

```bash
AGENT_WORKSPACE=~/agent-workspace npm run lesson-11
```

会话记录、定时任务、记忆会写到 `~/.agent-state`（在工作区之外，Agent 的文件工具碰不到），可以用 `AGENT_STATE_DIR` 改。

## 课程表

| 课 | 新增能力 | 新增文件 | 累计代码 |
|---|---|---|---|
| 01 | [最小循环：三个工具 + while](lessons/lesson-01/README.md) | `agent.js` | 160 行 |
| 02 | [工具注册表与统一执行器](lessons/lesson-02/README.md) | `tools.js`、`env.js` | 234 行 |
| 03 | [权限：硬规则 → 风险分级 → 人工确认](lessons/lesson-03/README.md) | `permissions.js`、`io.js` | 415 行 |
| 04 | [上下文：截断 → 清理 → 摘要，会话持久化](lessons/lesson-04/README.md) | `context.js` | 531 行 |
| 05 | [技能：AGENTS.md 常驻，SKILL.md 按需加载](lessons/lesson-05/README.md) | `skills.js` | 630 行 |
| 06 | [接 Telegram（长轮询、聊天内确认、白名单）](lessons/lesson-06/README.md) | `telegram.js`、`bot.js` | 812 行 |
| 07 | [定时任务与心跳（无人值守的预授权）](lessons/lesson-07/README.md) | `scheduler.js` | 1035 行 |
| 08 | [MCP：手写 stdio 客户端 + 一个 demo server](lessons/lesson-08/README.md) | `mcp_client.js`、`demo_mcp_server.js` | 1270 行 |
| 09 | [子 Agent：独立上下文、并行只读](lessons/lesson-09/README.md) | `subagent.js` | 1406 行 |
| 10 | [计划：待办清单 + 由代码强制只读的计划模式](lessons/lesson-10/README.md) | `planning.js` | 1519 行 |
| 11 | [记忆：MEMORY.md（每条确认）+ 会话检索](lessons/lesson-11/README.md) | `memory.js` | 1663 行 |

`env.js` / `io.js` 是两个小基础设施：前者读 `.env` 并导出公共配置，后者提供一个共用的 readline，避免确认框和主循环抢 stdin。

## 配置

都放在项目根目录的 `.env`（Node 内置 `process.loadEnvFile` 读取，已存在的环境变量优先）：

| 变量 | 作用 | 默认值 |
|---|---|---|
| `API_KEY` | 模型密钥 | 必填 |
| `BASE_URL` | OpenAI 兼容接口地址 | `https://api.deepseek.com` |
| `MODEL` | 模型名 | `deepseek-flash` |
| `AGENT_WORKSPACE` | Agent 的工作区（第 3 课起） | 启动命令时的目录 |
| `AGENT_STATE_DIR` | 会话、定时任务、记忆 | `~/.agent-state` |
| `TG_BOT_TOKEN` / `TG_ALLOWED_USERS` | 第 6 课起的 Telegram 机器人 | 无 |

第 8 课起可以接 MCP 服务器，配置写在 `~/.agent-state/mcp.json`：

```json
{
  "servers": {
    "demo": {
      "command": "node",
      "args": ["/绝对路径/lessons/lesson-08/demo_mcp_server.js"],
      "safe_tools": ["now", "word_count"]
    }
  }
}
```

## 设计说明

- **全链路 async**：工具执行、权限确认、`run()` 都返回 Promise；跨层的"当前是谁在跑"用 `AsyncLocalStorage`，并行子 Agent 用 `Promise.all`。
- **工具就是一个函数 + 一份 JSON Schema**：`tool(name, description, parameters, fn)` 注册，`execute(name, args)` 统一执行，永远返回字符串、永远不抛异常——错误也是给模型的输入。
- **权限三道关**：硬规则（工作区边界、危险命令黑名单）→ 风险分级（默认 `CONFIRM`）→ 人工确认（可注入，终端/Telegram/测试各用各的）。计划模式是**代码**强制只读，不是提示词约束。
- **上下文三层**：单个工具结果截断 → 清理旧工具结果（保留技能内容）→ 在 user 消息边界做摘要压缩。
- **状态在工作区之外**：会话、定时任务、记忆都在 `AGENT_STATE_DIR`，Agent 的文件工具碰不到，只能通过注册工具修改。
- **MCP**：`child_process` + `readline` 事件驱动，一行一条 JSON-RPC 消息，握手后把远端工具注册进同一张表。
- 入口用 `realpath` 判断"是不是直接运行"，目录带软链接也能进主循环；缺 `API_KEY` 时给一句人话而不是 SDK 堆栈。

## 测试

```bash
npm test     # 9 个 node:test 用例，全部用假模型，不需要 API Key
```

覆盖：路径逃逸、技能目录只读、计划模式、shell 黑名单、上下文的截断/清理/压缩、定时规则与预授权、记忆与会话检索。

## 安全提醒

这是教学代码，Agent 会真的执行命令、读写文件。第 3 课的权限机制能挡住误操作，**挡不住有意的攻击**：`run_shell` 是正则黑名单，不是沙箱。请在专门的工作区目录里运行，不要把工作区指向主目录。

## License

MIT，见 [LICENSE](LICENSE)。
