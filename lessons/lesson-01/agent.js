/**
 * 第 1 课：最小 Agent（约 160 行，含注释）
 *
 * 用法：
 *   # 项目根目录的 .env 里写好 API_KEY=你的模型密钥
 *   node lessons/lesson-01/agent.js "在当前目录创建 hello.py，打印 hello，并运行它"
 *
 * 默认用 DeepSeek。换别的 OpenAI 兼容模型，设置 BASE_URL 和 MODEL 两个环境变量即可。
 */
import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

import OpenAI from 'openai';

// 读项目根目录的 .env（Node 20.12+ 内置，不需要 dotenv）
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env'));
} catch {
  // 没有 .env 就跳过，export API_KEY=... 同样有效
}

const MODEL = process.env.MODEL || 'deepseek-flash';
const MAX_STEPS = 20; // 防止死循环：Agent 最多转 20 圈
const execAsync = promisify(exec);

const SYSTEM =
  '你是一个能操作本地文件和命令行的编程助手。' +
  '需要时调用工具，完成任务后直接用文字总结，不要再调用工具。';


// ---------- 1. 工具：就是普通的 async 函数 ----------
const readFile = ({ path: p }) => fs.readFile(p, 'utf8');

const writeFile = async ({ path: p, content }) => {
  await fs.writeFile(p, content, 'utf8');
  return `已写入 ${p}（${content.length} 字符）`;
};

const runShell = async ({ command }) => {
  // 第 1 课先用最朴素的权限控制：每条命令人工确认
  const answer = (await ask(`\n[需要确认] 执行命令：${command}\n允许？(y/n) `)).trim().toLowerCase();
  if (answer !== 'y') return '用户拒绝执行该命令';
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    return (stdout + stderr).slice(-4000) || '(无输出)'; // 截断，避免撑爆上下文
  } catch (err) {
    if (err.killed) return '命令超时（60 秒）';
    return `[exit ${err.code ?? 1}]\n${err.stdout ?? ''}${err.stderr ?? ''}`.slice(-4000);
  }
};

const TOOL_FUNCS = new Map([
  ['read_file', readFile],
  ['write_file', writeFile],
  ['run_shell', runShell],
]);

// ---------- 2. 工具说明：告诉模型有哪些工具、参数是什么 ----------
const tool = (name, description, props) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(props).map(([k, v]) => [k, { type: 'string', description: v }]),
      ),
      required: Object.keys(props),
    },
  },
});

const TOOLS = [
  tool('read_file', '读取文件内容', { path: '文件路径' }),
  tool('write_file', '写入文件（覆盖）', { path: '文件路径', content: '完整文件内容' }),
  tool('run_shell', '执行 shell 命令并返回输出', { command: '要执行的命令' }),
];

// ---------- 3. 核心：Agent 循环 ----------
async function run(client, task) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: task },
  ];
  for (let step = 1; step <= MAX_STEPS; step++) {
    const resp = await client.chat.completions.create({ model: MODEL, messages, tools: TOOLS });
    const msg = resp.choices[0].message;
    messages.push(assistantMessage(msg));

    // 模型没有要调用工具 = 它认为任务做完了，循环结束
    if (!msg.tool_calls?.length) {
      console.log(`\n[完成，共 ${step} 步]\n${msg.content}`);
      return;
    }

    // 模型要调用工具：执行，并把结果作为 tool 消息喂回去
    for (const call of msg.tool_calls) {
      const name = call.function.name;
      console.log(`[第 ${step} 步] ${name}(${(call.function.arguments || '').slice(0, 80)})`);
      let result;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        const fn = TOOL_FUNCS.get(name);
        if (!fn) throw new Error(`没有工具 ${name}`);
        result = await fn(args);
      } catch (err) {
        // 工具出错也要告诉模型，让它自己修正
        result = `工具执行出错：${err.name}: ${err.message}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  console.log(`\n[达到 ${MAX_STEPS} 步上限，已停止]`);
}

/** 把 SDK 返回的 message 转成可以原样塞回 messages 的普通对象 */
function assistantMessage(msg) {
  const out = { role: 'assistant', content: msg.content ?? null };
  if (msg.tool_calls?.length) {
    out.tool_calls = msg.tool_calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.function.name, arguments: c.function.arguments },
    }));
  }
  if (msg.reasoning_content) out.reasoning_content = msg.reasoning_content;
  return out;
}

// ----------  stdin：确认和主循环共用一个读取器 ----------
let rl;
const ask = async (prompt) => {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } catch {
    return ''; // stdin 已结束，当作没有回答
  }
};

const task = process.argv[2];
if (!task) {
  console.error('用法：node lessons/lesson-01/agent.js "你的任务"');
  process.exit(1);
}
if (!process.env.API_KEY) {
  console.error('缺少 API_KEY：在项目根目录的 .env 里写 API_KEY=你的密钥');
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL || 'https://api.deepseek.com',
});
await run(client, task);
rl?.close();
