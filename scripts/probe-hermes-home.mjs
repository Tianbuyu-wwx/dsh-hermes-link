#!/usr/bin/env node
// 探 ~/.hermes/ 实际结构, 列出会话文件位置 / 人设文件名 / settings 格式
// 输出 JSON 到 stdout, 写到 ~/.dsh/dsh-hermes-link/probe.json (如目录不存在则建)

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const HERMES_HOME = join(homedir(), '.hermes');
const OUT_DIR = join(homedir(), '.dsh', 'dsh-hermes-link');
const OUT_FILE = join(OUT_DIR, 'probe.json');

function safeStat(p) {
  try { return statSync(p); } catch { return null; }
}

function safeReadText(p, max = 64 * 1024) {
  try {
    const s = statSync(p);
    if (s.size > max) return `[truncated, total ${s.size} bytes] ` + readFileSync(p, 'utf8').slice(0, max);
    return readFileSync(p, 'utf8');
  } catch (e) { return null; }
}

function walkTree(root, depth = 0, max = 3) {
  const out = [];
  if (depth > max) return out;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.config') continue;
    const p = join(root, e.name);
    const s = safeStat(p);
    if (!s) continue;
    out.push({
      path: p.replace(homedir(), '~'),
      name: e.name,
      type: e.isDirectory() ? 'd' : 'f',
      size: s.size,
      mtime: s.mtime.toISOString(),
    });
    if (e.isDirectory()) {
      out.push(...walkTree(p, depth + 1, max).map(x => ({ ...x, depth: (x.depth || 0) + 1 })));
    }
  }
  return out;
}

const result = {
  hermes_home: HERMES_HOME,
  exists: existsSync(HERMES_HOME),
  tree: existsSync(HERMES_HOME) ? walkTree(HERMES_HOME) : [],
};

const candidateNames = [
  'SOUL.md', 'USER.md', 'MEMORY.md', 'AGENTS.md', 'TOOLS.md',
  'soul.md', 'user.md', 'memory.md',
  'IDENTITY.md', 'PERSONA.md',
  'settings.yaml', 'settings.json', 'settings.toml', 'config.yaml', 'config.json',
  'CLAUDE.md', 'AGENT.md',
];

result.candidate_files = {};
for (const n of candidateNames) {
  const p = join(HERMES_HOME, n);
  const s = safeStat(p);
  if (s) {
    result.candidate_files[n] = {
      size: s.size,
      mtime: s.mtime.toISOString(),
      head: safeReadText(p, 4096),
    };
  }
}

// 找任何 *.jsonl / *sessions* / *history*
const sessionsLike = (result.tree || []).filter(x =>
  x.type === 'd' && /sessions?|history|conversations?|chats?|logs?/i.test(x.name)
);
result.sessions_dirs = sessionsLike.map(x => x.path);

// 在 tree 里找 jsonl
const jsonlFiles = (result.tree || []).filter(x =>
  x.type === 'f' && /\.jsonl$/i.test(x.name)
);
result.jsonl_files = jsonlFiles.slice(0, 20).map(x => ({
  ...x,
  first_lines: safeReadText(x.path.replace('~', homedir()), 2048)?.split('\n').slice(0, 3),
}));

// 输出
console.log(JSON.stringify(result, null, 2));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
console.error(`\n[probe] wrote ${OUT_FILE}`);