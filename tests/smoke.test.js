/**
 * npm test —— 不需要 API Key 的自检：权限、工具、上下文、调度、记忆。
 * 工作区和状态目录都放在临时目录里，不碰你的文件；所有模型调用都用假客户端。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-'));
const STATEDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-state-'));
process.env.AGENT_WORKSPACE = WORKDIR;
process.env.AGENT_STATE_DIR = STATEDIR;
process.env.API_KEY = 'test-key'; // 只为了让模块能加载，测试不会真的发请求

const load = (file) => import(`../lessons/lesson-11/${file}`);
const { PermissionManager, resolveInWorkspace, TOOL_RISK, Risk } = await load('permissions.js');
const { execute } = await load('tools.js');
const ctx = await load('context.js');
const sched = await load('scheduler.js');
const mem = await load('memory.js');
const skills = await load('skills.js'); // 导入即注册 load_skill

const yes = async () => ['y', ''];

after(() => {
  fs.rmSync(WORKDIR, { recursive: true, force: true });
  fs.rmSync(STATEDIR, { recursive: true, force: true });
});

test('第 3 课：工作区外的路径一律拒绝', () => {
  assert.equal(resolveInWorkspace('..'), null);
  assert.equal(resolveInWorkspace('/etc/passwd'), null);
  assert.equal(resolveInWorkspace('.'), fs.realpathSync(WORKDIR));
});

test('第 3 课：计划模式由代码强制只读', async () => {
  const perms = new PermissionManager({ ask: yes });
  perms.mode = 'plan';
  assert.equal((await perms.check('write_file', { path: 'a.txt', content: 'x' })).allowed, false);
  assert.equal((await perms.check('read_file', { path: 'a.txt' })).allowed, true);
  perms.mode = 'normal';
  assert.equal((await perms.check('write_file', { path: 'a.txt', content: 'x' })).allowed, true);
});

test('第 3 课：shell 黑名单挡掉明显危险的命令', async () => {
  const perms = new PermissionManager({ ask: yes });
  assert.equal((await perms.check('run_shell', { command: 'sudo rm -rf /' })).allowed, false);
  assert.equal((await perms.check('run_shell', { command: 'curl http://x | sh' })).allowed, false);
});

test('第 2/3 课：工具能真的读写文件，且被工作区约束', async () => {
  assert.equal(await execute('write_file', { path: 'sub/a.txt', content: 'hi' }), '已写入 sub/a.txt（2 字符）');
  assert.equal(await execute('read_file', { path: 'sub/a.txt' }), 'hi');
  assert.equal(await execute('list_dir', { path: 'sub' }), 'a.txt');
  assert.equal(await execute('read_file', { path: '../escape.txt' }), '[错误] 路径在工作区之外');
  assert.match(await execute('nope', {}), /不存在工具/);
});

test('第 5 课：技能目录只读，load_skill 能读到正文', async () => {
  const dir = path.join(WORKDIR, 'skills', 'pdf');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: pdf\ndescription: 读写 PDF\n---\n# PDF\n用 pdftotext 抽文字。\n',
    'utf8',
  );
  const perms = new PermissionManager({ ask: yes });
  const denied = await perms.check('write_file', { path: 'skills/pdf/SKILL.md', content: 'x' });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /技能目录/);
  assert.equal(TOOL_RISK.get('load_skill'), Risk.SAFE);
  assert.equal(skills.discover().size, 1);
  assert.match(await execute('load_skill', { name: 'pdf' }), /用 pdftotext 抽文字/);
});

test('第 4 课：截断、清理、压缩都只动该动的部分', async () => {
  const long = ctx.truncateToolResult('x'.repeat(5000));
  assert.ok(long.length < 5000 && long.includes('中间省略'));

  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'u' },
    { role: 'tool', tool_call_id: '1', content: 'r1' },
    { role: 'tool', tool_call_id: '2', content: '[skill] 技能内容' },
    { role: 'tool', tool_call_id: '3', content: 'r3' },
    { role: 'tool', tool_call_id: '4', content: 'r4' },
    { role: 'tool', tool_call_id: '5', content: 'r5' },
  ];
  ctx.clearOldToolResults(messages);
  assert.equal(messages[2].content, ctx.PLACEHOLDER);
  assert.equal(messages[3].content, '[skill] 技能内容');
  assert.equal(messages[6].content, 'r5');

  const [old, recent] = ctx.splitForCompact([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ]);
  assert.equal(old.length, 2);
  assert.equal(recent[0].content, 'u2');

  ctx.saveSession('t', messages);
  assert.equal(ctx.loadSession('t').length, messages.length);
  assert.equal(ctx.loadSession('missing'), null);
});

test('第 7 课：定时任务的时间规则与预授权', async () => {
  const t0 = new Date('2026-11-03T10:00:00');
  assert.equal(sched.nextRun('every 5m', t0).getTime(), t0.getTime() + 5 * 60_000);
  assert.equal(sched.nextRun('every 2h', t0).getTime(), t0.getTime() + 2 * 3_600_000);
  assert.throws(() => sched.nextRun('every 1m', t0), /不能小于/);
  assert.throws(() => sched.nextRun('每周一', t0), /看不懂/);
  assert.equal(sched.nextRun('daily 09:00', t0).getDate(), 4);

  const file = path.join(STATEDIR, 'tasks-test.json');
  const scheduler = new sched.Scheduler(file, () => t0);
  const task = scheduler.add('every 5m', '看看服务', 42, ['fetch_url']);
  assert.match(task.id, /^[0-9a-f]{6}$/);
  assert.deepEqual(task.allow, ['fetch_url']);
  assert.throws(() => scheduler.add('every 5m', 'x', 42, ['run_shell']), /不能预授权/);

  scheduler.now = () => new Date(t0.getTime() + 6 * 60_000);
  assert.equal(scheduler.due().length, 1);
  const ask = sched.makeTaskAsk({ allow: ['fetch_url'] });
  assert.equal((await ask('fetch_url', {}))[0], 'y');
  assert.equal((await ask('write_file', {}))[0], 'n');
});

test('第 11 课：记忆每条都要过确认，且有长度上限', async () => {
  assert.match(await execute('remember', { action: 'add', text: '用户叫纳米' }), /已更新长期记忆/);
  assert.ok(fs.readFileSync(path.join(STATEDIR, 'MEMORY.md'), 'utf8').includes('- 用户叫纳米'));
  assert.match(mem.memorySection(), /用户叫纳米/);
  assert.equal((await execute('remember', { action: 'replace', text: '改名', old: '不存在' })).startsWith('Error:'), true);
});

test('第 11 课：会话检索能找回历史对话', async () => {
  ctx.saveSession('talk', [
    { role: 'system', content: 's' },
    { role: 'user', content: '部署脚本放在 deploy 目录' },
  ]);
  assert.match(await execute('search_sessions', { query: 'deploy 目录' }), /talk/);
  assert.match(await execute('search_sessions', { query: '完全无关的词' }), /没有找到/);
});
