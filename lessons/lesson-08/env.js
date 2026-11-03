/**
 * env.js —— 统一读取项目根目录的 .env，并导出各课共用的配置
 *
 * Node 20.12+ 内置 process.loadEnvFile：把 .env 里的键值对读进 process.env，
 * 已经存在的环境变量优先（所以 export API_KEY=... 也能覆盖 .env）。不需要 dotenv。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env'));
} catch {
  // 没有 .env 就跳过；环境变量照常可用
}

/** 展开已存在部分里的软链接（等价 Python 的 Path.resolve；macOS 上 /tmp 就是 /private/tmp） */
export function realpathLoose(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...rest);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export const BASE_URL = process.env.BASE_URL || 'https://api.deepseek.com';
export const MODEL = process.env.MODEL || 'deepseek-flash';

// Agent 只允许碰这个目录。默认是启动时的当前目录。
export const WORKSPACE = realpathLoose(path.resolve(process.env.AGENT_WORKSPACE || process.cwd()));

// 程序自己的状态（会话记录、定时任务、记忆）放在工作区之外，Agent 的文件工具碰不到
export const STATE_DIR = realpathLoose(
  path.resolve(process.env.AGENT_STATE_DIR || path.join(os.homedir(), '.agent-state')),
);

/** 拿 API Key，缺了就给一句人话，而不是 SDK 的英文报错 */
export function requireApiKey() {
  const key = process.env.API_KEY;
  if (!key) {
    throw new Error(
      '缺少 API_KEY：在项目根目录的 .env 里写 API_KEY=你的密钥（或 export API_KEY=...）',
    );
  }
  return key;
}
