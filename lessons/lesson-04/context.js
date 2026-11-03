/** context.js —— 第 4 课：截断 → 清理 → 摘要，会话持久化 */
import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR } from './env.js';

const MAX_TOOL_CHARS = 4000; // 单个工具结果最多保留的字符数
const KEEP_RECENT_TOOL_RESULTS = 3; // 清理时，保留最近几条工具结果
const KEEP_LAST_TURNS = 2; // 压缩时，原样保留最近几轮用户对话

// 会话记录放在工作区之外，Agent 的文件工具碰不到
export const SESSION_DIR = path.join(STATE_DIR, 'sessions');

export const PLACEHOLDER = '[旧工具结果已清理，如需要请重新调用工具]';

const SUMMARY_PROMPT = `你是对话摘要器。把下面这段 Agent 的历史对话压缩成摘要，要求：
1. 保留：用户的目标、已完成的步骤、关键结论、重要的文件路径和参数、尚未解决的问题
2. 丢弃：寒暄、重复内容、工具返回的大段原文
3. 用简洁的条目写，不要超过 500 字
只输出摘要本身。`;

/** 第 1 层：截断工具结果 */
export function truncateToolResult(text, limit = MAX_TOOL_CHARS) {
  const s = String(text);
  if (s.length <= limit) return s;
  const half = Math.floor(limit / 2);
  return `${s.slice(0, half)}\n...[中间省略 ${s.length - limit} 字符]...\n${s.slice(-half)}`;
}

/** 第 2 层：清理旧的工具结果（只改内容，不删消息） */
export function clearOldToolResults(messages, keep = KEEP_RECENT_TOOL_RESULTS) {
  const toolIdx = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  const old = keep > 0 ? toolIdx.slice(0, -keep) : toolIdx;
  for (const i of old) messages[i].content = PLACEHOLDER;
}

/**
 * 第 3 层：摘要压缩（只在 user 消息处切）。
 * 返回 [要被压缩的旧消息, 原样保留的新消息]；没有可压缩的内容返回 null。约定 messages[0] 是 system。
 */
export function splitForCompact(messages, keepTurns = KEEP_LAST_TURNS) {
  const userIdx = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  if (userIdx.length <= keepTurns) return null;
  const cut = userIdx[userIdx.length - keepTurns];
  return [messages.slice(1, cut), messages.slice(cut)];
}

export function renderForSummary(msgs) {
  return msgs
    .map((m) => {
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const calls = m.tool_calls
          .map((c) => `${c.function.name}(${c.function.arguments})`)
          .join(', ');
        return (m.content ? `[assistant] ${m.content}\n` : '') + `[assistant 调用工具] ${calls}`;
      }
      return `[${m.role}] ${m.content ?? ''}`;
    })
    .join('\n');
}

export async function compact(client, model, messages) {
  const parts = splitForCompact(messages);
  if (parts === null) return messages;
  const [old, recent] = parts;
  const resp = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: renderForSummary(old) },
    ],
  });
  const summary = resp.choices[0].message.content;
  return [
    messages[0],
    { role: 'user', content: `[以下是此前对话的摘要]\n${summary}` },
    { role: 'assistant', content: '好的，我已了解之前的进展，继续。' },
    ...recent,
  ];
}

/** 会话持久化 */
export function saveSession(name, messages) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSION_DIR, `${name}.json`), JSON.stringify(messages, null, 2), 'utf8');
}

export function loadSession(name) {
  const file = path.join(SESSION_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
