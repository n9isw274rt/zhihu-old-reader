#!/usr/bin/env node
/**
 * 生成 dist/zhihu-old-reader.user.js
 *   - 用 tag（GITHUB_REF_NAME=v3.0.2）或 --version 覆盖 @version
 *   - 校验元数据：必须在第一行、只能有一份、更新地址是 https 直链
 *   - 写盘后回读，确认没有 BOM
 *
 * 用法：
 *   node scripts/build.mjs                 # 版本取 v3.js 里的 @version
 *   node scripts/build.mjs --version 3.0.2
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'v3.js');
const DIST = join(ROOT, 'dist');
const OUT = 'zhihu-old-reader.user.js';
const IS_CI = !!process.env.GITHUB_ACTIONS;

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };
const warn = (m) => console.warn(`\x1b[33m⚠ ${m}\x1b[0m`);

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

let src = readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
if (!src.startsWith('// ==UserScript==')) fail('v3.js 第一行必须是 // ==UserScript==');

const headerVersion = /^\/\/ @version\s+(\S+)/m.exec(src)?.[1];
let version = arg('version')
  || (process.env.GITHUB_REF_NAME || '').replace(/^refs\/tags\//, '').replace(/^v/, '')
  || headerVersion;
if (!version) fail('拿不到版本号：v3.js 里写 @version，或用 --version 指定');
if (!/^\d+(\.\d+){0,3}$/.test(version)) fail(`版本号格式不合法：${version}（用 3.0.2 这种点分数字）`);
if (version === headerVersion && !arg('version')) {
  warn(`版本号仍是 ${version}：发过同一个版本的话，用户收不到更新`);
}

src = src.replace(/^\/\/ @version\s+.*$/m, `// @version      ${version}`);

if ((src.match(/==UserScript==/g) ?? []).length !== 1) fail('元数据块不止一份');

for (const key of ['name', 'namespace', 'version', 'match', 'updateURL', 'downloadURL']) {
  if (!new RegExp(`^// @${key}\\s`, 'm').test(src)) fail(`元数据缺少 @${key}`);
}
for (const key of ['updateURL', 'downloadURL']) {
  const url = new RegExp(`^// @${key}\\s+(\\S+)`, 'm').exec(src)[1];
  if (!/^https:\/\/raw\.githubusercontent\.com\//.test(url)) fail(`@${key} 必须是 raw.githubusercontent.com 直链：${url}`);
  if (key === 'downloadURL' && url === 'none') fail('@downloadURL none 会关闭自动更新');
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, OUT), src, 'utf8');

const back = readFileSync(join(DIST, OUT), 'utf8');
if (back.charCodeAt(0) === 0xfeff) fail('产物带 BOM，Tampermonkey 识别不到元数据');
if (!back.startsWith('// ==UserScript==')) fail('产物第一行不是元数据');
if (!new RegExp(`^// @version\\s+${version}$`, 'm').test(back)) fail('@version 注入失败');

const shown = (src.match(/^\/\/ @(updateURL|downloadURL)\s+(\S+)/gm) || []).join('\n    ');
console.log(`\n  \x1b[32m✓\x1b[0m v${version}  →  dist/${OUT}  (${Buffer.byteLength(src)} B)`);
console.log(`    ${shown}\n`);
if (IS_CI && version === headerVersion && !arg('version')) warn('CI 里版本号与源码一致，确认这不是重复发布');
