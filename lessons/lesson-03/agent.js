/** agent.js —— 第 3 课：工具执行前先过权限检查 */
import OpenAI from 'openai';

import { BASE_URL, MODEL, requireApiKey } from './env.js';
import { askLine, closeInput } from './io.js';
import { PermissionManager } from './permissions.js';
import { execute, getSchemas } from './tools.js';

const client = new OpenAI({ apiKey: requireApiKey(), baseURL: BASE_URL });
const MAX_STEPS = 20;

const SYSTEM =
  '你是一个能使用工具的助手，在用户的工作区内完成任务。' +
  '必要时调用工具，完成后用简洁的语言汇报结果。';

/** 解析参数 → 权限检查 → 执行。永远返回字符串。 */
async function handleCall(call, perms) {
  const name = call.function.name;
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return 'Error: 参数不是合法的 JSON';
  }
  const decision = await perms.check(name, args);
  if (!decision.allowed) return `[权限拒绝] ${decision.reason}`; // 拒绝也要回传，让模型换条路
  return execute(name, args);
}

async function run(userInput, messages, perms) {
  messages.push({ role: 'user', content: userInput });
  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: getSchemas(),
    });
    const msg = resp.choices[0].message;
    messages.push(assistantMessage(msg));
    if (!msg.tool_calls?.length) return msg.content || '';
    for (const call of msg.tool_calls) {
      console.log(`🔧 ${call.function.name}(${(call.function.arguments || '').slice(0, 80)})`);
      const result = await handleCall(call, perms);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
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

const messages = [{ role: 'system', content: SYSTEM }];
const perms = new PermissionManager(); // 整个会话共用，"一直允许"记在它身上
while (true) {
  const q = (await askLine('你> ')).trim();
  if (!q || q === 'exit' || q === 'quit') break;
  console.log(`\n${await run(q, messages, perms)}\n`);
}
closeInput();
