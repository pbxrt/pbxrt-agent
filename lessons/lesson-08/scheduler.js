/** scheduler.js —— 第 7 课：定时任务与心跳 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR } from './env.js'; // 第 4 课定义的状态目录，在工作区之外，Agent 不能直接改
import { tool } from './tools.js';

export const TASKS_FILE = path.join(STATE_DIR, 'tasks.json');
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TASKS = 20;
const PREAUTHORIZABLE = new Set(['fetch_url', 'write_file']); // run_shell 不能预授权
const HEARTBEAT_OK = 'HEARTBEAT_OK';

export const CURRENT = { chatId: null }; // 当前正在对话的聊天，由 bot.js 设置

/** 秒级 ISO 时间，和存进 tasks.json 的格式保持一致 */
const isoSeconds = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** 支持两种写法：every 30m / every 2h / daily 09:00 */
export function nextRun(spec, after = new Date()) {
  const s = String(spec).trim().toLowerCase();

  let m = /^every\s+(\d+)\s*([mh])$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const delta = (m[2] === 'm' ? 60_000 : 3_600_000) * n;
    if (delta < MIN_INTERVAL_MS) throw new Error('间隔不能小于 5 分钟');
    return new Date(after.getTime() + delta);
  }

  m = /^daily\s+(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) throw new Error('时间不合法');
    const t = new Date(after);
    t.setHours(hour, minute, 0, 0);
    return t > after ? t : new Date(t.getTime() + 24 * 60 * 60 * 1000);
  }

  throw new Error(`看不懂的时间规则：${JSON.stringify(spec)}，支持 every 30m / every 2h / daily 09:00`);
}

export class Scheduler {
  constructor(file = TASKS_FILE, now = () => new Date()) {
    this.file = file;
    this.now = now;
    this.tasks = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.tasks, null, 2), 'utf8');
    fs.renameSync(tmp, this.file); // 原子替换：写一半崩溃也不会留下坏文件
  }

  add(spec, prompt, chatId, allow = [], kind = 'task') {
    if (this.tasks.length >= MAX_TASKS) throw new Error(`最多 ${MAX_TASKS} 个任务`);
    const bad = [...allow].filter((a) => !PREAUTHORIZABLE.has(a));
    if (bad.length) throw new Error(`这些工具不能预授权：${bad.sort().join(', ')}`);
    const task = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 6),
      spec,
      prompt,
      chat_id: chatId,
      allow: [...allow].sort(),
      kind,
      next_run: isoSeconds(nextRun(spec, this.now())),
    };
    this.tasks.push(task);
    this.save();
    return task;
  }

  remove(taskId, chatId = null) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter(
      (t) => !(t.id === taskId && (chatId === null || t.chat_id === chatId)),
    );
    this.save();
    return this.tasks.length < before;
  }

  due() {
    const now = this.now();
    return this.tasks.filter((t) => new Date(t.next_run) <= now);
  }

  markStarted(task) {
    // 从"现在"算下一次，而不是从原定时间算：停机期间错过的不补跑
    task.next_run = isoSeconds(nextRun(task.spec, this.now()));
    this.save();
  }
}

let SCHED = null;

export function getScheduler() {
  SCHED ??= new Scheduler();
  return SCHED;
}

/** 无人值守：只放行创建任务时预授权过的工具 */
export function makeTaskAsk(task) {
  const allowed = new Set(task.allow ?? []);
  return async (name) => {
    if (allowed.has(name)) return ['y', ''];
    return ['n', '这是无人值守的定时任务，该操作没有被预授权'];
  };
}

const HEARTBEAT_PROMPT =
  `这是一次例行检查。按下面的要求检查；如果没有任何需要告诉用户的内容，` +
  `只回复 ${HEARTBEAT_OK}，不要回复其他任何文字。\n要求：`;

export function taskInput(task) {
  const head = `[定时任务 ${task.id}，无人值守，需要确认的操作会被拒绝]\n`;
  if (task.kind === 'heartbeat') return head + HEARTBEAT_PROMPT + task.prompt;
  return head + task.prompt;
}

export function formatTasks(tasks) {
  if (!tasks.length) return '当前没有定时任务。';
  return tasks
    .map(
      (t) =>
        `${t.id}  ${t.spec}  下次 ${t.next_run}  ` +
        `${t.kind === 'heartbeat' ? '[心跳] ' : ''}${t.prompt.slice(0, 40)}` +
        (t.allow.length ? `  预授权：${t.allow.join(',')}` : ''),
    )
    .join('\n');
}

export const scheduleTask = tool(
  'schedule_task',
  '创建一个定时任务，到时间后 Agent 会在无人值守的情况下执行 prompt，并把结果发给用户。' +
    'spec 写法：every 30m / every 2h / daily 09:00。' +
    'kind=heartbeat 表示例行检查，没有需要汇报的内容时不打扰用户。' +
    'allow 是逗号分隔的预授权工具，只能从 fetch_url、write_file 中选，可以为空。',
  {
    type: 'object',
    properties: {
      spec: { type: 'string' },
      prompt: { type: 'string' },
      kind: { type: 'string', enum: ['task', 'heartbeat'] },
      allow: { type: 'string' },
    },
    required: ['spec', 'prompt'],
  },
  ({ spec, prompt, kind = 'task', allow = '' }) => {
    if (CURRENT.chatId === null) return 'Error: 只能在消息渠道里创建定时任务';
    const allowSet = new Set(
      allow
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    );
    try {
      const t = getScheduler().add(spec, prompt, CURRENT.chatId, allowSet, kind);
      return `已创建任务 ${t.id}，下次执行：${t.next_run}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },
);

export const listTasks = tool(
  'list_tasks',
  '列出当前聊天的所有定时任务。',
  { type: 'object', properties: {} },
  () => formatTasks(getScheduler().tasks.filter((t) => t.chat_id === CURRENT.chatId)),
);

export const cancelTask = tool(
  'cancel_task',
  '取消一个定时任务。',
  { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  ({ task_id: taskId }) => {
    const ok = getScheduler().remove(taskId, CURRENT.chatId);
    return ok ? `已取消 ${taskId}` : `Error: 没有找到任务 ${taskId}`;
  },
);
