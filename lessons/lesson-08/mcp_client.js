/**
 * mcp_client.js —— 第 8 课：最小的 MCP 客户端（stdio 传输，不依赖 SDK）
 *
 * MCP 服务器是一个独立进程。我们通过它的 stdin/stdout 收发 JSON-RPC 2.0 消息，
 * 每条消息一行。握手之后问它有哪些工具，再把每个工具注册进第 2 课的注册表。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { STATE_DIR } from './env.js';
import { Risk, TOOL_RISK } from './permissions.js';
import { TOOLS } from './tools.js';

const PROTOCOL_VERSION = '2025-11-25';
// 配置放在状态目录，不在工作区：能改配置，就能让 Agent 启动任意程序
export const CONFIG_FILE = path.join(STATE_DIR, 'mcp.json');
const TIMEOUT = 30_000;

export class MCPError extends Error {}

/** 一个 MCP 服务器进程，以及和它说话的方法。 */
export class MCPServer {
  constructor(name, command, args = [], env = {}) {
    this.name = name;
    this.nextId = 0;
    this.waiting = new Map(); // id -> { resolve, reject, timer }
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'ignore'], // 服务器的日志走 stderr，这里直接丢掉
      env: { ...process.env, ...env },
    });
    this.lines = readline.createInterface({ input: this.proc.stdout });
    this.lines.on('line', (line) => this.onLine(line));
    this.proc.on('exit', (code) => {
      for (const [id, slot] of this.waiting) {
        clearTimeout(slot.timer);
        slot.reject(new MCPError(`MCP 服务器 ${this.name} 已退出（code=${code}）`));
        this.waiting.delete(id);
      }
    });
  }

  // ---------- JSON-RPC ----------
  send(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + '\n'); // 一条消息一行
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id == null) return; // 服务器主动发来的通知，这一版先忽略
    const slot = this.waiting.get(msg.id);
    if (!slot) return;
    this.waiting.delete(msg.id);
    clearTimeout(slot.timer);
    if (msg.error) slot.reject(new MCPError(`${msg.error.code}: ${msg.error.message}`));
    else slot.resolve(msg.result);
  }

  request(method, params = {}) {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new MCPError(`MCP 服务器 ${this.name} 在 ${TIMEOUT / 1000} 秒内没有响应`));
      }, TIMEOUT);
      this.waiting.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  // ---------- MCP ----------
  async initialize() {
    const info = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'pbxrt-agent', version: '0.8' },
    });
    this.notify('notifications/initialized');
    return info;
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (;;) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}); // 工具多时会分页
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
  }

  async callTool(tool, args) {
    const result = await this.request('tools/call', { name: tool, arguments: args });
    const parts = (result.content ?? []).map((block) =>
      block.type === 'text' ? block.text : `[${block.type} 内容，已省略]`, // 图片、音频等，这一版只告诉模型有这么个东西
    );
    const text = parts.join('\n') || '(空结果)';
    return result.isError ? `Error: ${text}` : text;
  }

  close() {
    try {
      this.proc.stdin.end(); // 规范建议：先关输入流，让服务器自己退出
    } catch {
      // 已经关了
    }
    this.proc.kill();
  }
}

export const SERVERS = new Map();

/** 把一个服务器的全部工具注册成 mcp__服务器__工具。 */
export async function registerServer(server, safe = []) {
  for (const t of await server.listTools()) {
    const full = `mcp__${server.name}__${t.name}`;
    const desc = (t.description ?? '').slice(0, 1000); // 描述也是提示词，限个长度
    TOOLS.set(full, {
      schema: {
        type: 'function',
        function: {
          name: full,
          description: `[MCP:${server.name}] ${desc}`,
          parameters: t.inputSchema ?? { type: 'object', properties: {} },
        },
      },
      func: (args) => server.callTool(t.name, args),
    });
    // 默认不登记风险 = 按 CONFIRM 处理；只有配置里点名的工具才算只读
    if (safe.includes(t.name)) TOOL_RISK.set(full, Risk.SAFE);
  }
  SERVERS.set(server.name, server);
}

/** 读取 ~/.agent-state/mcp.json，启动并注册里面的每个服务器。 */
export async function loadServers(configFile = CONFIG_FILE, log = console.log) {
  if (!fs.existsSync(configFile)) return;
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  for (const [name, spec] of Object.entries(config.servers ?? {})) {
    try {
      const server = new MCPServer(name, spec.command, spec.args ?? [], spec.env ?? {});
      await server.initialize();
      await registerServer(server, spec.safe_tools ?? []);
      const count = [...TOOLS.keys()].filter((k) => k.startsWith(`mcp__${name}__`)).length;
      log(`[MCP] ${name}：已接入 ${count} 个工具`);
    } catch (err) {
      log(`[MCP] ${name} 启动失败：${err.message}`); // 一个服务器起不来，不影响其他的
    }
  }
}

export function closeAll() {
  for (const server of SERVERS.values()) server.close();
  SERVERS.clear();
}
