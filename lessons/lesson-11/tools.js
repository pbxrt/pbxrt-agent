/** tools.js —— 第 2 课的注册表 + 第 3 课加固：文件工具只认工作区，shell 固定目录、限时 */
import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveInWorkspace, WORKSPACE } from './permissions.js';

const execAsync = promisify(exec);

const MAX_OUTPUT = 8000;
export const TOOLS = new Map();

export function tool(name, description, parameters, func) {
  TOOLS.set(name, {
    schema: { type: 'function', function: { name, description, parameters } },
    func,
  });
  return func;
}

export const getSchemas = () => [...TOOLS.values()].map((t) => t.schema);

function params(props) {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, { type: 'string', description: v }]),
    ),
    required: Object.keys(props),
  };
}

export const listDir = tool(
  'list_dir',
  '列出工作区内某个目录下的文件和子目录。',
  params({ path: '目录路径，工作区根目录写 .' }),
  async ({ path: dir = '.' } = {}) => {
    const p = resolveInWorkspace(dir);
    if (p === null) return '[错误] 路径在工作区之外'; // 双保险：即使绕过了权限检查，这里还会拦
    const entries = await fs.readdir(p, { withFileTypes: true });
    const names = entries.map((x) => x.name + (x.isDirectory() ? '/' : '')).sort();
    return names.join('\n') || '(空目录)';
  },
);

export const readFile = tool(
  'read_file',
  '读取一个文本文件的内容。',
  params({ path: '文件路径' }),
  ({ path: p }) => {
    const target = resolveInWorkspace(p);
    if (target === null) return '[错误] 路径在工作区之外';
    return fs.readFile(target, 'utf8');
  },
);

export const writeFile = tool(
  'write_file',
  '把内容写入文件，已存在则覆盖。',
  params({ path: '文件路径', content: '完整内容' }),
  async ({ path: p, content }) => {
    const target = resolveInWorkspace(p);
    if (target === null) return '[错误] 路径在工作区之外';
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return `已写入 ${path.relative(WORKSPACE, target)}（${content.length} 字符）`;
  },
);

export const runShell = tool(
  'run_shell',
  '在工作区执行一条 shell 命令。',
  params({ command: '要执行的命令' }),
  async ({ command, timeout = 30 }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: WORKSPACE,
        timeout: timeout * 1000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return `[exit 0]\n${stdout}${stderr}`;
    } catch (err) {
      if (err.killed) return `[超时] 命令执行超过 ${timeout} 秒，已终止。`;
      return `[exit ${err.code ?? 1}]\n${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
  },
);

export const fetchUrl = tool(
  'fetch_url',
  '抓取网页文本，url 以 http/https 开头。',
  params({ url: '完整的 URL' }),
  async ({ url }) => {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'pbxrt-agent' },
      signal: AbortSignal.timeout(15_000),
    });
    return resp.text();
  },
);

/** 执行工具，永远返回字符串，永远不抛异常 */
export async function execute(name, args) {
  const entry = TOOLS.get(name);
  if (!entry) return `Error: 不存在工具 '${name}'，可用工具：${[...TOOLS.keys()].join(', ')}`;
  let result;
  try {
    result = String(await entry.func(args ?? {}));
  } catch (err) {
    return `Error: ${err.code ? `${err.code}: ` : ''}${err.message}`;
  }
  if (result.length > MAX_OUTPUT) {
    result = result.slice(0, MAX_OUTPUT) + `\n...（已截断，共 ${result.length} 字符）`;
  }
  return result;
}
