/** agent.js —— 第 2 课：主循环不再认识任何具体工具 */
import { createInterface } from 'node:readline/promises';

import OpenAI from 'openai';

import { BASE_URL, MODEL, requireApiKey } from './env.js';
import { execute, getSchemas } from './tools.js';

const client = new OpenAI({ apiKey: requireApiKey(), baseURL: BASE_URL });
const MAX_STEPS = 20; // 防止模型陷入无限循环

const SYSTEM =
  '你是一个能使用工具的助手，在用户当前目录下完成任务。' +
  '必要时调用工具，完成后用简洁的语言汇报结果。';

async function run(userInput, messages) {
  messages.push({ role: 'user', content: userInput });

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: getSchemas(),
    });
    const msg = resp.choices[0].message;
    messages.push(assistantMessage(msg));

    // 没有工具调用，说明模型给出了最终回答
    if (!msg.tool_calls?.length) return msg.content || '';

    // 模型可能一轮里请求多个工具，每个都必须回应
    for (const call of msg.tool_calls) {
      const name = call.function.name;
      let result;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        console.log(`🔧 ${name}(${(call.function.arguments || '').slice(0, 80)})`);
        result = await execute(name, args);
      } catch {
        result = 'Error: 参数不是合法的 JSON';
      }
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
const rl = createInterface({ input: process.stdin, output: process.stdout });
while (true) {
  let q;
  try {
    q = (await rl.question('你> ')).trim();
  } catch {
    break; // stdin 结束
  }
  if (!q || q === 'exit' || q === 'quit') break;
  console.log(`\n${await run(q, messages)}\n`);
}
rl.close();
