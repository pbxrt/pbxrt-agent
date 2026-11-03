/** agent.js —— 第 6 课起：Agent 核心与输入输出分离 */
import { realpathSync } from 'node:fs';

import OpenAI from 'openai';

import { compact, clearOldToolResults, loadSession, saveSession, truncateToolResult } from './context.js';
import { BASE_URL, MODEL, requireApiKey } from './env.js';
import { askLine, closeInput } from './io.js';
import { PermissionManager } from './permissions.js';
import { projectNotes, skillsSection } from './skills.js'; // 导入即注册 load_skill（第 5 课）
import { execute, getSchemas } from './tools.js';
import './scheduler.js'; // 导入即注册 schedule_task 等（第 7 课）

const MAX_STEPS = 20;
const SOFT_LIMIT = 16000;
const HARD_LIMIT = 24000;

const BASE_SYSTEM =
  '你是一个能使用工具的助手，在用户的工作区内完成任务。' +
  '必要时调用工具，完成后用简洁的语言汇报结果。';

export function makeClient() {
  return new OpenAI({ apiKey: requireApiKey(), baseURL: BASE_URL });
}

export function buildSystem() {
  return BASE_SYSTEM + projectNotes() + skillsSection();
}

/** 一个会话 = 一份 messages + 一个权限管理器 + 上一次的 token 数 */
export class Session {
  constructor(name, { ask = null, persist = true } = {}) {
    this.name = name;
    this.persist = persist;
    const saved = persist ? loadSession(name) : null;
    this.messages = saved ?? [{ role: 'system', content: '' }];
    this.messages[0] = { role: 'system', content: buildSystem() }; // 每次用最新的技能列表
    this.perms = new PermissionManager({ ask: ask ?? undefined });
    this.promptTokens = 0;
  }

  save() {
    if (this.persist) saveSession(this.name, this.messages);
  }
}

export async function handleCall(call, perms) {
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

export async function run(session, userInput, client, model = MODEL, log = console.log) {
  const messages = session.messages;
  messages.push({ role: 'user', content: userInput });
  for (let step = 0; step < MAX_STEPS; step++) {
    if (session.promptTokens > HARD_LIMIT) {
      messages.splice(0, messages.length, ...(await compact(client, model, messages)));
    } else if (session.promptTokens > SOFT_LIMIT) {
      clearOldToolResults(messages);
    }

    const resp = await client.chat.completions.create({
      model,
      messages,
      tools: getSchemas(),
    });
    session.promptTokens = resp.usage?.prompt_tokens ?? 0;
    const msg = resp.choices[0].message;
    messages.push(assistantMessage(msg));

    if (!msg.tool_calls?.length) return msg.content || '';
    for (const call of msg.tool_calls) {
      log(`🔧 ${call.function.name}(${(call.function.arguments || '').slice(0, 80)})`);
      const result = await handleCall(call, session.perms);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: truncateToolResult(result),
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
  const client = makeClient();
  const session = new Session('default');
  while (true) {
    const q = (await askLine('你> ')).trim();
    if (!q || q === 'exit' || q === 'quit') break;
    console.log(`\n${await run(session, q, client)}\n`);
    session.save();
  }
  closeInput();
}

// 只有直接运行这个文件时才进交互循环；被 bot.js import 时不进
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    await main();
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
}
