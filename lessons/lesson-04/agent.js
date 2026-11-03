/** agent.js —— 第 4 课：按真实 token 数决定清理还是压缩，会话可以保存 */
import OpenAI from 'openai';

import { compact, clearOldToolResults, loadSession, saveSession, truncateToolResult } from './context.js';
import { BASE_URL, MODEL, requireApiKey } from './env.js';
import { askLine, closeInput } from './io.js';
import { PermissionManager } from './permissions.js';
import { execute, getSchemas } from './tools.js';

const client = new OpenAI({ apiKey: requireApiKey(), baseURL: BASE_URL });
const MAX_STEPS = 20;
const SOFT_LIMIT = 16000; // 超过：清理旧工具结果
const HARD_LIMIT = 24000; // 超过：摘要压缩
// 这两个是演示用的小值，方便你复现。实际按模型窗口的比例来设。

const SYSTEM =
  '你是一个能使用工具的助手，在用户的工作区内完成任务。' +
  '必要时调用工具，完成后用简洁的语言汇报结果。';

const usage = { promptTokens: 0 }; // 上一次调用的真实 token 数（第 6 课会收进 Session）

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

async function run(userInput, messages, perms) {
  messages.push({ role: 'user', content: userInput });
  for (let step = 0; step < MAX_STEPS; step++) {
    // 用上一次调用的真实 token 数，决定这一轮要不要处理
    if (usage.promptTokens > HARD_LIMIT) {
      messages.splice(0, messages.length, ...(await compact(client, MODEL, messages)));
    } else if (usage.promptTokens > SOFT_LIMIT) {
      clearOldToolResults(messages);
    }

    const resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: getSchemas(),
    });
    usage.promptTokens = resp.usage?.prompt_tokens ?? 0;
    console.log(`   [prompt_tokens=${usage.promptTokens}]`);
    const msg = resp.choices[0].message;
    messages.push(assistantMessage(msg));

    if (!msg.tool_calls?.length) return msg.content || '';
    for (const call of msg.tool_calls) {
      console.log(`🔧 ${call.function.name}(${(call.function.arguments || '').slice(0, 80)})`);
      const result = await handleCall(call, perms);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: truncateToolResult(result), // 第 1 层
      });
    }
  }
  return '（达到最大步数，已停止）';
}

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

async function main() {
  const messages = loadSession('default') || [{ role: 'system', content: SYSTEM }];
  const perms = new PermissionManager();
  while (true) {
    const q = (await askLine('你> ')).trim();
    if (!q || q === 'exit' || q === 'quit') break;
    console.log(`\n${await run(q, messages, perms)}\n`);
    saveSession('default', messages);
  }
  closeInput();
}

await main();
