// 真实浏览器回归：旧版主页点卡片 vs 点退出旧版；问题页退出
// 首页匿名会跳 /signin，所以用本地 HTTP 桩页面承载「旧版主页」文档，接口照常拦截。
import { connect, evaluate } from './cdp.mjs';
import fs from 'node:fs';

const SRC = process.argv[2] || './v3.js';
const PORT = 9444;
const src = fs.readFileSync(SRC, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (extra || '')]);

// 与 test3.mjs 相同形状的 initialData
const seed = {
  initialState: {
    entities: {
      answers: { 101: { id: 101, question: { id: 500, title: '问题A' }, author: { name: '甲' }, excerpt: '<p>摘要</p>', voteup_count: 12, comment_count: 3 } },
      articles: { 301: { id: 301, title: '文章B', author: { name: '乙' }, excerpt: '摘要', voteup_count: 4 } },
      questions: { 700: { id: 700, title: '问题C', excerpt: '描述', answer_count: 8 } },
    },
    feed: { list: ['answer:101', 'article:301', 'question:700'] },
  },
};
const page = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>知乎 - 首页</title></head>' +
  '<body><div id="orig">原版主页</div>' +
  '<script id="js-initialData" type="text/json">' + JSON.stringify(seed) + '</script></body></html>';

const c = await connect(PORT, /zhihu|about:blank/);
await c.send('Page.enable');
await c.send('Network.enable');
await c.send('Fetch.enable', { patterns: [{ urlPattern: '*://www.zhihu.com/api/*' }] });

const answer = (id) => ({ id, content: '<p>答案' + id + '</p>', voteup_count: 10, comment_count: 2, updated_time: 1700000000, author: { name: '用户' + id, url_token: 'u' + id } });
function mockFor(url) {
  let m;
  if ((m = url.match(/\/questions\/\d+\/answers\?.*offset=(\d+)/))) return m[1] === '0' ? { data: [answer(101), answer(102)], paging: { totals: 2, is_end: true } } : { data: [], paging: { totals: 2, is_end: true } };
  if (/\/api\/v4\/answers\?/.test(url)) return { data: [answer(101)] };
  if (/\/api\/v4\/answers\/\d+/.test(url)) return answer(101);
  return { data: [], paging: { totals: 0, is_end: true } };
}
c.ws.addEventListener('message', async (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = msg.params;
  try {
    await c.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json; charset=utf-8' },
        { name: 'Access-Control-Allow-Origin', value: 'https://www.zhihu.com' },
      ],
      body: Buffer.from(JSON.stringify(mockFor(request.url))).toString('base64'),
    });
  } catch (e) {}
});

await c.send('Page.addScriptToEvaluateOnNewDocument', { source: src });

const setContent = async (html, url) => {
  await c.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  const doc = {};
  const { frameTree } = await c.send('Page.getFrameTree');
  await c.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
  await c.send('Runtime.evaluate', { expression: `history.replaceState({}, '', ${JSON.stringify(url)})` });
  await sleep(2500);
};
const href = async () => (await evaluate(c, 'location.href')).value;
const click = async (sel) => (await evaluate(c, `(function(){var a=document.querySelector(${JSON.stringify(sel)}); if(!a) return 'NO-EL'; a.click(); return 'OK';})()`)).value;

/* ---------- 1. 旧版主页 ---------- */
{
  await setContent(page, '/');
  const btn = (await evaluate(c, `(function(){var b=[...document.querySelectorAll('[role=button]')].find(e=>e.textContent==='旧版主页'); if(!b) return 'NO-BTN'; b.click(); return 'OK';})()`)).value;
  check('主页出现并点到「旧版主页」', btn === 'OK', btn);
  await sleep(3000);
  const n = (await evaluate(c, `document.querySelectorAll('.zh-feed-item').length`)).value;
  check('旧版主页渲染出卡片', n > 0, String(n));

  const before = await href();
  const hrefs = (await evaluate(c, `[...document.querySelectorAll('.zh-feed-title')].map(a=>a.getAttribute('href'))`)).value;
  for (const sel of ['.zh-feed-title', '.zh-feed-title']) { await click(sel); await sleep(900); }
  const after = await href();
  check('点卡片不会离开旧版主页', after === before, `before=${before} after=${after} hrefs=${JSON.stringify(hrefs)}`);

  // 对照：点退出旧版，必须真的回到原版（地址里不再带 zh_old）
  await click('.zh-exit');
  await sleep(2500);
  const afterExit = await href();
  check('点退出旧版确实回到原版', afterExit.indexOf('zh_old=1') === -1, `afterExit=${afterExit}`);
}

/* ---------- 2. 问题页 ---------- */
{
  await setContent('<!DOCTYPE html><html><head><title>问题 - 知乎</title></head><body><h1>问题</h1></body></html>', '/question/123456?zh_old=1');
  const hasExit = (await evaluate(c, `document.querySelectorAll('.zh-exit').length`)).value;
  check('问题页渲染出退出入口', hasExit > 0, String(hasExit));
  await click('.zh-exit');
  await sleep(2500);
  const url = await href();
  check('问题页退出后地址带 zh_raw=1', /zh_raw=1/.test(url), url);
}

console.log(results.map((r) => r[0] + '  ' + r[1] + (r[2] ? '   [' + r[2] + ']' : '')).join('\n'));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log('FAILED=' + failed);
c.close();
process.exit(failed ? 1 : 0);
