/** bot.js —— 第 6、7 课：常驻的 Agent */
import fs from 'node:fs';
import path from 'node:path';

import { makeClient, run, Session } from './agent.js';
import { SESSION_DIR } from './context.js';
import { loadServers } from './mcp_client.js';
import { REMEMBERABLE, renderCall } from './permissions.js';
import * as scheduler from './scheduler.js';
import { Telegram } from './telegram.js';

const ALLOWED = new Set(
  (process.env.TG_ALLOWED_USERS || '')
    .split(',')
    .filter((x) => x.trim())
    .map(Number),
);
const CONFIRM_WAIT = 120;
const POLL_TIMEOUT = 10; // 第 7 课：缩短轮询，给调度器留出检查的机会

function makeChatAsk(channel, chatId, wait = CONFIRM_WAIT) {
  return async (name, args) => {
    let options = 'y 允许 / n 拒绝（可附原因，如：n 先列出来给我看）';
    if (REMEMBERABLE.has(name)) options += ' / a 本会话一直允许';
    await channel.send(
      chatId,
      `⚠️ Agent 想执行：${name}\n${renderCall(name, args)}\n\n回复 ${options}\n${wait} 秒内不回复视为拒绝。`,
    );
    const deadline = Date.now() + wait * 1000;
    while (Date.now() < deadline) {
      const left = Math.max(1, Math.round((deadline - Date.now()) / 1000));
      for (const [c, u, text] of await channel.fetch(Math.min(20, left))) {
        const [answer, ...rest] = text.trim().split(' ');
        if (c === chatId && ['y', 'n', 'a'].includes(answer.toLowerCase())) {
          return [answer.toLowerCase(), rest.join(' ').trim()];
        }
        channel.pending.push([c, u, text]);
      }
    }
    return ['n', '确认超时'];
  };
}

async function handleMessage(tg, client, sessions, chatId, userId, text) {
  if (!ALLOWED.has(userId)) {
    console.log(`[忽略] 非白名单用户 ${userId}`);
    return;
  }
  const cmd = text.trim();
  if (cmd === '/reset') {
    sessions.delete(chatId);
    fs.rmSync(path.join(SESSION_DIR, `tg-${chatId}.json`), { force: true });
    await tg.send(chatId, '会话已重置。');
    return;
  }
  if (cmd === '/tasks') {
    await tg.send(
      chatId,
      scheduler.formatTasks(scheduler.getScheduler().tasks.filter((t) => t.chat_id === chatId)),
    );
    return;
  }

  let s = sessions.get(chatId);
  if (!s) {
    s = new Session(`tg-${chatId}`, { ask: makeChatAsk(tg, chatId) });
    sessions.set(chatId, s);
  }
  const backup = [...s.messages];
  scheduler.CURRENT.chatId = chatId;
  let reply;
  try {
    reply = await run(s, text, client);
  } catch (err) {
    s.messages.splice(0, s.messages.length, ...backup); // 回滚，避免留下没有配对的 tool_calls
    reply = `[出错，本轮已撤销] ${err.name}: ${err.message}`;
  } finally {
    scheduler.CURRENT.chatId = null;
  }
  s.save();
  await tg.send(chatId, reply);
}

async function runDueTasks(tg, client) {
  const sched = scheduler.getScheduler();
  for (const task of sched.due()) {
    sched.markStarted(task); // 先记下一次，再执行：任务崩了也不会反复重跑
    const s = new Session(`task-${task.id}`, {
      ask: scheduler.makeTaskAsk(task),
      persist: false,
    });
    let reply;
    try {
      reply = await run(s, scheduler.taskInput(task), client);
    } catch (err) {
      reply = `[定时任务出错] ${err.name}: ${err.message}`;
    }
    if (task.kind === 'heartbeat' && reply.trim() === scheduler.HEARTBEAT_OK) {
      console.log(`[心跳] ${task.id} 无事`);
      continue;
    }
    await tg.send(task.chat_id, `⏰ 任务 ${task.id}\n${reply}`);
  }
}

async function main() {
  if (!ALLOWED.size) {
    console.error('必须设置 TG_ALLOWED_USERS（逗号分隔的 Telegram 用户 ID），否则任何人都能操作你的电脑。');
    process.exit(1);
  }
  if (!process.env.TG_BOT_TOKEN) {
    console.error('缺少 TG_BOT_TOKEN：在项目根目录的 .env 里写 TG_BOT_TOKEN=你的机器人 token');
    process.exit(1);
  }
  const tg = new Telegram(process.env.TG_BOT_TOKEN, { timeout: POLL_TIMEOUT });
  const client = makeClient();
  await loadServers(); // 第 8 课
  const sessions = new Map();
  console.log('Agent 已启动，Ctrl-C 退出');
  while (true) {
    let batch;
    try {
      batch = await tg.poll();
    } catch (err) {
      console.log(`[轮询出错] ${err.message}，5 秒后重试`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const [chatId, userId, text] of batch) {
      await handleMessage(tg, client, sessions, chatId, userId, text);
    }
    await runDueTasks(tg, client);
  }
}

await main();
