# 第 5 课：技能——AGENTS.md 常驻，SKILL.md 按需加载

每条任务都在 system prompt 里重复项目背景，既费 token 又容易漏。这一课把“常驻的项目说明”和“按需加载的能力说明书”分开：

- `AGENTS.md`：项目级约定，**每轮都在** system prompt 里；
- `skills/<name>/SKILL.md`：某个领域的完整操作说明，模型需要时调用 `load_skill` 才读取。

本课新增 `skills.js`，`permissions.js` 增加技能目录只读规则，`context.js` 在清理时保留技能内容。

## 先跑起来

在工作区里建一个技能：

```bash
mkdir -p ~/agent-workspace/skills/pdf
cat > ~/agent-workspace/skills/pdf/SKILL.md <<'EOF'
---
name: pdf
description: 读写 PDF：抽文字、合并、拆分
---
# PDF 技能

用 `pdftotext` 抽文字，用 `pdfunite` 合并。先确认命令已安装。
EOF
```

再写一个项目说明：

```bash
cat > ~/agent-workspace/AGENTS.md <<'EOF'
# 项目约定
- 所有输出文件放在 output/ 目录
- 改动前先读一遍现有代码
EOF
```

然后：

```bash
AGENT_WORKSPACE=~/agent-workspace npm run lesson-05
```

问一个和 PDF 有关的问题，模型应该会先调用 `load_skill({ name: "pdf" })`，再按技能里的说明执行。

## 一句话原理

**技能不是工具，而是给模型的说明书。** 系统提示里只放技能的名字和一句用途；完整正文放在磁盘上，模型判断需要时再调用 `load_skill` 读取。这样：

- 技能再多，常驻 prompt 也只增长几行；
- 技能正文可以很长、很具体，只在真正用到时消耗 token；
- 技能目录对 Agent 只读，模型不能自己改自己的“能力”。

## 新增文件

| 文件 | 作用 |
|---|---|
| `skills.js` | 解析 `SKILL.md`、发现技能、生成 system prompt 片段、注册 `load_skill` |

技能目录固定在 `WORKSPACE/skills`，由 `permissions.js` 导出：

```js
export const SKILLS_DIR = path.join(WORKSPACE, 'skills'); // 第 5 课
```

## `SKILL.md` 的格式

```markdown
---
name: pdf
description: 读写 PDF：抽文字、合并、拆分
---
# PDF 技能

正文……
```

`parseSkill` 只做最小解析：

- 第一行必须是 `---`，否则整份文件当正文；
- 读到下一个 `---` 结束 frontmatter；
- 每行按第一个 `:` 切成 key / value；
- 没有闭合的 `---` 就当没有 frontmatter，避免半截文件导致崩溃。

没有引入 YAML 库。技能元数据只需要 `name` 和 `description` 两个字符串，手写解析足够，也看得清。

## 发现与注入

`discover()` 扫描 `SKILLS_DIR` 下的一级子目录，找 `SKILL.md`：

- 没有 `description` 的技能会被跳过，并在终端提示一行——没有用途说明，模型无法判断何时加载；
- 技能名优先用 frontmatter 里的 `name`，没有就用目录名；
- 返回 `Map<name, { description, path }>`。

`skillsSection()` 生成 system prompt 片段：

```text
## 可用技能
下面只列出技能的名字和用途。当任务和某个技能的用途匹配时，
先调用 load_skill 读取完整说明，再按说明执行。
- pdf：读写 PDF：抽文字、合并、拆分
```

`projectNotes()` 读取工作区根目录的 `AGENTS.md`，截断到 3000 字符，放在“项目说明”小节。它每次启动都读，所以改 `AGENTS.md` 后重启即可生效。

`agent.js` 把它们拼起来：

```js
function buildSystem() {
  return BASE_SYSTEM + projectNotes() + skillsSection();
}
```

会话恢复时，system 消息会被重新生成：

```js
const messages = loadSession('default') || [{ role: 'system', content: '' }];
messages[0] = { role: 'system', content: buildSystem() };
```

这样新增或删除技能后，下次启动立刻反映到 prompt 里，不会沿用旧会话里过时的技能列表。

## `load_skill`：按需读取正文

```js
export const loadSkill = tool(
  'load_skill',
  '读取一个技能的完整说明。任务和「可用技能」列表里某个技能的用途匹配时调用。',
  { type: 'object', properties: { name: { type: 'string', description: '技能名' } }, required: ['name'] },
  ({ name }) => {
    const found = discover();
    if (!found.has(name)) return `Error: 没有名为 ... 的技能，可用：...`;
    // 读 SKILL.md，去掉 frontmatter，返回正文
  },
);
```

几个细节：

- 每次调用都重新 `discover()`，所以运行中新建的技能也能立刻加载；
- 返回内容以 `[skill]` 开头，第 4 课的清理逻辑靠这个前缀识别“不能清理”；
- 技能目录下除 `SKILL.md` 之外的文件会列在末尾，告诉模型“这里还有脚本/模板可以看”；
- 路径用相对工作区的形式展示，避免把主目录绝对路径写进上下文；
- 找不到技能时返回可用技能列表，模型可以自我纠正。

## 技能目录只读

`permissions.js` 的硬规则里新增：

```js
if (name === 'write_file' && isInside(resolved, SKILLS_DIR)) {
  return '技能目录是只读的，Agent 不能修改自己的技能。';
}
```

这必须放在**硬规则**里，而不是风险分级：如果只是 `CONFIRM`，用户可能顺手按了 `y`，模型就能改写自己的技能说明，下一次会话的行为就被篡改了。`load_skill` 则登记为 `SAFE`，读取不需要确认。

## 上下文清理时保留技能

第 4 课的 `clearOldToolResults` 会把旧工具结果替换成占位符。技能正文是很贵的“推理依据”，清掉之后模型会忘记刚学到的操作步骤。所以 `context.js` 增加：

```js
export const KEEP_PREFIXES = ['[skill]'];
```

清理时跳过以这些前缀开头的工具结果。注意这只影响“清理”这一层；如果上下文大到触发摘要压缩，技能正文仍然可能被摘要掉。真要长期保留，应该让技能说明尽量短，或者把它写进 `AGENTS.md`。

## 设计取舍

- **两级提示**：`AGENTS.md` 常驻（短、稳定），`SKILL.md` 按需（长、具体）。这比把所有说明都塞进 system prompt 省 token。
- **只放名字和用途**：模型需要判断“要不要加载”，所以描述要写清适用场景，而不是泛泛的“很有用”。
- **手写 frontmatter 解析**：只支持 `key: value`，够用且没有依赖；不支持的 YAML 特性不会被静默误解析。
- **技能目录只读**：能力定义必须由人维护，不能由 Agent 自我修改。
- **`load_skill` 是普通工具**：复用第 2 课的注册表、第 3 课的权限层，不需要新机制。

## 边界与下一课

第 5 课让 Agent 有了“领域知识”，但它仍然只能在终端里用：

- 没有聊天渠道，离开电脑就找不到它；
- 没有定时任务，不能无人值守地做事；
- 没有 MCP，接不上外部工具生态；
- 没有子 Agent、计划、记忆。

第 6 课把 Agent 接到 Telegram：长轮询收消息、聊天内确认、用户白名单。完整路线见[项目 README](../../README.md)的课程表；上一课见[第 4 课 README](../lesson-04/README.md)。
