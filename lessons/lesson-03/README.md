# 第 3 课：权限——硬规则、风险分级、人工确认

第 2 课的 Agent 能读写文件和执行命令，但没有任何边界。这一课在“模型想调工具”和“工具真的执行”之间插入一个权限层：**先过不可能被放行的硬规则，再看风险等级，最后才问人。**

本课新增 `permissions.js`、`io.js`，加固 `tools.js`，并在 `agent.js` 里接入 `handleCall`。

## 先跑起来

```bash
# 建议显式指定工作区，不要指向主目录
AGENT_WORKSPACE=~/agent-workspace npm run lesson-03
```

进入 REPL 后，任何有副作用的操作都会先弹确认：

```text
⚠️  Agent 想执行：write_file
  路径：hello.js
    console.log('hello')
[y]允许 / [n]拒绝 / [a]本次会话一直允许 > y
```

非交互环境（管道、脚本、`echo` 喂输入）没有真人可以确认，默认拒绝。

## 一句话原理

`PermissionManager.check(name, args)` 按固定顺序做三件事：

```text
硬规则（工作区、危险命令） → 风险分级（SAFE / CONFIRM / DENY） → 人工确认（可记住 write_file）
```

任何一关拒绝，都不会执行工具；拒绝原因会作为工具结果回给模型，让它换一条路，而不是让整个 Agent 崩掉。

## 新增文件

| 文件 | 作用 |
|---|---|
| `permissions.js` | 风险表、工作区解析、危险命令规则、确认界面、`PermissionManager` |
| `io.js` | 终端输入共用一个 readline，确认框和主循环不抢 stdin |

`tools.js` 在本课被加固：文件工具自己也会检查工作区；`run_shell` 固定 `cwd` 并支持超时。`agent.js` 新增 `handleCall`，在所有工具执行前调用权限检查。

## `permissions.js`：三道关

### 第 1 关：硬规则

```js
hardLimits(name, args) {
  if (name === 'read_file' || name === 'write_file' || name === 'list_dir') {
    if (resolveInWorkspace(args.path ?? '.') === null) {
      return `路径 ... 在工作区 ${WORKSPACE} 之外，禁止访问。`;
    }
  }
  if (name === 'run_shell') {
    for (const pattern of SHELL_DENY_PATTERNS) {
      if (pattern.test(args.command ?? '')) return '命令命中危险模式...';
    }
  }
  return null;
}
```

硬规则的特点是**人工确认也放行不了**：工作区之外的文件、`sudo`、`rm -rf /`、`mkfs`、`dd if=`、fork bomb、`curl ... | sh` 等，直接拒绝。这是安全边界，不是提示词建议。

`resolveInWorkspace` 会：

- 把 `~` 展开成主目录；
- 以 `WORKSPACE` 为基准解析相对路径；
- 用 `realpathLoose` 展开已存在部分的软链接；
- 最后用 `isInside` 判断结果是否仍在工作区内。

因此 `../../etc/passwd`、绝对路径 `/etc/passwd`、以及“工作区里一个指向外部的软链接”都会被识别。`resolveInWorkspace` 返回 `null` 表示越界。

### 第 2 关：风险分级

| 等级 | 含义 | 当前工具 |
|---|---|---|
| `SAFE` | 只读，直接放行 | `list_dir`、`read_file` |
| `CONFIRM` | 有副作用，问人 | `write_file`、`run_shell`、`fetch_url` |
| `DENY` | 永远不允许 | 本课没有登记，预留 |

没有登记的工具一律按 `CONFIRM` 处理。这个默认值很重要：以后新增工具时，**忘记登记不会变成“默默放行”**，而是每次都要人确认。

`REMEMBERABLE` 目前只有 `write_file`：用户可以按 `a` 让本会话后续的写文件不再问。`run_shell` 故意不在里面——每条命令都要过目。

### 第 3 关：人工确认

`askTerminal` 会：

- 非 TTY 直接返回 `['n', '当前是非交互环境，无法确认']`；
- 打印工具名和将要执行的**真实内容**，而不是模型的自述。`renderCall` 对 shell 显示完整命令，对 `write_file` 显示路径和内容预览（超过 400 字符截断并注明总长度）；
- 接受 `y` / `n` / `a`，非法输入循环重问；
- 拒绝时可以附一句原因，原因会写进返回给模型的字符串；
- stdin 结束时返回拒绝，避免卡死。

拒绝消息不只是“用户拒绝了”，还会告诉模型“不要重试同一操作，请换一种方式或说明理由”。这能减少模型反复撞同一堵墙。

`ask` 是可注入的：终端用 `PermissionManager.askTerminal`，测试可以传一个假函数，第 6 课会换成 Telegram 聊天确认，第 7 课会换成无人值守的预授权。

## `io.js`：一个共用的 readline

确认框和主循环都要读 stdin。如果各自创建 `readline.Interface`，两个读取器会抢输入。`io.js` 懒加载一个单例：

```js
let rl;
export function getReadline() {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
```

`askLine` 是 `rl.question` 的 Promise 包装；stdin 已关闭时返回空串，调用方把它当作“退出/拒绝”。`closeInput` 在程序结束时统一关闭。

## `tools.js`：双保险

工具实现里又检查了一次工作区：

```js
const target = resolveInWorkspace(p);
if (target === null) return '[错误] 路径在工作区之外';
```

这不是重复劳动。权限层可能被绕过、被替换，或者某个调用路径忘了走 `check`；工具层自己的检查是最后一道保险。`run_shell` 则固定 `cwd: WORKSPACE`，避免命令在启动目录而不是工作区里执行；`timeout` 默认 30 秒，超时返回 `[超时]` 字符串而不是抛异常。

## `agent.js`：先检查，再执行

```js
async function handleCall(call, perms) {
  const name = call.function.name;
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return 'Error: 参数不是合法的 JSON';
  }
  const decision = await perms.check(name, args);
  if (!decision.allowed) return `[权限拒绝] ${decision.reason}`;
  return execute(name, args);
}
```

`perms` 在 `main` 里只创建一次，整个会话共用。这样“本次会话一直允许”才能跨多轮生效。`run()` 的每一轮对每个 `tool_call` 都走这个入口。

## 设计取舍

- **权限层独立于工具**：工具只关心“怎么做”，权限关心“能不能做”。以后加工具不用复制确认逻辑。
- **硬规则不可协商**：工作区和危险命令不提供“仍然执行”的选项。确认只用于有副作用但可接受的操作。
- **拒绝也是工具结果**：模型能看到具体原因并调整策略，而不是收到一个异常。
- **黑名单不是沙箱**：`SHELL_DENY_PATTERNS` 只是安全带。`run_shell` 仍然能执行很多有副作用的命令，真正的隔离要靠容器或虚拟机。
- **按内容确认**：展示真实命令和真实文件内容，避免模型用一句“只是查看一下”骗过确认框。

## 边界与下一课

第 3 课解决了“能不能动”的问题，但还有几个明显的缺口：

- 上下文仍然无限增长，只有工具结果 8000 字符截断；
- 会话退出就丢，不能接着上次聊；
- 没有技能、聊天渠道、定时任务、MCP、子 Agent、计划、记忆；
- 没有“计划模式”——第 10 课才会用代码强制只读。

第 4 课先解决上下文：截断、清理旧工具结果、摘要压缩，并把会话保存到工作区之外。完整路线见[项目 README](../../README.md)的课程表；上一课见[第 2 课 README](../lesson-02/README.md)。
