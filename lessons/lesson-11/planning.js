/**
 * planning.js —— 第 10 课：待办清单与计划模式
 *
 * 两样东西，解决两个不同的问题：
 * - update_plan：长任务做到一半忘了还剩什么。让模型把步骤写下来，每做完一步就更新。
 * - 计划模式：动手之前先让人看一眼方案。只读由权限层强制，计划经你批准才放行。
 */
import { tool } from './tools.js';

const STATUS = { pending: '[ ]', in_progress: '[→]', completed: '[x]' };
const PLAN_MARK = '[plan]';
const OLD_PLAN = '[plan] 这是旧版计划，已被后面的版本取代';

const PLAN_MODE_PREFIX =
  '[计划模式] 先调查，不要修改任何东西（有副作用的工具会被拒绝）。' +
  '想清楚之后调用 submit_plan 提交一份分步骤的计划，等用户批准后再执行。\n任务：';

async function session() {
  const { CURRENT } = await import('./agent.js'); // 延迟导入，避免循环引用
  const cur = CURRENT.getStore();
  if (!cur) throw new Error('只能在 Agent 运行时调用');
  return cur.session;
}

export function render(steps) {
  return steps.map((s) => `${STATUS[s.status]} ${s.step}`).join('\n');
}

export const updatePlan = tool(
  'update_plan',
  '记录或更新当前任务的分步计划。步骤超过 3 步的任务，开始前先写计划；' +
    '每完成一步就再调用一次，把状态改掉。同一时间最多一个步骤是 in_progress。' +
    '每次都传完整的步骤列表。',
  {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string' },
            status: { type: 'string', enum: Object.keys(STATUS) },
          },
          required: ['step', 'status'],
        },
      },
    },
    required: ['steps'],
  },
  async ({ steps }) => {
    if (!steps?.length) return 'Error: steps 不能为空';
    const bad = steps.find((s) => !(s.status in STATUS) || !s.step);
    if (bad) {
      return `Error: 步骤格式不对：${JSON.stringify(bad)}，status 只能是 ${Object.keys(STATUS).join(', ')}`;
    }
    if (steps.filter((s) => s.status === 'in_progress').length > 1) {
      return 'Error: 同一时间最多一个步骤是 in_progress';
    }
    const s = await session();
    s.plan = steps;
    // 旧版本的计划在上下文里已经没用了，换成一句话，只留最新一版
    for (const m of s.messages) {
      if (m.role === 'tool' && String(m.content).startsWith(PLAN_MARK)) m.content = OLD_PLAN;
    }
    const done = steps.filter((x) => x.status === 'completed').length;
    return `${PLAN_MARK} 当前计划（${done}/${steps.length} 完成）\n${render(steps)}`;
  },
);

export const submitPlan = tool(
  'submit_plan',
  '计划模式下使用：提交完整的执行计划给用户审批。批准后退出计划模式，可以开始修改。',
  {
    type: 'object',
    properties: { plan: { type: 'string', description: '分步骤的完整计划，写清要改哪些文件、怎么验证' } },
    required: ['plan'],
  },
  async () => {
    // 能走到这里，说明用户已经在确认界面看过计划并按了 y（submit_plan 是 CONFIRM 级）
    const s = await session();
    if (s.perms.mode !== 'plan') return 'Error: 当前不在计划模式，直接执行即可';
    s.perms.mode = 'normal';
    return '用户批准了计划。已退出计划模式，现在按计划执行；执行中如果需要偏离计划，先说明原因。';
  },
);

/** 由用户触发（终端里输入 /plan 任务），不是给模型的工具：进不进计划模式，由人决定。 */
export function enterPlanMode(s, task) {
  s.perms.mode = 'plan';
  return PLAN_MODE_PREFIX + task;
}
