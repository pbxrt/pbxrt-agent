/**
 * demo_mcp_server.js —— 第 8 课：一个只用标准库写的 MCP 服务器，用来测试客户端
 *
 * 两个工具：
 * - now：返回当前时间（只读）
 * - word_count：统计一段文字的字数（只读）
 *
 * 真实项目里一般用官方 SDK 写服务器，这里手写是为了看清协议本身。
 */
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'now',
    description: '返回当前的本地时间。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'word_count',
    description: '统计一段文字的字符数和行数。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

function call(name, args) {
  if (name === 'now') return [new Date().toISOString(), false];
  if (name === 'word_count') {
    const text = args.text ?? '';
    const lines = text.split(/\r?\n/).length || 1;
    return [`${text.length} 个字符，${lines} 行`, false];
  }
  return [`没有工具 ${name}`, true];
}

function handle(msg) {
  const params = msg.params ?? {};
  if (msg.method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'demo', version: '1.0' },
    };
  }
  if (msg.method === 'tools/list') return { tools: TOOLS };
  if (msg.method === 'tools/call') {
    const [text, isError] = call(params.name, params.arguments ?? {});
    return { content: [{ type: 'text', text }], isError };
  }
  throw new Error(`未知方法 ${msg.method}`);
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const msg = JSON.parse(line); // 一行一条消息
  if (msg.id == null) continue; // 通知（比如 notifications/initialized）不需要回复
  let reply;
  try {
    reply = { jsonrpc: '2.0', id: msg.id, result: handle(msg) };
  } catch {
    reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `未知方法 ${msg.method}` } };
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
  process.stderr.write(`[demo] 处理了 ${msg.method}\n`); // 日志只能写 stderr
}
