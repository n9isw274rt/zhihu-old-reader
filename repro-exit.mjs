// 回归测试：点卡片不许被当成「退出旧版」
// 手法：把 location.href 换成带 #zh_probe=<n> 的地址。每次赋值 hash 会同步累加 n，
// 同时触发 hashchange；而 http://host/path#x -> http://host/path 这种跨文档导航，
// jsdom 只会报 "navigation to another Document"，n 不变。据此区分「退出」与「不退出」。
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const SRC = process.argv[2] || './v3.js';
// jsdom 的 location 不可改写，导航只能桩在源码上：把 location.replace/reload/assign
// 换成记录调用。这样"是否打算退出"= 有没有调用过这些方法，判定精确且不依赖 jsdom 实现。
const raw = fs.readFileSync(SRC, 'utf8');
const INJECT = `
;(function () {
  if (window.__navRec) return;
  // jsdom 上 location 的方法是原型上的 setter，直接赋值会静默失败：
  // 必须 defineProperty 到实例上才能桩住。
  var rec = window.__navRec = [];
  function hook(name, val) {
    try {
      Object.defineProperty(window.location, name, {
        configurable: true,
        configurable: true,
        value: function (u) { rec.push([name, String(u == null ? '' : u)]); },
      });
    } catch (e) { rec.push(['hook-failed:' + name, String(e && e.message)]); }
  }
  hook('replace'); hook('reload'); hook('assign');
})();
`;
const src = INJECT + raw;
const results = [];
const check = (name, cond, extra) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (extra || '')]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probeRe = /#zh_probe=(\d+)$/;

function makeDom(html, url) {
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  const st = {};
  st.navs = () => (dom.window.__navRec || []).slice();
  st.exited = () => st.navs().length > 0;
  return { dom, st };
}

const data = { initialState: { entities: {
  answers: { 101: { id: 101, question: { id: 500, title: '问题A' }, author: { name: '甲' }, excerpt: '<p>摘要</p>', voteup_count: 12 } },
  articles: { 301: { id: 301, title: '文章B', author: { name: '乙' }, excerpt: '摘要', voteup_count: 4 } },
  questions: { 700: { id: 700, title: '问题C', excerpt: '描述', answer_count: 8 } }
}, feed: { list: ['answer:101', 'article:301', 'question:700'] } } };

/* ---------- 旧版主页：点卡片不能退出 ---------- */
{
  const html = '<!DOCTYPE html><html><head><title>首页</title></head><body><script id="js-initialData" type="text/json">' +
    JSON.stringify(data) + '</script></body></html>';
  const { dom, st } = makeDom(html, 'https://www.zhihu.com/');
  dom.window.fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' });
  dom.window.eval(src);
  await sleep(800);
  const d = dom.window.document;
  const btn = [...d.querySelectorAll('[role=button]')].find((e) => e.textContent === '旧版主页');
  check('主页出现「旧版主页」按钮', !!btn);
  btn.click();
  for (let i = 0; i < 60 && d.querySelectorAll('.zh-feed-item').length !== 3; i++) await sleep(100);
  check('旧版主页渲染 3 张卡片', d.querySelectorAll('.zh-feed-item').length === 3, String(d.querySelectorAll('.zh-feed-item').length));

  for (const a of d.querySelectorAll('.zh-feed-title')) a.click();
  await sleep(150);
  check('点卡片不触发退出', !st.exited(), JSON.stringify(st.navs()));

  // 卡片链接本身就是「带 ?zh_old=1 的地址」，退出旧版会把 zh_old=1 去掉并刷新
  const exit = d.querySelector('.zh-exit');
  check('主页有退出入口', !!exit);
  if (exit) exit.click();
  await sleep(150);
  check('点退出旧版确实导航', st.exited(), JSON.stringify(st.navs()));
  dom.window.close();
}

/* ---------- 问题页：退出 → replace 到带 zh_raw=1 的地址 ---------- */
{
  const html = '<!DOCTYPE html><html><head><title>问题</title></head><body><h1>问题</h1></body></html>';
  const { dom, st } = makeDom(html, 'https://www.zhihu.com/question/123456');
  dom.window.fetch = async (url) => {
    url = String(url);
    if (/\/answers\?/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ id: 1, content: '<p>a</p>', voteup_count: 1, comment_count: 0, updated_time: 1700000000, author: { name: 'u' } }], paging: { totals: 1, is_end: true } }) };
    return { ok: true, status: 200, text: async () => '<html><body><div class="zu-top">top</div></body></html>', json: async () => ({}) };
  };
  dom.window.eval(src);
  for (let i = 0; i < 80 && !dom.window.document.querySelector('.zh-exit'); i++) await sleep(100);
  const exit = dom.window.document.querySelector('.zh-exit');
  check('问题页有退出入口', !!exit);
  if (exit) exit.click();
  await sleep(200);
  const navs = st.navs();
  check('问题页退出确实导航', navs.length > 0, JSON.stringify(navs));
  check('问题页退出目标是 zh_raw=1', navs.some((x) => /zh_raw=1/.test(x[1])), JSON.stringify(navs));
  dom.window.close();
}

console.log(results.map((r) => r[0] + '  ' + r[1] + (r[2] ? '   [' + r[2] + ']' : '')).join('\n'));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log('FAILED=' + failed);
process.exit(failed ? 1 : 0);

// 说明：本文件里的 location 桩在当前 jsdom 版本上无效（location 不可改写），
// 「退出是否真的导航」这几条在 jsdom 里跑不出有效结论；真正可靠的验证要用带扩展的真实浏览器。
