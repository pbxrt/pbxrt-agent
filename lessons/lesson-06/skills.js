/** skills.js —— 第 5 课：技能（按需加载的能力说明书） */
import fs from 'node:fs';
import path from 'node:path';

import { SKILLS_DIR, WORKSPACE } from './permissions.js';
import { tool } from './tools.js';

const SKILL_MARK = '[skill]';
const MAX_NOTES_CHARS = 3000;

/** 拆出 frontmatter（--- 之间的 key: value）和正文。返回 [meta, body]。 */
export function parseSkill(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return [{}, text.trim()];
  const meta = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return [meta, lines.slice(i + 1).join('\n').trim()];
    const sep = lines[i].indexOf(':');
    if (sep >= 0) meta[lines[i].slice(0, sep).trim()] = lines[i].slice(sep + 1).trim();
  }
  return [{}, text.trim()]; // 没有闭合的 ---，当作没有 frontmatter
}

export function discover(skillsDir = SKILLS_DIR) {
  const found = new Map();
  if (!fs.existsSync(skillsDir)) return found;
  const subdirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of subdirs) {
    const file = path.join(skillsDir, dir, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const [meta] = parseSkill(fs.readFileSync(file, 'utf8'));
    const name = meta.name || dir;
    if (!meta.description) {
      console.log(`[skills] 跳过 ${file}：缺少 description`);
      continue;
    }
    found.set(name, { description: meta.description, path: file });
  }
  return found;
}

export function skillsSection(found = discover()) {
  if (!found.size) return '';
  const lines = [
    '',
    '## 可用技能',
    '下面只列出技能的名字和用途。当任务和某个技能的用途匹配时，' +
      '先调用 load_skill 读取完整说明，再按说明执行。',
  ];
  for (const [name, skill] of found) lines.push(`- ${name}：${skill.description}`);
  return lines.join('\n');
}

/** AGENTS.md：项目级说明，每次都放进 system prompt。 */
export function projectNotes() {
  const p = path.join(WORKSPACE, 'AGENTS.md');
  if (!fs.existsSync(p)) return '';
  const text = fs.readFileSync(p, 'utf8').slice(0, MAX_NOTES_CHARS);
  return `\n\n## 项目说明（来自 AGENTS.md）\n${text}`;
}

export const loadSkill = tool(
  'load_skill',
  '读取一个技能的完整说明。任务和「可用技能」列表里某个技能的用途匹配时调用。',
  { type: 'object', properties: { name: { type: 'string', description: '技能名' } }, required: ['name'] },
  ({ name }) => {
    const found = discover();
    if (!found.has(name)) {
      return `Error: 没有名为 ${JSON.stringify(name)} 的技能，可用：${[...found.keys()].join(', ') || '无'}`;
    }
    const file = found.get(name).path;
    const [, body] = parseSkill(fs.readFileSync(file, 'utf8'));
    const dir = path.dirname(file);
    const extras = fs
      .readdirSync(dir)
      .filter((n) => n !== 'SKILL.md')
      .sort();
    const rel = path.relative(WORKSPACE, dir);
    const note = extras.length ? `\n\n（技能目录 ${rel}/ 下还有：${extras.join(', ')}）` : '';
    return `${SKILL_MARK} ${name}\n${body}${note}`;
  },
);
