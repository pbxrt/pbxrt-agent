/** permissions.js —— 第 3 课：权限与安全边界 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { realpathLoose, WORKSPACE } from './env.js';
import { askLine } from './io.js';

// 第 2 课之后的工具都从这里拿工作区（和 Python 版一致：WORKSPACE 定义在 permissions 里）
export { WORKSPACE };

export const SKILLS_DIR = path.join(WORKSPACE, 'skills'); // 第 5 课

export const Risk = Object.freeze({
  SAFE: 'safe', // 只读：直接放行
  CONFIRM: 'confirm', // 有副作用：问人
  DENY: 'deny', // 永远不允许
});

// 工具风险登记表。没登记的工具一律按 CONFIRM 处理。
export const TOOL_RISK = new Map([
  ['list_dir', Risk.SAFE],
  ['read_file', Risk.SAFE],
  ['load_skill', Risk.SAFE], // 第 5 课
  ['list_tasks', Risk.SAFE], // 第 7 课
  ['delegate', Risk.SAFE], // 第 9 课：子 Agent 自己的每个操作照样过权限检查
  ['delegate_parallel', Risk.SAFE],
  ['write_file', Risk.CONFIRM],
  ['run_shell', Risk.CONFIRM],
  ['fetch_url', Risk.CONFIRM],
  ['schedule_task', Risk.CONFIRM], // 第 7 课
  ['cancel_task', Risk.CONFIRM], // 第 7 课
]);

// 允许"本次会话一直允许"的工具。run_shell 不在里面：每条命令都要过目。
export const REMEMBERABLE = new Set(['write_file']);

// 明显的灾难性命令。注意：这是安全带，不是边界。
export const SHELL_DENY_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\*)/, // rm -rf / ~ *
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{/, // fork bomb
  /(curl|wget)\b.*\|\s*(sh|bash)\b/, // curl ... | sh
  />\s*\/dev\/sd/,
];

const allow = () => ({ allowed: true, reason: '' });
const deny = (reason) => ({ allowed: false, reason });

const isInside = (target, root) =>
  target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * 把路径解析成绝对路径；不在工作区内返回 null。
 * 会展开 ~、.. 和符号链接，所以 ../../etc/passwd 和指向外部的软链接都会被识别。
 */
export function resolveInWorkspace(pathStr = '.') {
  const expanded = String(pathStr).replace(/^~(?=$|[/\\])/, os.homedir());
  const resolved = realpathLoose(path.resolve(WORKSPACE, expanded));
  return isInside(resolved, realpathLoose(WORKSPACE)) ? resolved : null;
}

/** 缩进每一行（等价 textwrap.indent） */
function indent(text, pad) {
  return String(text)
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

/** 确认界面：展示将要执行的真实内容，而不是模型的自述。 */
export function renderCall(name, args = {}, maxChars = 400) {
  if (name === 'run_shell') return `  $ ${args.command ?? ''}`;
  if (name === 'write_file') {
    const content = args.content ?? '';
    let preview = content.slice(0, maxChars);
    if (content.length > maxChars) preview += `\n...（已截断，共 ${content.length} 字符）`;
    return `  路径：${args.path}\n` + indent(preview, '    ');
  }
  return `  ${JSON.stringify(args)}`;
}

export class PermissionManager {
  constructor({ ask } = {}) {
    this.alwaysAllowed = new Set();
    // ask 可注入：ask(name, args) => Promise<["y" | "n" | "a", 拒绝原因]>
    // 第 3 课用它方便测试，第 6、7 课会换成聊天确认和无人值守的预授权
    this.ask = ask ?? PermissionManager.askTerminal;
  }

  // ---------- 对外入口 ----------
  async check(name, args) {
    // 第 1 关：硬规则，人也无法放行
    const reason = this.hardLimits(name, args);
    if (reason) return deny(reason);

    // 第 2 关：风险分级
    const risk = TOOL_RISK.get(name) ?? Risk.CONFIRM;
    if (risk === Risk.DENY) return deny(`工具 ${name} 被策略禁用。`);
    if (risk === Risk.SAFE || this.alwaysAllowed.has(name)) return allow();

    // 第 3 关：人工确认
    return this.confirm(name, args);
  }

  // ---------- 第 1 关 ----------
  hardLimits(name, args) {
    if (name === 'read_file' || name === 'write_file' || name === 'list_dir') {
      const p = args.path ?? '.';
      const resolved = resolveInWorkspace(p);
      if (resolved === null) {
        return `路径 ${JSON.stringify(p)} 在工作区 ${WORKSPACE} 之外，禁止访问。`;
      }
      if (name === 'write_file' && isInside(resolved, SKILLS_DIR)) {
        return '技能目录是只读的，Agent 不能修改自己的技能。';
      }
    }
    if (name === 'run_shell') {
      const cmd = args.command ?? '';
      for (const pattern of SHELL_DENY_PATTERNS) {
        if (pattern.test(cmd)) return `命令命中危险模式，已被策略拦截：${JSON.stringify(cmd)}`;
      }
    }
    return null;
  }

  // ---------- 第 3 关 ----------
  async confirm(name, args) {
    const [answer, note] = await this.ask(name, args);
    if (answer === 'a' && REMEMBERABLE.has(name)) {
      this.alwaysAllowed.add(name);
      return allow();
    }
    if (answer === 'y' || answer === 'a') return allow();
    let msg = '用户拒绝了这次操作。';
    if (note) msg += `原因：${note}。`;
    msg += '不要重试同一操作；请换一种方式，或向用户说明你想做什么、为什么。';
    return deny(msg);
  }

  static async askTerminal(name, args) {
    if (!process.stdin.isTTY) {
      // 非交互环境（管道、脚本）没有人可以确认，默认拒绝
      return ['n', '当前是非交互环境，无法确认'];
    }
    console.log(`\n⚠️  Agent 想执行：${name}`);
    console.log(renderCall(name, args));
    const options = '[y]允许 / [n]拒绝' + (REMEMBERABLE.has(name) ? ' / [a]本次会话一直允许' : '');
    let answer;
    for (;;) {
      answer = (await askLine(`${options} > `)).trim().toLowerCase();
      if (answer === '') return ['n', '输入已结束，视为拒绝']; // stdin 已经关了
      if (answer === 'y' || answer === 'n' || (answer === 'a' && REMEMBERABLE.has(name))) break;
    }
    const note = answer === 'n' ? (await askLine('拒绝原因（可选，回车跳过）> ')).trim() : '';
    return [answer, note];
  }
}
