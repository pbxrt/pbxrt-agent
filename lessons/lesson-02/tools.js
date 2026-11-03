/** tools.js —— 第 2 课：工具注册表 + 统一执行器 */
import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const MAX_OUTPUT = 8000; // 工具返回给模型的最大字符数
export const TOOLS = new Map(); // 注册表：name -> { schema, func }

/** 把一个函数注册为工具（Python 版是装饰器，JS 里就是一个普通函数） */
export function tool(name, description, parameters, func) {
  TOOLS.set(name, {
    schema: { type: 'function', function: { name, description, parameters } },
    func,
  });
  return func;
}

/** 返回给模型看的全部工具说明书 */
export const getSchemas = () => [...TOOLS.values()].map((t) => t.schema);

/** 简写：所有参数都是必填的字符串 */
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
  '列出某个目录下的文件和子目录。',
  params({ path: '目录路径，当前目录写 .' }),
  async ({ path: p = '.' } = {}) => {
    const entries = await fs.readdir(p, { withFileTypes: true });
    const names = entries.map((x) => x.name + (x.isDirectory() ? '/' : '')).sort();
    return names.join('\n') || '(空目录)';
  },
);

export const readFile = tool('read_file', '读取一个文本文件的内容。', params({ path: '文件路径' }), ({ path: p }) =>
  fs.readFile(p, 'utf8'),
);

export const writeFile = tool(
  'write_file',
  '把内容写入文件，已存在则覆盖，目录不存在会自动创建。',
  params({ path: '文件路径', content: '要写入的完整内容' }),
  async ({ path: p, content }) => {
    await fs.mkdir(path.dirname(path.resolve(p)), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
    return `已写入 ${p}（${content.length} 字符）`;
  },
);

export const runShell = tool(
  'run_shell',
  '在当前目录执行一条 shell 命令，返回退出码、标准输出和错误输出。',
  params({ command: '要执行的命令' }),
  async ({ command }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return `[exit 0]\n${stdout}${stderr}`;
    } catch (err) {
      if (err.killed) throw new Error(`命令超时（30 秒）：${command}`);
      return `[exit ${err.code ?? 1}]\n${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
  },
);

export const fetchUrl = tool(
  'fetch_url',
  '抓取一个网页或接口的文本内容。url 必须以 http 或 https 开头。',
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
    // 注意：这里的 length 是截断前的原始长度
    result = result.slice(0, MAX_OUTPUT) + `\n...（已截断，共 ${result.length} 字符）`;
  }
  return result;
}
