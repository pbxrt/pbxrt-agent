/**
 * subagent.js —— 第 9 课：子 Agent
 *
 * 子 Agent 就是一个新的 Session：自己的 messages、自己的工具清单、自己的步数上限。
 * 父 Agent 只拿回它最后的一段文字，中间读了多少文件、试错了多少次，都不进父 Agent 的上下文。
 */
import { Risk, TOOL_RISK } from './permissions.js';
import { tool, TOOLS } from './tools.js';

const MAX_DEPTH = 1; // 只允许一层：子 Agent 不能再派子 Agent
const SUB_MAX_STEPS = 15;
const MAX_PARALLEL = 3;
const RESULT_LIMIT = 3000; // 子 Agent 交回来的结论最多这么长

// 这些工具子 Agent 永远拿不到：派生、定时任务都只能由主 Agent 做
const NEVER_FOR_SUB = new Set([
  'delegate',
  'delegate_parallel',
  'schedule_task',
  'cancel_task',
  'list_tasks',
  'submit_plan', // 第 10 课：计划只能由主 Agent 提交
  'remember', // 第 11 课：记忆只能由主 Agent 提议
]);

const SUB_SYSTEM =
  '你是一个子 Agent，被主 Agent 派来完成一件具体的事。' +
  '你看不到主 Agent 和用户之前的对话，只能根据下面的任务说明行动。' +
  '完成后用简洁的文字汇报结论，写清楚依据（读了哪些文件、看到了什么），' +
  '不要贴大段原文。做不到就直接说明原因。';

/** explore：只拿只读工具；worker：除了派生和定时之外的全部工具。 */
export function toolset(kind) {
  let names = [...TOOLS.keys()].filter((n) => !NEVER_FOR_SUB.has(n));
  if (kind === 'explore') names = names.filter((n) => TOOL_RISK.get(n) === Risk.SAFE);
  return new Set(names);
}

async function spawn(task, kind, parent, client, model, log, idx = null) {
  const { Session, run } = await import('./agent.js'); // 延迟导入，避免和 agent.js 循环引用
  const tag = `子Agent${idx === null ? '' : idx}`;
  const sub = new Session(`${parent.name}/${tag}`, {
    ask: parent.perms.ask,
    persist: false,
    tools: toolset(kind),
    system: SUB_SYSTEM,
    depth: parent.depth + 1,
  });
  sub.perms.mode = parent.perms.mode; // 第 10 课：计划模式下派出去的子 Agent 也只能读
  try {
    let result = await run(sub, task, client, model, (m) => log(`  [${tag}] ${m}`), SUB_MAX_STEPS);
    if (result.length > RESULT_LIMIT) {
      result = result.slice(0, RESULT_LIMIT) + '\n...（子 Agent 的结论过长，已截断）';
    }
    return `[${tag} 的结论]\n${result}`;
  } catch (err) {
    return `[${tag} 出错] ${err.name}: ${err.message}`;
  }
}

async function current() {
  const { CURRENT } = await import('./agent.js');
  const cur = CURRENT.getStore();
  if (!cur) throw new Error('只能在 Agent 运行时调用');
  if (cur.session.depth >= MAX_DEPTH) throw new Error('子 Agent 不能再派生子 Agent');
  return cur;
}

export const delegate = tool(
  'delegate',
  '把一件边界清楚的子任务交给一个子 Agent。它有独立的上下文，看不到当前对话，' +
    '所以 task 里要写清目标、范围和希望交回的格式。' +
    'kind=explore 只能读（查资料、读代码、找文件），kind=worker 还能写文件和执行命令，' +
    '每个有副作用的操作照样需要用户确认。适合：要读很多内容但只需要结论的任务。',
  {
    type: 'object',
    properties: {
      task: { type: 'string', description: '完整的任务说明' },
      kind: { type: 'string', enum: ['explore', 'worker'] },
    },
    required: ['task'],
  },
  async ({ task, kind = 'explore' }) => {
    let cur;
    try {
      cur = await current();
    } catch (err) {
      return `Error: ${err.message}`;
    }
    return spawn(task, kind, cur.session, cur.client, cur.model, cur.log);
  },
);

export const delegateParallel = tool(
  'delegate_parallel',
  `同时派出多个只读子 Agent（最多 ${MAX_PARALLEL} 个），各自完成一件互不依赖的调查，` +
    '返回所有结论。tasks 是任务说明的列表。只能读，不能写。',
  { type: 'object', properties: { tasks: { type: 'array', items: { type: 'string' } } }, required: ['tasks'] },
  async ({ tasks }) => {
    let cur;
    try {
      cur = await current();
    } catch (err) {
      return `Error: ${err.message}`;
    }
    if (!tasks?.length) return 'Error: tasks 不能为空';
    if (tasks.length > MAX_PARALLEL) return `Error: 一次最多 ${MAX_PARALLEL} 个子 Agent，你给了 ${tasks.length} 个`;
    const results = await Promise.all(
      tasks.map((t, i) => spawn(t, 'explore', cur.session, cur.client, cur.model, cur.log, i + 1)),
    );
    return results.join('\n\n');
  },
);
