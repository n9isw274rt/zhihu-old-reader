// ==UserScript==
// @name         知乎旧版阅读器
// @namespace    https://github.com/n9isw274rt/zhihu-old-reader
// @version      3.0.1
// @description  知乎旧版界面：问题页打开即接管，不再加载原站页面（?zh_raw=1 看原页）；含图片放大、楼中楼、评论分页、排序、竖排阅读导航、视频弹层
// @author       n9isw274rt
// @match        https://www.zhihu.com/
// @match        https://www.zhihu.com/question/*
// @run-at       document-start
// @noframes
// @grant        none
// @homepageURL  https://github.com/n9isw274rt/zhihu-old-reader
// @supportURL   https://github.com/n9isw274rt/zhihu-old-reader/issues
// @updateURL    https://raw.githubusercontent.com/n9isw274rt/zhihu-old-reader/dist/zhihu-old-reader.user.js
// @downloadURL  https://raw.githubusercontent.com/n9isw274rt/zhihu-old-reader/dist/zhihu-old-reader.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 防止脚本被重复注入（部分管理器会在 SPA 跳转后重跑）
  if (window.__zhOldReaderBooted) return;
  window.__zhOldReaderBooted = true;

  var CFG = {
    PAGE_SIZE: 20,      // 每页拉多少条回答（问题页首屏 + 加载更多共用）
    TIMEOUT: 15000      // 单个请求超时（毫秒）
  };

  // 列表接口一次把正文、赞同、作者都带回来，别为每条回答再单独发请求。
  // 注意知乎 include 解析的怪癖：voteup_count 和 comment_count 同时要，后者会被吞掉，
  // 所以评论数另外发一条只带 comment_count 的请求，按 id 合并（两条请求都只是列表页大小）。
  var LIST_INCLUDE = 'data[*].content,data[*].voteup_count,data[*].updated_time,' +
                     'data[*].author.name,data[*].author.headline,data[*].author.avatar_url,' +
                     'data[*].author.url_token';
  var COMMENT_INCLUDE = 'data[*].comment_count';

  var RAW_QUERY = 'zh_raw=1';   // 逃生口：带这个参数就完全不碰原页面

  var CSS_URL = '/static/revved/-/css/z.030a2a98.css';

  function isRawMode() {
    return /(?:^|[?&])zh_raw=1(?:&|$)/.test(location.search);
  }

  // 去掉/加上 zh_raw，保留其它查询参数和 hash
  function urlWithRaw(on) {
    var parts = location.search.replace(/^\?/, '').split('&').filter(function (s) {
      return s && s !== RAW_QUERY && s.indexOf('zh_raw=') !== 0;
    });
    if (on) parts.push(RAW_QUERY);
    return location.pathname + (parts.length ? '?' + parts.join('&') : '') + location.hash;
  }

  // 主站 CSS 拉不到时的兜底（只兜结构，样式全在 extraCss 里）
  var BASE_CSS = [
    'body{margin:0;font:14px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#222;background:#fff}',
    'a{color:#175199;text-decoration:none}',
    '.zg-wrap{box-sizing:border-box;max-width:960px;margin:0 auto}',
    '.zu-main{overflow:hidden;padding:20px 0 50px}',
    '.zu-main-content{float:left;width:640px}',
    '.zu-main-sidebar{float:right;width:290px}',
    '.zu-top{background:#fff;border-bottom:1px solid #eee;padding:8px 0;margin-bottom:16px}',
    '.zu-top .zg-wrap{display:flex;gap:16px;align-items:center;font-size:13px}',
    '.zu-top a{color:#666}',
    '#zh-footer{clear:both;text-align:center;color:#999;font-size:12px;padding:28px 0;border-top:1px solid #eee}',
    '.zm-item-answer{position:relative}',
    '.zm-votebar{position:absolute;left:-48px;top:16px;width:40px;text-align:center}',
    '.clearfix:after{content:"";display:table;clear:both}'
  ].join('');

  // ==================== 通用工具 ====================

  function absUrl(u) {
    if (!u) return '';
    u = String(u).trim();
    if (u.indexOf('//') === 0) return 'https:' + u;
    if (/^https?:\/\//i.test(u)) return u;
    return '';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function votesFmt(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }

  var toastEl = null, toastTimer = 0;
  function toast(msg, isErr) {
    if (!document.body) return;
    if (!toastEl || toastEl.parentNode !== document.body) {
      toastEl = document.createElement('div');
      toastEl.className = 'zh-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = String(msg || '');
    toastEl.className = 'zh-toast zh-toast-show' + (isErr ? ' zh-toast-err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl) toastEl.className = 'zh-toast';
    }, 2600);
  }

  function apiErrorText(e, fallback) {
    var s = e && e.status;
    if (s === 401 || s === 403) return '知乎接口拒绝了请求，请先登录后再试';
    if (e && e.name === 'AbortError') return '请求超时，请检查网络';
    return fallback || '请求失败';
  }

  // 统一 JSON 请求：超时、非 2xx、非 JSON 都变成可读的异常
  function fetchJSON(url, extraHeaders) {
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = 0;
    var headers = { accept: 'application/json' };
    if (extraHeaders) {
      for (var hk in extraHeaders) {
        if (Object.prototype.hasOwnProperty.call(extraHeaders, hk)) headers[hk] = extraHeaders[hk];
      }
    }
    var opt = { credentials: 'include', headers: headers, cache: 'no-store' };
    if (ctl) {
      opt.signal = ctl.signal;
      timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, CFG.TIMEOUT);
    }
    return fetch(url, opt).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json().then(null, function () { throw new Error('响应不是 JSON'); });
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  function fetchText(url) {
    return fetch(url, { credentials: 'include', cache: 'no-store' }).then(function (res) {
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.text();
    });
  }

  // 回答正文要整段 document.write 进页面，先把可执行内容摘掉（正常内容走快路径，零开销）
  var UNSAFE_HINT = /<script|<style|on[a-z]+\s*=|javascript:/i;
  function safeContent(html) {
    html = String(html == null ? '' : html);
    if (!UNSAFE_HINT.test(html)) return html;
    try {
      var doc = new DOMParser().parseFromString('<div id="zh-sanitize-root"></div>', 'text/html');
      var root = doc.getElementById('zh-sanitize-root');
      if (!root) return html.replace(/<script[\s\S]*?<\/script\s*>/gi, '').replace(/<style[\s\S]*?<\/style\s*>/gi, '');
      root.innerHTML = html;
      var bad = root.querySelectorAll('script,style');
      for (var i = bad.length - 1; i >= 0; i--) {
        if (bad[i].parentNode) bad[i].parentNode.removeChild(bad[i]);
      }
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        if (!el.attributes) continue;
        for (var k = el.attributes.length - 1; k >= 0; k--) {
          var at = el.attributes[k];
          if (/^on/i.test(at.name)) el.removeAttribute(at.name);
        }
        var href = el.getAttribute('href');
        if (href && /^\s*javascript:/i.test(href)) el.setAttribute('href', '#');
      }
      return root.innerHTML;
    } catch (e) {
      return html.replace(/<script[\s\S]*?<\/script\s*>/gi, '').replace(/<style[\s\S]*?<\/style\s*>/gi, '');
    }
  }

  // 一次请求拿整页回答（正文 + 赞同 + 作者）。评论数由另一条请求后台补。
  async function fetchAnswerPage(qid, offset, limit) {
    var j = await fetchJSON('/api/v4/questions/' + qid + '/answers?limit=' + limit + '&offset=' + offset +
      '&include=' + encodeURIComponent(LIST_INCLUDE));
    var data = (j && j.data) || [];

    return {
      data: data,
      totals: Number(j && j.paging && j.paging.totals) || 0,
      isEnd: !!(j && j.paging && j.paging.is_end),
      title: data[0] && data[0].question ? String(data[0].question.title || '') : ''
    };
  }

  // 评论数单独一条请求补（列表接口的 include 同时要 voteup_count 和 comment_count 会吞掉后者）。
  // 它不参与首屏：页面先画出来，数字回来了再补进 DOM，失败就维持“查看评论”。
  async function fillCommentCounts(qid, offset, limit) {
    if (!limit) return {};
    var j = await fetchJSON('/api/v4/questions/' + qid + '/answers?limit=' + limit + '&offset=' + offset +
      '&include=' + encodeURIComponent(COMMENT_INCLUDE));
    var data = (j && j.data) || [];
    var byId = {};
    for (var i = 0; i < data.length; i++) {
      var id = String(data[i].id);
      if (data[i].comment_count == null) continue;
      byId[id] = data[i].comment_count;
      var link = document.querySelector('.toggle-comment[data-aid="' + id + '"]');
      if (link) {
        link.textContent = data[i].comment_count + ' 条评论';
        link.setAttribute('data-total', String(data[i].comment_count));
      }
    }
    return byId;
  }

  // /question/<qid>/log 还是 2014 年的服务端页面：标题、页头、页脚、当前 z.css 都在这份 HTML 里
  function parseOldShell(html) {
    var out = { top: '', footer: '', css: '', title: '' };
    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var topEl = doc.querySelector('.zu-top');
      var ftEl = doc.querySelector('#zh-footer');
      if (topEl) out.top = stripScripts(topEl.outerHTML);
      if (ftEl) out.footer = stripScripts(ftEl.outerHTML);
      var links = doc.querySelectorAll('link[rel="stylesheet"][href]');
      for (var i = 0; i < links.length; i++) {
        var h = links[i].getAttribute('href') || '';
        if (/\/static\/revved\/-\/css\/z\.[0-9a-f]+\.css/.test(h)) { out.css = h; break; }
      }
      out.title = String(doc.title || '')
        .replace(/^问题日志\s*[-·—]\s*/, '')
        .replace(/\s*-\s*知乎\s*$/, '')
        .trim();
    } catch (e) {
      console.warn('[zh-old] 旧版头尾解析失败', e);
    }
    return out;
  }

  function stripScripts(html) {
    return String(html || '').replace(/<script[\s\S]*?<\/script\s*>/gi, '');
  }

  // ==================== 接管文档：先出骨架，再等数据 ====================

  var SKELETON_CSS = [
    'html,body{margin:0;min-height:100%;background:#fff;color:#222;font:14px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
    '.zh-boot{max-width:640px;margin:0 auto;padding:76px 20px 60px}',
    '.zh-boot-hd{font-size:13px;color:#999;border-bottom:1px solid #eee;padding-bottom:12px;margin-bottom:26px}',
    '.zh-boot-t{font-size:18px;font-weight:700;line-height:1.5;color:#222}',
    '.zh-boot-s{margin-top:12px;color:#8590a6;font-size:13px}',
    '.zh-boot-bar{margin-top:18px;height:3px;background:#eee;overflow:hidden;border-radius:2px;position:relative}',
    '.zh-boot-bar:after{content:"";position:absolute;left:-40%;top:0;bottom:0;width:40%;background:#0e6eb8;animation:zhb 1.1s ease-in-out infinite}',
    '@keyframes zhb{0%{left:-40%}100%{left:100%}}',
    '.zh-boot-err{margin-top:16px;padding:12px 14px;border:1px solid #f0d6d2;background:#fff8f7;color:#b03a2e;border-radius:4px;line-height:1.7}',
    '.zh-boot-act{margin-top:16px}',
    '.zh-boot-act a{display:inline-block;margin:0 10px 8px 0;padding:6px 16px;border:1px solid #ddd;border-radius:3px;color:#0e6eb8;cursor:pointer;font-size:13px;text-decoration:none}',
    '.zh-boot-act a:hover{border-color:#0e6eb8}'
  ].join('');

  // 在 document-start 直接把原文档换掉：解析器被中止，知乎的 bundle 不会执行
  function writeBootSkeleton() {
    var html =
      '<!DOCTYPE html><html lang="zh-CN"><head>' +
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="color-scheme" content="light">' +
      '<title>正在加载… - 知乎</title>' +
      '<style>' + SKELETON_CSS + '</style></head>' +
      '<body><div class="zh-boot" id="zh-boot">' +
        '<div class="zh-boot-hd">知乎 · 旧版阅读</div>' +
        '<div class="zh-boot-t" id="zh-boot-title">正在加载…</div>' +
        '<div class="zh-boot-s" id="zh-boot-status">已跳过知乎原页面，正在获取问题数据…</div>' +
        '<div class="zh-boot-bar"></div>' +
      '</div></body></html>';
    // 只用 document.open/write 接管：实测在这里调 window.stop() 会把这次导航一并掐掉，
    // document 变成空白文档，后面写进去的内容全丢（原页面也回不来）。
    try {
      document.open();
      document.write(html);
      document.close();
    } catch (e) {
      console.error('[zh-old] 接管文档失败', e);
    }
  }

  function setBootTitle(t) {
    var el = document.getElementById('zh-boot-title');
    if (el && t) el.textContent = t;
    if (t) document.title = t + ' - 知乎';
  }

  function setBootStatus(t) {
    var el = document.getElementById('zh-boot-status');
    if (el && t) el.textContent = t;
  }

  function renderBootError(msg) {
    var host = document.getElementById('zh-boot');
    if (!host) return;
    setBootTitle('暂时打不开这个问题');
    setBootStatus('原页面已经被跳过，所以这里不会卡。');
    var bar = host.querySelector('.zh-boot-bar');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);

    var box = document.createElement('div');
    box.className = 'zh-boot-err';
    box.textContent = String(msg || '获取回答失败');
    host.appendChild(box);

    var act = document.createElement('div');
    act.className = 'zh-boot-act';
    act.innerHTML = '<a id="zh-boot-retry" role="button">重试</a>' +
                    '<a id="zh-boot-raw" role="button">打开原版页面（会加载原站）</a>';
    host.appendChild(act);

    var retry = document.getElementById('zh-boot-retry');
    if (retry) retry.onclick = function () { location.reload(); };
    var raw = document.getElementById('zh-boot-raw');
    if (raw) raw.onclick = function () { location.replace(urlWithRaw(true)); };
  }

  // ==================== 主流程 ====================

  async function zhOldReader() {
    var qid = (location.pathname.match(/question\/(\d+)/) || [])[1];
    if (!qid) return false;
    var startPath = location.pathname;

    setBootStatus('正在获取回答…');
    // 头尾和回答并发拉；/log 同时提供标题兜底和当前 z.css 文件名
    var logP = fetchText('/question/' + qid + '/log').then(parseOldShell, function (e) {
      console.warn('[zh-old] 旧版头尾获取失败，已跳过', e);
      return { top: '', footer: '', css: '', title: '' };
    });

    var first;
    try {
      first = await fetchAnswerPage(qid, 0, CFG.PAGE_SIZE);
    } catch (e) {
      console.warn('[zh-old] 列表接口失败', e);
      renderBootError(apiErrorText(e, '获取回答列表失败'));
      return false;
    }
    if (location.pathname !== startPath) return false;

    // 头尾只是锦上添花，最多等 1.5s，拖不到首屏
    var shell = await Promise.race([logP, new Promise(function (res) {
      setTimeout(function () { res({ top: '', footer: '', css: '', title: '' }); }, 1500);
    })]);

    var pageTitle = first.title || shell.title || '知乎问题';
    var cssUrl = shell.css || CSS_URL;
    document.title = pageTitle + ' - 知乎';

    // ---------- 渲染状态 ----------
    var loadedAnswers = first.data.slice();
    var totalAnswers = first.totals || loadedAnswers.length;
    var nextOffset = first.data.length;
    var seenIds = {};
    for (var s = 0; s < loadedAnswers.length; s++) seenIds[String(loadedAnswers[s].id)] = 1;
    var sortMode = 'quality';
    var loadingMore = false, reachedEnd = first.isEnd || !loadedAnswers.length;

    var navEl = null, navIO = null, navItems = [], navCur = 0, navTotal = 0;
    var navSupportsTimeline = (function () {
      try { return !!(window.CSS && CSS.supports && CSS.supports('animation-timeline: scroll()')); }
      catch (e) { return false; }
    })();

    var lbEl = null, videoEl = null, scrollLocks = 0;

    // ---------- 5. 图片 ----------
    function applyImgSize(im) {
      var rw = parseInt(im.getAttribute('data-rawwidth') || '0', 10) || 0;
      var rh = parseInt(im.getAttribute('data-rawheight') || '0', 10) || 0;
      if (!rw || !rh) return;

      var mw = 0;
      var mm = (im.getAttribute('src') || '').match(/_(\d+)w\./);
      if (mm) mw = parseInt(mm[1], 10) || 0;

      var w = (mw && mw < rw) ? mw : rw;   // 用显示版宽度，别把位图放大
      var h = Math.round(w * rh / rw);
      im.setAttribute('width', w);
      im.setAttribute('height', h);

      var shrink = function () {
        var nw = im.naturalWidth || 0;
        if (nw && nw < w) {
          im.setAttribute('width', nw);
          im.setAttribute('height', Math.round(nw * rh / rw));
        }
      };
      // 已经加载完的图（缓存命中）不会再触发 load，必须当场算
      var src = im.getAttribute('src') || '';
      if (src.indexOf('http') === 0 && im.complete && im.naturalWidth) shrink();
      else if (im.addEventListener) im.addEventListener('load', shrink, { once: true });
    }

    function fixImages(root) {
      if (!root || !root.querySelectorAll) return;

      // noscript 里往往才是真图：先把它抄给隔壁的懒加载图，再删 noscript
      var ns = root.querySelectorAll('noscript');
      for (var n = ns.length - 1; n >= 0; n--) {
        var nsImg = ns[n].querySelector && ns[n].querySelector('img[src]');
        var sib = ns[n].previousElementSibling;
        if (nsImg && sib && sib.tagName === 'IMG' &&
            !sib.getAttribute('data-actualsrc') && !sib.getAttribute('data-original')) {
          var nsSrc = absUrl(nsImg.getAttribute('src'));
          if (nsSrc) sib.setAttribute('data-actualsrc', nsSrc);
        }
        if (ns[n].parentNode) ns[n].parentNode.removeChild(ns[n]);
      }

      var imgs = root.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        var im = imgs[i];
        if (im.getAttribute('data-zh-fixed')) continue;   // 同一张图会被 fixImages 扫多次
        im.setAttribute('data-zh-fixed', '1');

        var full = absUrl(im.getAttribute('data-original')) || absUrl(im.getAttribute('data-actualsrc'));
        var actual = absUrl(im.getAttribute('data-actualsrc')) || full;
        if (actual) im.setAttribute('src', actual);

        var isAvatar = im.classList && im.classList.contains('zm-item-img-avatar');
        var isEmoji = im.classList && (im.classList.contains('ztext-emoji') || im.classList.contains('emojis'));
        var rw0 = parseInt(im.getAttribute('data-rawwidth') || '0', 10) || 0;
        var fullUrl = full || actual;
        // 头像、表情、小图标不进灯箱
        if (fullUrl && !isAvatar && !isEmoji && (!rw0 || rw0 >= 80)) {
          im.setAttribute('data-zh-full', fullUrl);
          im.setAttribute('data-zh-zoomable', '1');
        }

        applyImgSize(im);

        im.removeAttribute('data-original');
        im.removeAttribute('data-actualsrc');
        im.removeAttribute('data-original-token');
        if (im.classList) im.classList.remove('lazy');
        if (!im.hasAttribute('loading')) im.setAttribute('loading', 'lazy');
        if (!im.hasAttribute('decoding')) im.setAttribute('decoding', 'async');
        if (!im.getAttribute('alt')) im.setAttribute('alt', '');
      }
      enhanceVideos(root);
    }

    // ---------- 6. 视频卡片 ----------
    function videoIdFromHref(href) {
      if (!href) return null;
      var m = String(href).match(/video\/(\d{6,})/);
      if (m) return m[1];
      try { m = decodeURIComponent(href).match(/video\/(\d{6,})/); } catch (e) { m = null; }
      return m ? m[1] : null;
    }

    function enhanceVideos(root) {
      if (!root || !root.querySelectorAll) return;
      var as = root.querySelectorAll('a[href]');
      for (var i = 0; i < as.length; i++) {
        var a = as[i];
        if (a.classList && a.classList.contains('zh-video-card')) continue;
        if (!a.closest || !a.closest('.zm-item-rich-text')) continue;
        var vid = videoIdFromHref(a.getAttribute('href'));
        if (!vid) continue;
        a.classList.add('zh-video-card');
        a.setAttribute('data-vid', vid);
        var txt = (a.textContent || '').trim();
        if (!txt || /^https?:\/\//i.test(txt)) {
          var t = a.getAttribute('data-draft-title') || a.getAttribute('title') || '';
          a.textContent = t || '播放视频';
        }
        a.setAttribute('title', '点击在本页播放');
      }
    }

    // ---------- 7. 左侧阅读导航 ----------
    function buildNav() {
      var host = document.querySelector('.zu-main-sidebar') || document.body;
      if (!host) return null;
      if (navEl && navEl.parentNode === host) return navEl;

      navEl = document.createElement('div');
      navEl.className = 'zh-nav';
      navEl.innerHTML =
        '<div class="zh-nav-inner">' +
          '<div class="zh-nav-hd">阅读导航</div>' +
          '<div class="zh-progress"><div class="zh-progress-bar"></div></div>' +
          '<div class="zh-nav-pos"><span class="zh-pos-cur">1</span> / <span class="zh-pos-total">' + navTotal + '</span></div>' +
          '<a class="zh-nav-btn zh-nav-step" role="button" data-dir="-1">&uarr; 上一条</a>' +
          '<a class="zh-nav-btn zh-nav-step" role="button" data-dir="1">&darr; 下一条</a>' +
          '<a class="zh-nav-btn zh-nav-sort on" role="button" data-sort="quality" aria-current="true">按质量排序</a>' +
          '<a class="zh-nav-btn zh-nav-sort" role="button" data-sort="time">按时间排序</a>' +
          '<a class="zh-nav-btn zh-nav-more" role="button">加载更多</a>' +
          '<a class="zh-nav-btn zh-nav-top" role="button">回到顶部</a>' +
        '</div>';
      host.appendChild(navEl);
      return navEl;
    }

    function syncNavState() {
      if (!navEl) return;
      var cur = navEl.querySelector('.zh-pos-cur');
      var tot = navEl.querySelector('.zh-pos-total');
      if (cur) cur.textContent = String(navTotal ? navCur + 1 : 0);
      if (tot) tot.textContent = String(navTotal);

      var sorts = navEl.querySelectorAll('.zh-nav-sort');
      for (var i = 0; i < sorts.length; i++) {
        var on = sorts[i].getAttribute('data-sort') === sortMode;
        if (on) sorts[i].classList.add('on');
        else sorts[i].classList.remove('on');
        if (on) sorts[i].setAttribute('aria-current', 'true');
        else sorts[i].removeAttribute('aria-current');
      }

      if (!navSupportsTimeline) {
        var p = navTotal ? (navCur + 1) / navTotal : 0;
        var bar = navEl.querySelector('.zh-progress-bar');
        if (bar) bar.style.transform = 'scaleX(' + p + ')';
      }
    }

    function observeAnswers() {
      var items = [].slice.call(document.querySelectorAll('#zh-question-answer-wrap .zh-question-answer-wrapper'));
      navItems = items;
      navTotal = items.length;

      if (navIO) { navIO.disconnect(); navIO = null; }
      if (!items.length) { syncNavState(); return; }

      if ('IntersectionObserver' in window) {
        navIO = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) {
              var idx = parseInt(entries[i].target.getAttribute('data-zh-idx'), 10);
              if (!isNaN(idx)) navCur = idx;
            }
          }
          syncNavState();
        }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
        for (var i = 0; i < items.length; i++) {
          items[i].setAttribute('data-zh-idx', String(i));
          navIO.observe(items[i]);
        }
      }
      // 重挂观察器后先按 DOM 现算一次，避免显示旧值
      navCur = navCurrentIndex();
      syncNavState();
    }

    function navCurrentIndex() {
      if (!navItems.length) return 0;
      var line = window.scrollY + 80;
      for (var i = 0; i < navItems.length; i++) {
        var r = navItems[i].getBoundingClientRect();
        if (r.top + window.scrollY + r.height > line) return i;
      }
      return navItems.length - 1;
    }

    function navGo(dir) {
      if (!navItems.length) return;
      var cur = navCurrentIndex();
      var curTop = navItems[cur].getBoundingClientRect().top + window.scrollY;
      var into = (window.scrollY + 80) - curTop;
      var target = (dir < 0) ? ((into > 200) ? cur : Math.max(0, cur - 1))
                             : Math.min(navItems.length - 1, cur + 1);
      var el = navItems[target];
      if (!el) return;
      var y = el.getBoundingClientRect().top + window.scrollY - 8;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }

    // ---------- 8. 计数 / 加载更多 ----------
    function setLoadedCount() {
      var nodes = document.querySelectorAll('.zh-loaded');
      for (var i = 0; i < nodes.length; i++) nodes[i].textContent = String(loadedAnswers.length);
    }

    function setTotalCount(n) {
      if (!n) return;
      totalAnswers = n;
      var nodes = document.querySelectorAll('.zh-total');
      for (var i = 0; i < nodes.length; i++) nodes[i].textContent = String(n);
    }

    function updateMoreButtons(state) {
      var btns = document.querySelectorAll('.pager-more, .zh-nav-more');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var isNav = b.classList && b.classList.contains('zh-nav-more');
        if (state === 'loading') {
          b.textContent = '加载中…';
          b.style.pointerEvents = 'none';
          b.style.opacity = '.6';
        } else if (state === 'end') {
          b.textContent = '没有更多了';
          b.style.pointerEvents = '';
          b.style.opacity = '';
          b.style.display = 'none';
        } else if (state === 'error') {
          b.textContent = '加载失败，点击重试';
          b.style.pointerEvents = '';
          b.style.opacity = '';
        } else {
          b.style.display = '';
          b.textContent = isNav ? '加载更多' : '加载更多回答';
          b.style.pointerEvents = '';
          b.style.opacity = '';
        }
      }
    }

    async function loadMore(source) {
      if (loadingMore || reachedEnd) return;
      loadingMore = true;
      updateMoreButtons('loading');

      var pageOffset = nextOffset;
      try {
        var page = await fetchAnswerPage(qid, pageOffset, CFG.PAGE_SIZE);
        if (!page.data.length) {
          reachedEnd = true;
          updateMoreButtons('end');
          return;
        }
        if (page.totals) setTotalCount(page.totals);

        var fresh = [], seenNew = {};
        for (var q = 0; q < page.data.length; q++) {
          var id = String(page.data[q].id);
          if (!seenIds[id] && !seenNew[id]) { seenNew[id] = 1; fresh.push(page.data[q]); }
        }
        if (!fresh.length) {
          if (page.isEnd) reachedEnd = true;
          updateMoreButtons(page.isEnd ? 'end' : 'error');
          return;
        }

        // 只给这一批排个序，然后整批追加到末尾。
        // 不能像以前那样把新回答并进全表重排：底部点“加载更多”时新回答可能被插到视口上方，
        // 滚动锚点又把人钉在原处，看起来就像“加载了但页面没动”。
        fresh.sort(compareAnswers);

        var wrap = document.getElementById('zh-question-answer-wrap');
        var addHtml = '', firstNew = null;
        for (var y = 0; y < fresh.length; y++) {
          seenIds[String(fresh[y].id)] = 1;
          loadedAnswers.push(fresh[y]);
          addHtml += makeAnswerHtml(fresh[y]);
        }
        if (wrap && addHtml) {
          var before = wrap.children.length;
          wrap.insertAdjacentHTML('beforeend', addHtml);
          firstNew = wrap.children[before] || null;
        }
        fixImages(wrap);

        nextOffset = pageOffset + page.data.length;   // 只有真正成功才推进
        setLoadedCount();
        observeAnswers();   // 新节点入列表，阅读导航的数字和观察器跟着更新

        // 底部“加载更多回答”：把视口带到新加载的第一条，别让用户以为没反应
        if (source === 'pager' && firstNew) {
          var top = firstNew.getBoundingClientRect().top + window.scrollY - 8;
          try {
            window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
          } catch (e) {
            window.scrollTo(0, Math.max(0, top));
          }
        } else if (source === 'nav') {
          toast('已加载 ' + fresh.length + ' 条回答');
        }

        fillCommentCounts(qid, pageOffset, page.data.length).then(function (counts) {
          for (var i = 0; i < fresh.length; i++) {
            var k = String(fresh[i].id);
            if (fresh[i].comment_count == null && counts[k] != null) fresh[i].comment_count = counts[k];
          }
        }, function () {});

        if (page.isEnd) {
          reachedEnd = true;
          updateMoreButtons('end');
        } else {
          updateMoreButtons('idle');
        }
      } catch (e) {
        console.warn('[zh-old] 加载更多失败', e);
        updateMoreButtons('error');
      } finally {
        loadingMore = false;
      }
    }

    // ---------- 9. 排序 ----------
    function compareAnswers(x, y) {
      if (sortMode === 'time') {
        return (Number(y.updated_time) || 0) - (Number(x.updated_time) || 0);
      }
      return (Number(y.voteup_count) || 0) - (Number(x.voteup_count) || 0) ||
             (Number(y.updated_time) || 0) - (Number(x.updated_time) || 0);
    }

    function sortedAnswers() {
      return loadedAnswers.slice().sort(compareAnswers);
    }

    // 排序只挪现有 DOM 节点：评论内容、展开状态、图片全都保住
    function sortAnswers() {
      var wrap = document.getElementById('zh-question-answer-wrap');
      if (!wrap) return;

      var order = sortedAnswers();
      var nodes = {}, kids = [].slice.call(wrap.children), i;
      for (i = 0; i < kids.length; i++) {
        var el = kids[i];
        var aid = (el.getAttribute && el.getAttribute('data-aid')) ||
                  (el.firstElementChild && el.firstElementChild.getAttribute('data-aid'));
        if (aid) nodes[aid] = el;
      }

      for (i = 0; i < order.length; i++) {
        if (!nodes[String(order[i].id)]) { renderList(); return; }   // 结构对不上就整段重绘
      }

      var frag = document.createDocumentFragment();
      for (i = 0; i < order.length; i++) {
        var key = String(order[i].id);
        if (nodes[key]) { frag.appendChild(nodes[key]); delete nodes[key]; }
      }
      for (var k in nodes) {
        if (Object.prototype.hasOwnProperty.call(nodes, k)) frag.appendChild(nodes[k]);
      }
      wrap.appendChild(frag);
      observeAnswers();
    }

    function renderList() {
      var wrap = document.getElementById('zh-question-answer-wrap');
      if (!wrap) return;
      wrap.innerHTML = sortedAnswers().map(makeAnswerHtml).join('');
      fixImages(wrap);
      setLoadedCount();
      observeAnswers();
    }

    function withScrollAnchor(fn) {
      var idx = navCurrentIndex();
      var anchor = navItems[idx];
      var aid = anchor ? (anchor.getAttribute('data-aid') || '') : '';
      var before = anchor ? anchor.getBoundingClientRect().top : 0;
      fn();
      if (!aid) return;
      var el = document.querySelector('#zh-question-answer-wrap .zh-question-answer-wrapper[data-aid="' + aid + '"]');
      if (!el) return;
      var dy = el.getBoundingClientRect().top - before;
      if (Math.abs(dy) > 2) window.scrollTo(0, Math.max(0, window.scrollY + dy));
    }

    function updateSortUI() {
      var links = document.querySelectorAll('.answers-filter [data-sort]');
      for (var i = 0; i < links.length; i++) {
        var on = links[i].getAttribute('data-sort') === sortMode;
        links[i].className = on ? 'on' : '';
        if (on) links[i].setAttribute('aria-current', 'true');
        else links[i].removeAttribute('aria-current');
      }
      syncNavState();
    }

    function setSort(mode) {
      mode = (mode === 'time') ? 'time' : 'quality';
      // 点当前已选中的排序也重新排一次：加载更多是追加到末尾的，点一下能把整页重新归位
      var changed = mode !== sortMode;
      sortMode = mode;
      updateSortUI();
      if (changed || loadedAnswers.length > 1) withScrollAnchor(sortAnswers);
    }

    // ---------- 10. 回答 HTML ----------
    function makeAnswerHtml(a) {
      var au = a.author || {};
      var aid = esc(a.id);
      var answerUrl = 'https://www.zhihu.com/answer/' + aid;
      var peopleUrl = au.url_token ? ('https://www.zhihu.com/people/' + au.url_token)
                    : (au.id ? ('https://www.zhihu.com/people/' + au.id) : '');
      var avatar = au.avatar_url
        ? '<a class="zm-item-link-avatar"' + (peopleUrl ? ' href="' + esc(peopleUrl) + '" target="_blank" rel="noopener noreferrer"' : '') + '>' +
          '<img class="zm-item-img-avatar" src="' + esc(au.avatar_url) + '" alt=""></a>'
        : '';
      var author = '<a class="author-link"' + (peopleUrl ? ' href="' + esc(peopleUrl) + '" target="_blank" rel="noopener noreferrer"' : '') + '>' + esc(au.name || '匿名用户') + '</a>';
      var hasCc = a.comment_count != null && !isNaN(Number(a.comment_count));
      var ccount = hasCc ? Number(a.comment_count) : 0;

      return '<div class="zh-question-answer-wrapper" data-aid="' + aid + '"><div class="zm-item-answer" id="answer-' + aid + '" data-aid="' + aid + '">' +
        '<div class="zm-votebar">' +
          '<a class="up" href="' + answerUrl + '" target="_blank" rel="noopener noreferrer" title="赞同（跳转原页需登录）"><i class="vote-arrow"></i><span class="count">' + votesFmt(a.voteup_count) + '</span></a>' +
          '<a class="down" href="' + answerUrl + '" target="_blank" rel="noopener noreferrer" title="反对（跳转原页需登录）"><i class="vote-arrow"></i></a>' +
        '</div>' +
        '<div class="answer-head">' +
          '<div class="zm-item-answer-author-info">' +
            avatar + author +
            (au.headline ? '<div class="bio">' + esc(au.headline) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="zm-item-rich-text">' + safeContent(a.content) + '</div>' +
        '<div class="zm-item-meta clearfix">' +
          '<a class="toggle-comment" data-aid="' + aid + '" data-total="' + ccount + '" role="button">' + (hasCc ? ccount + ' 条评论' : '查看评论') + '</a>' +
          '<a class="meta-item" href="' + answerUrl + '" target="_blank" rel="noopener noreferrer" title="在原站操作（需登录）">感谢</a>' +
          '<a class="meta-item" href="' + answerUrl + '" target="_blank" rel="noopener noreferrer" title="在原站操作（需登录）">收藏</a>' +
          '<a class="meta-item meta-share" href="' + answerUrl + '" target="_blank" rel="noopener noreferrer" data-url="' + answerUrl + '" title="复制链接">分享</a>' +
          '<a class="meta-time" href="' + answerUrl + '" target="_blank" rel="noopener noreferrer">' + fmtDate(a.updated_time) + '</a>' +
        '</div>' +
        '<div class="zm-comment-box" data-aid="' + aid + '" style="display:none"></div>' +
      '</div></div>';
    }

    // ---------- 11. 评论 ----------
    function peopleUrl(m) {
      if (!m) return '';
      if (m.url_token) return 'https://www.zhihu.com/people/' + m.url_token;
      if (m.id) return 'https://www.zhihu.com/people/' + m.id;
      return '';
    }

    function commentRow(c, isReply) {
      var au = (c.author && c.author.member) || {};
      var ra = c.reply_to_author && c.reply_to_author.member;
      var purl = peopleUrl(au);
      var rurl = peopleUrl(ra);

      var prefix = (isReply && ra)
        ? '<span class="reply-prefix">回复 <a class="mention"' + (rurl ? ' href="' + esc(rurl) + '" target="_blank" rel="noopener noreferrer"' : '') + '>@' + esc(ra.name) + '</a>：</span>'
        : '';
      var kids = Number(c.child_comment_count) || 0;
      var expand = kids > 0
        ? '<a class="comment-expand" data-cid="' + esc(c.id) + '" data-count="' + kids + '" data-offset="0" role="button">展开 ' + kids + ' 条回复</a>'
        : '';

      return '<div class="zm-item-comment' + (isReply ? ' zm-item-comment-reply' : '') + '" data-cid="' + esc(c.id) + '">' +
        '<a class="zm-item-link-avatar"' + (purl ? ' href="' + esc(purl) + '" target="_blank" rel="noopener noreferrer"' : '') + '>' +
          (au.avatar_url ? '<img class="zm-item-img-avatar" src="' + esc(au.avatar_url) + '" loading="lazy" alt="">' : '') + '</a>' +
        '<div class="zm-comment-content-wrap">' +
          '<div class="zm-comment-hd">' +
            '<a class="author-link"' + (purl ? ' href="' + esc(purl) + '" target="_blank" rel="noopener noreferrer"' : '') + '>' + esc(au.name || '匿名用户') + '</a> ' +
            '<span class="desc">' + fmtDate(c.created_time) + '</span>' +
            (c.is_author ? ' <span class="desc">[作者]</span>' : '') +
            (c.vote_count ? ' <span class="desc">· ' + esc(c.vote_count) + ' 赞</span>' : '') +
          '</div>' +
          '<div class="zm-comment-content">' + prefix + safeContent(c.content) + '</div>' +
          expand +
        '</div></div>';
    }

    async function loadComments(box, aid, offsetIn) {
      var LIMIT = 20;
      var j = await fetchJSON('/api/v4/answers/' + aid + '/root_comments?order_by=time&limit=' + LIMIT + '&offset=' + offsetIn);
      var list = (j && j.data) || [];
      var next = offsetIn + list.length;

      // 评论区一直在进新评论时 offset 会漂移，按 cid 去重
      var seenCid = {};
      var olds = box.querySelectorAll('.zm-item-comment');
      for (var o = 0; o < olds.length; o++) seenCid[olds[o].getAttribute('data-cid')] = 1;

      var rows = [];
      for (var r = 0; r < list.length; r++) {
        var cidKey = String(list[r].id);
        if (seenCid[cidKey]) continue;
        seenCid[cidKey] = 1;
        rows.push(list[r]);
      }

      var h = '';
      for (var i = 0; i < rows.length; i++) h += commentRow(rows[i], false);
      if (!h && offsetIn === 0) h = '<div class="cmt-empty">还没有评论</div>';

      // 知乎 root_comments 的 paging.totals / is_end 都不可信（实测 31 条根评论 totals=1、is_end=true），
      // 所以“还有更多”只能按“这一页是不是满的”判断。
      var tail = '';
      if (list.length >= LIMIT) {
        tail = '<a class="comment-more" data-aid="' + aid + '" data-offset="' + next + '" role="button">加载更多评论</a>';
      }

      if (offsetIn > 0) {
        var oldMore = box.querySelector('.comment-more');
        if (oldMore && oldMore.parentNode) oldMore.parentNode.removeChild(oldMore);
        box.insertAdjacentHTML('beforeend', h + tail);
      } else {
        box.innerHTML = h + tail;
      }
      fixImages(box);
    }

    async function expandReplies(link) {
      if (link.dataset.loading) return;
      link.dataset.loading = '1';

      var cid = link.getAttribute('data-cid');
      var coff = parseInt(link.getAttribute('data-offset') || '0', 10) || 0;
      var parentRow = link.closest('.zm-item-comment');
      if (!parentRow) return;

      var label = link.textContent;
      link.textContent = '加载中…';

      try {
        var j = await fetchJSON('/api/v4/comments/' + cid + '/child_comments?order_by=time&limit=20&offset=' + coff);
        var kids = (j && j.data) || [];
        var total = (j && j.paging && j.paging.totals) || (coff + kids.length);

        var tmp = document.createElement('div');
        var khtml = '';
        for (var i = 0; i < kids.length; i++) khtml += commentRow(kids[i], true);
        tmp.innerHTML = khtml;
        fixImages(tmp);   // 先修图再搬节点，否则搬完 tmp 里已经没图了

        var rows = [].slice.call(tmp.children);
        var anchor = parentRow;
        var existing = parentRow.parentNode
          ? parentRow.parentNode.querySelectorAll('.zm-item-comment-reply[data-parent="' + cid + '"]')
          : [];
        for (var q = 0; q < existing.length; q++) anchor = existing[q];

        for (var r = 0; r < rows.length; r++) {
          rows[r].setAttribute('data-parent', cid);
          if (anchor.parentNode) anchor.parentNode.insertBefore(rows[r], anchor.nextSibling);
          anchor = rows[r];
        }

        var nextOff = coff + kids.length;
        link.dataset.loading = '';
        if (nextOff < total) {
          link.setAttribute('data-offset', nextOff);
          link.textContent = '展开更多回复（还有 ' + (total - nextOff) + ' 条）';
        } else {
          if (link.parentNode) link.parentNode.removeChild(link);
        }
      } catch (e) {
        link.dataset.loading = '';
        link.textContent = label + '（加载失败，点我重试）';
        console.warn('[zh-old] 回复加载失败', e);
      }
    }

    // ---------- 12. 灯箱 / 视频 ----------
    function lockScroll() {
      if (scrollLocks++ === 0) document.documentElement.classList.add('zh-lightbox-showing');
    }
    function unlockScroll() {
      if (scrollLocks > 0) scrollLocks--;
      if (scrollLocks === 0) document.documentElement.classList.remove('zh-lightbox-showing');
    }

    function ensureLightbox() {
      if (lbEl && document.body.contains(lbEl)) return lbEl;
      lbEl = document.createElement('div');
      lbEl.className = 'zh-lightbox';
      lbEl.innerHTML = '<img class="zh-lightbox-img" alt="">' +
        '<div class="zh-lightbox-hint">点击任意处或按 Esc 关闭 · 滚轮缩放</div>';
      document.body.appendChild(lbEl);
      lbEl.addEventListener('click', function () { closeLightbox(); });
      lbEl.addEventListener('wheel', function (e) {
        e.preventDefault();
        var s = parseFloat(lbEl.dataset.scale || '1');
        s = Math.min(5, Math.max(0.3, s + (e.deltaY < 0 ? 0.2 : -0.2)));
        lbEl.dataset.scale = s;
        var img = lbEl.querySelector('.zh-lightbox-img');
        if (img) img.style.transform = 'scale(' + s + ')';
      }, { passive: false });
      return lbEl;
    }

    function openLightboxByUrl(url) {
      if (!url) return;
      closeVideo();
      var box = ensureLightbox();
      var big = box.querySelector('.zh-lightbox-img');
      big.src = url;
      big.style.transform = 'scale(1)';
      box.dataset.scale = '1';
      box.style.display = 'flex';
      lockScroll();
    }

    function openLightbox(img) {
      openLightboxByUrl(img.getAttribute('data-zh-full') || img.getAttribute('src'));
    }

    function closeLightbox() {
      if (!lbEl || lbEl.style.display === 'none') return;
      lbEl.style.display = 'none';
      lbEl.querySelector('.zh-lightbox-img').removeAttribute('src');
      unlockScroll();
    }

    function openVideo(vid) {
      closeVideo();
      closeLightbox();
      var el = document.createElement('div');
      el.className = 'zh-video-overlay';
      el.innerHTML =
        '<div class="zh-video-box">' +
          '<button class="zh-video-close" type="button" title="关闭（Esc）">\u00d7</button>' +
          '<iframe title="知乎视频" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="no-referrer"></iframe>' +
          '<div class="zh-video-hint">点击空白处或按 Esc 关闭</div>' +
        '</div>';
      document.body.appendChild(el);
      var f = el.querySelector('iframe');
      if (f) f.src = 'https://video.zhihu.com/video/' + vid;
      videoEl = el;
      lockScroll();
      el.addEventListener('click', function (e) { if (e.target === el) closeVideo(); });
    }

    function closeVideo() {
      if (!videoEl) return;
      // 移除 iframe 可立即停止播放并释放播放器
      if (videoEl.parentNode) videoEl.parentNode.removeChild(videoEl);
      videoEl = null;
      unlockScroll();
    }

    // ---------- 13. 复制 ----------
    function legacyCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      var okFlag = false;
      try { okFlag = document.execCommand('copy'); } catch (e) {}
      if (ta.parentNode) ta.parentNode.removeChild(ta);
      if (!okFlag) throw new Error('copy failed');
      window.__zhLastCopied = text;
      return true;
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () {
          window.__zhLastCopied = text;
        }, function () {
          return legacyCopy(text);
        });
      }
      try { return Promise.resolve(legacyCopy(text)); }
      catch (e) { return Promise.reject(e); }
    }

    // ---------- 14. 事件 ----------
    async function onClick(ev) {
      var t = ev.target;
      if (!t || !t.closest) return;

      // 只在链接本体 / 围栏容器上认 .zh-exit：卡片链接里带着 ?zh_old=1，一旦命中就会被当成
      // "退出旧版"→ 去掉标记现刷 → 新文档又按"手动模式"启动 → 点卡片的用户每次都被弹回原页面
      if (t.closest('.zh-exit') && !t.closest('a[href]:not(.zh-exit)')) {
        ev.preventDefault(); exitOld(); return;
      }

      if (t.closest('.zh-video-close')) { ev.preventDefault(); closeVideo(); return; }

      var vcard = t.closest('.zh-video-card');
      if (vcard) {
        ev.preventDefault();
        var vid = vcard.getAttribute('data-vid');
        if (vid) openVideo(vid);
        return;
      }

      var zoomImg = t.closest('img[data-zh-zoomable]');
      if (zoomImg) { ev.preventDefault(); openLightbox(zoomImg); return; }

      // 左侧导航
      if (t.closest('.zh-nav')) {
        var navStep = t.closest('.zh-nav-step');
        if (navStep) { ev.preventDefault(); navGo(parseInt(navStep.getAttribute('data-dir'), 10) || 1); return; }
        var navSort = t.closest('.zh-nav-sort');
        if (navSort) { ev.preventDefault(); setSort(navSort.getAttribute('data-sort')); return; }
        if (t.closest('.zh-nav-more')) { ev.preventDefault(); loadMore('nav'); return; }
        if (t.closest('.zh-nav-top')) { ev.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
        return;
      }

      // 分享 = 复制链接
      var shareBtn = t.closest('.meta-share');
      if (shareBtn) {
        ev.preventDefault();
        var shareUrl = shareBtn.getAttribute('data-url') || location.href;
        var oldTxt = shareBtn.textContent;
        var flash = function (txt) {
          shareBtn.textContent = txt;
          shareBtn.setAttribute('data-copied', '1');
          setTimeout(function () {
            shareBtn.textContent = oldTxt;
            shareBtn.removeAttribute('data-copied');
          }, 1500);
        };
        try {
          copyText(shareUrl).then(function () { flash('已复制'); }, function () { flash('复制失败'); });
        } catch (e) {
          flash('复制失败');
        }
        return;
      }

      // 兜底：图片链接别把页面导航走
      var imgLink = t.closest('.zm-item-rich-text a, .zm-comment-box a');
      if (imgLink) {
        var ihref = imgLink.getAttribute('href') || '';
        if (/^https?:\/\/[^/]*zhimg\.com\/.*\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(ihref) ||
            /^https?:\/\/[^/]*zhimg\.com\/.*_(?:r|720w|1080w)\.(jpg|jpeg|png)/i.test(ihref)) {
          ev.preventDefault();
          openLightboxByUrl(ihref);
          return;
        }
      }

      // 排序
      var sortLink = t.closest('.answers-filter [data-sort]');
      if (sortLink) { ev.preventDefault(); setSort(sortLink.getAttribute('data-sort')); return; }

      // 展开/收起评论
      var toggle = t.closest('.toggle-comment');
      if (toggle) {
        ev.preventDefault();
        var aid = toggle.getAttribute('data-aid');
        var box = document.querySelector('.zm-comment-box[data-aid="' + aid + '"]');
        if (!box) return;

        if (box.style.display !== 'none') { box.style.display = 'none'; return; }
        box.style.display = 'block';

        if (!box.dataset.loaded && !box.dataset.loading) {
          box.dataset.loading = '1';
          var label = toggle.textContent;
          toggle.textContent = '加载中…';
          try {
            await loadComments(box, aid, 0);
            box.dataset.loaded = '1';
          } catch (e) {
            box.innerHTML = '<div class="cmt-empty">评论加载失败，收起后再点一次可重试</div>';
            console.warn('[zh-old] 评论加载失败', e);
          }
          delete box.dataset.loading;
          toggle.textContent = label;
        }
        return;
      }

      // 评论分页
      var moreLink = t.closest('.comment-more');
      if (moreLink) {
        ev.preventDefault();
        if (moreLink.dataset.loading) return;
        moreLink.dataset.loading = '1';

        var aid2 = moreLink.getAttribute('data-aid');
        var off = parseInt(moreLink.getAttribute('data-offset') || '0', 10) || 0;
        var box2 = document.querySelector('.zm-comment-box[data-aid="' + aid2 + '"]');
        if (!box2) return;

        moreLink.textContent = '加载中…';
        try {
          await loadComments(box2, aid2, off);
        } catch (e) {
          moreLink.textContent = '加载失败，点击重试';
          moreLink.dataset.loading = '';
          console.warn('[zh-old] 更多评论加载失败', e);
        }
        return;
      }

      // 楼中楼
      var expandLink = t.closest('.comment-expand');
      if (expandLink) {
        ev.preventDefault();
        await expandReplies(expandLink);
        return;
      }

      // 加载更多回答
      if (t.closest('.pager-more')) { ev.preventDefault(); loadMore('pager'); return; }

      // 回到顶部
      if (t.closest('.pager-top')) { ev.preventDefault(); window.scrollTo(0, 0); return; }
    }

    function bindEvents() {
      document.addEventListener('click', onClick);
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' && e.keyCode !== 27) return;
        if (videoEl) { closeVideo(); return; }
        if (lbEl && lbEl.style.display === 'flex') closeLightbox();
      });
    }

    // ---------- 15. 样式 ----------
    var extraCss = [
      'html,body{background:#fff}',
      '.zh-toast{position:fixed;left:50%;bottom:32px;z-index:2147483647;transform:translateX(-50%) translateY(8px);',
        'background:rgba(34,34,34,.92);color:#fff;font-size:13px;line-height:1.5;padding:9px 16px;border-radius:4px;',
        'max-width:80vw;text-align:center;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}',
      '.zh-toast-show{opacity:1;transform:translateX(-50%) translateY(0)}',
      '.zh-toast-err{background:rgba(190,60,50,.95)}',
      '.zh-question-head{border-bottom:1px solid #eee;margin:0 0 8px;padding:0 0 14px}',
      '.zu-main-content-inner{margin:0!important;box-sizing:border-box!important;width:100%!important}',
      '#zh-question-answer-wrap .zm-votebar{display:block!important}',
      '.zh-question-answer-wrapper{position:relative;border-top:2px solid #dcdcdc}',
      'body{overflow-x:hidden}',
      /* 旧版页头是从 /log 抓来的，自带 990px 固定宽度，必须压回自适应 */
      '.zu-top{min-width:0}',
      '.zu-top .zg-wrap,.zu-top .content{width:auto!important;max-width:960px!important;margin:0 auto!important;box-sizing:border-box!important}',
      /* 页脚同样是抓来的，.content.zg-wrap 也是 990px */
      '.zh-footer{overflow-x:hidden}',
      '.zh-footer .content,.zh-footer .zg-wrap{width:auto!important;max-width:960px!important;margin:0 auto!important;box-sizing:border-box!important}',
      '@media (min-width:901px){',
        '.zu-main.zg-wrap{width:960px!important;max-width:100%!important;margin:0 auto!important;padding:20px 0 50px;box-sizing:border-box}',
        '.zu-main-content{float:left;width:calc(100% - 306px);max-width:640px}',
        '.zu-main-sidebar{float:right;width:290px;display:block!important;position:sticky;top:66px}',
        '.zu-top .zg-wrap{width:960px!important;max-width:100%!important}',
      '}',
      '@media (max-width:900px){',
        '.zu-main.zg-wrap{width:auto!important;margin:0!important;padding:12px 14px 40px}',
        '.zu-main-content{float:none!important;width:auto!important}',
        '.zu-main-content-inner{width:auto!important}',
        '.zu-main-sidebar{display:none!important}',
        '.zu-top .zg-wrap{width:auto!important}',
      '}',
      '.zu-question-big-title{font-size:18px;font-weight:700;margin:0 0 14px;line-height:1.5;color:#222}',
      '.answers-filter{font-size:13px;color:#999;overflow:hidden}',
      '.answers-filter .answers-count{float:left}',
      '.answers-filter .answers-count b{color:#222;font-weight:700}',
      '.answers-filter .sort{float:right}',
      '.answers-filter .sort a{color:#8590a6;margin-left:14px;text-decoration:none;cursor:pointer}',
      '.answers-filter .sort a.on{color:#222;font-weight:700}',
      '.answers-warn{margin-top:8px;font-size:12px;color:#c0622a}',
      '.zm-item-answer{padding:18px 0 14px;margin-left:48px}',
      '#zh-question-answer-wrap .zm-item-answer{border-top:0!important}',
      '#zh-question-answer-wrap .zh-question-answer-wrapper:first-child{border-top:0!important}',
      '.zm-item-rich-text{margin-top:8px;color:#222;font-size:14px;line-height:1.7;overflow-wrap:break-word;word-break:break-word}',
      '.zm-item-rich-text p{margin:12px 0}',
      '.zm-item-rich-text figure{margin:14px 0}',
      '.zm-item-rich-text img{max-width:100%;height:auto;display:block}',
      '.zm-item-answer-author-info{position:relative;overflow:hidden}',
      '.zm-item-answer-author-info .bio{display:inline;margin-left:8px}',
      '.zm-item-answer .zm-item-link-avatar{float:left;margin:3px 8px 0 0;height:25px;width:25px}',
      '.zm-item-answer .zm-item-img-avatar{width:25px;height:25px;border-radius:2px}',
      '.zm-item-answer-author-info .author-link{display:inline-block;line-height:25px}',
      '.zm-votebar .vote-arrow{width:0;height:0;border:6px solid transparent;font-size:0;line-height:0;display:block}',
      '.zm-votebar .up .vote-arrow{border-bottom-color:#698ebf;border-top-width:0}',
      '.zm-votebar .down .vote-arrow{border-top-color:#698ebf;border-bottom-width:0}',
      '.zm-votebar .up,.zm-votebar .down{height:auto!important;padding:7px 0!important;line-height:1!important;text-align:center;box-sizing:border-box;text-decoration:none}',
      '.zm-votebar .up .vote-arrow,.zm-votebar .down .vote-arrow{position:static!important;left:auto!important;margin:0 auto 4px auto!important}',
      '.zm-votebar .count{display:block;font-size:12px;line-height:16px;margin-top:2px}',
      '.zm-item-meta{margin:16px 0 0;font-size:13px;color:#999;text-align:right;line-height:24px}',
      '.zm-item-meta:after{content:"";display:table;clear:both}',
      '.zm-item-meta a,.zm-item-meta span.meta-item{display:inline-block;color:#999;text-decoration:none;margin-left:18px;cursor:pointer;vertical-align:middle}',
      '.zm-item-meta a:hover{color:#698ebf}',
      '.zm-item-meta .icon{margin-right:3px}',
      '.zm-comment-box{margin:10px 0 0!important;max-width:100%!important;background:#fff;border:1px solid #ddd;border-radius:3px}',
      '.zm-item-comment .zm-item-img-avatar{width:24px;height:24px;border-radius:2px}',
      '.comment-more{display:block;padding:10px 12px;text-align:center;color:#698ebf;font-size:13px;cursor:pointer;border-top:1px solid #eee}',
      '.comment-more:hover{background:#fafafa}',
      '.comment-expand{display:inline-block;margin:6px 0 0;font-size:12px;color:#698ebf;cursor:pointer}',
      '.comment-expand:hover{text-decoration:underline}',
      '.reply-prefix{color:#8590a6}',
      '.reply-prefix .mention{color:#698ebf;text-decoration:none}',
      '.reply-prefix .mention:hover{text-decoration:underline}',
      '.zm-item-comment-reply{background:#f7f9fb;border-left:2px solid #dfe5ec;margin-left:0;padding-left:0}',
      '.zm-item-comment .zm-comment-content-wrap{margin-left:0!important}',
      '.zm-item-comment-reply .reply-prefix{color:#8590a6}',
      '.zm-item-comment-reply .reply-prefix .mention{color:#2c6ca3;font-weight:600}',
      '.cmt-empty{padding:12px;color:#999;font-size:13px}',
      '.zm-side-section{background:#fff;border:1px solid #ddd;border-radius:3px;padding:12px 14px;margin-bottom:12px;font-size:13px;color:#555}',
      '.zm-side-section h3{font-size:14px;margin:0 0 8px;color:#222}',
      '.zm-side-section .side-row{color:#8590a6;margin:4px 0}',
      '.zh-pager{text-align:center;padding:24px 0 8px}',
      '.zh-empty{padding:56px 0;text-align:center;color:#999;font-size:14px}',
      '.zh-pager a{display:inline-block;padding:4px 12px;margin:0 4px;border:1px solid #ddd;border-radius:3px;color:#698ebf;text-decoration:none;background:#fff;font-size:13px;cursor:pointer}',
      '.zh-pager a:hover{border-color:#698ebf}',
      '.zh-pager a:focus-visible,.zh-nav a:focus-visible{outline:2px solid #0e6eb8;outline-offset:2px}',
      'html.zh-lightbox-showing{overflow:hidden}',
      '.zh-lightbox{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;cursor:zoom-out}',
      '.zh-lightbox-img{max-width:94vw;max-height:92vh;box-shadow:0 0 40px rgba(0,0,0,.6);transition:transform .12s ease;cursor:zoom-out;background:#111}',
      '.zh-lightbox-hint{position:absolute;bottom:18px;left:0;right:0;text-align:center;color:#bbb;font-size:12px;pointer-events:none}',
      'img[data-zh-zoomable]{cursor:zoom-in}',
      '.zm-item-rich-text figcaption{font-size:12px;color:#999;text-align:center;margin-top:6px}',
      '.zm-item-rich-text .video-box{display:block;padding:10px 36px 10px 12px;border:1px solid #ddd;border-radius:3px;background:#fafafa;color:#698ebf;text-decoration:none;margin:14px 0;font-size:13px}',
      '.zm-item-rich-text .video-box:hover{border-color:#698ebf}',
      '.author-link:hover,.zm-item-rich-text a:hover{color:#698ebf}',
      '.zm-item-rich-text a{color:#175199;text-decoration:none}',
      '.zm-item-rich-text a:hover{text-decoration:underline}',
      '.zm-item-rich-text h2{font-size:16px;font-weight:700;margin:18px 0 10px;line-height:1.5}',
      '.zm-item-rich-text ul,.zm-item-rich-text ol{padding-left:24px;margin:12px 0}',
      '.zm-item-rich-text li{margin:4px 0}',
      '.zm-item-rich-text blockquote{border-left:3px solid #ddd;padding:2px 0 2px 14px;color:#666;margin:14px 0}',
      '.zm-item-rich-text code{background:#f2f2f2;border-radius:3px;padding:2px 5px;font-family:Consolas,Menlo,monospace;font-size:13px;word-break:break-word}',
      '.zm-item-rich-text pre{background:#f7f7f7;border:1px solid #eee;border-radius:3px;padding:12px;margin:14px 0;overflow-x:auto;max-width:100%}',
      '.zm-item-rich-text pre code{background:none;border:0;padding:0;word-break:normal;white-space:pre}',
      '.zm-item-rich-text table{border-collapse:collapse;margin:14px 0;display:table;max-width:100%;table-layout:auto}',
      '.zm-item-rich-text table th,.zm-item-rich-text table td{border:1px solid #ddd;padding:5px 10px;font-size:13px}',
      '.zm-item-rich-text table th{background:#f7f7f7;font-weight:700}',
      '.zh-nav{font-size:12px;color:#666;line-height:1.6;font-family:inherit;margin-top:12px}',
      '.zh-nav-inner{box-sizing:border-box;width:100%;background:#fff;border:1px solid #e6e6e6;border-radius:4px;padding:10px 12px;box-shadow:0 1px 4px rgba(0,0,0,.04)}',
      '.zh-nav-hd{color:#999;margin-bottom:8px}',
      '.zh-progress{height:4px;background:#eee;border-radius:2px;overflow:hidden;margin:0 0 8px}',
      '.zh-progress-bar{height:100%;width:100%;background:#0e6eb8;transform:scaleX(0);transform-origin:0 50%}',
      '@supports (animation-timeline: scroll()){.zh-progress-bar{animation:zhBarX linear;animation-timeline:scroll(root block)}}',
      '@keyframes zhBarX{from{transform:scaleX(0)}to{transform:scaleX(1)}}',
      '.zh-nav-pos{color:#444;font-weight:700;text-align:center;margin:2px 0 8px;font-size:13px}',
      '.zh-nav-btn{display:block;box-sizing:border-box;margin:6px 0;padding:9px 10px;border:1px solid #e3e8ee;border-radius:3px;background:#fbfcfd;color:#5a7ea8;text-align:center;font-size:12px;line-height:1.4;text-decoration:none;cursor:pointer;white-space:nowrap;user-select:none}',
      '.zh-nav-btn:hover{background:#f1f6fc;border-color:#c9d8e8;color:#0e6eb8}',
      '.zh-nav-btn:active{background:#e6f0fa}',
      '.zh-nav-btn.on{background:#0e6eb8;border-color:#0e6eb8;color:#fff;font-weight:700}',
      '.zh-nav-btn:focus-visible{outline:2px solid #0e6eb8;outline-offset:2px}',
      '.zm-item-rich-text a.zh-video-card{display:block;position:relative;margin:14px 0;padding:9px 12px 9px 40px;border:1px solid #e6e6e6;border-radius:4px;background:#fafafa;color:#0e6eb8;text-decoration:none;line-height:1.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.zm-item-rich-text a.zh-video-card:hover{border-color:#0e6eb8;background:#f4f9ff}',
      '.zm-item-rich-text a.zh-video-card:before{content:"\u25b6";position:absolute;left:12px;top:50%;transform:translateY(-50%);width:20px;height:20px;line-height:20px;text-align:center;border-radius:50%;background:#0e6eb8;color:#fff;font-size:10px}',
      '.zh-video-overlay{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center}',
      '.zh-video-box{position:relative;width:min(960px,92vw);aspect-ratio:16/9;background:#000;box-shadow:0 0 40px rgba(0,0,0,.6)}',
      '.zh-video-box iframe{width:100%;height:100%;border:0;display:block;background:#000}',
      '.zh-video-close{position:absolute;right:-13px;top:-13px;width:30px;height:30px;border-radius:50%;background:#fff;color:#333;border:0;font-size:18px;line-height:30px;text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);padding:0}',
      '.zh-video-close:hover{background:#0e6eb8;color:#fff}',
      '.zh-video-hint{position:absolute;left:0;right:0;bottom:-26px;text-align:center;color:#bbb;font-size:12px}'
    ].join('');

    // 主站 CSS 加载失败时补一份结构样式
    function ensureBaseCss() {
      var link = document.querySelector('link[data-zh-css]');
      if (!link) return;
      var injected = false;
      var inject = function () {
        if (injected || document.getElementById('zh-base-css')) return;
        injected = true;
        var st = document.createElement('style');
        st.id = 'zh-base-css';
        st.textContent = BASE_CSS;
        (document.head || document.documentElement).appendChild(st);
      };
      link.addEventListener('error', inject);
      setTimeout(function () {
        try { if (link.sheet === null) inject(); } catch (e) {}
      }, 3000);
    }

    // ---------- 16. 页面骨架 ----------
    var page =
      '<!DOCTYPE html><html lang="zh-CN" class="no-touchevents"><head>' +
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="color-scheme" content="light">' +
      '<title>' + esc(pageTitle) + '</title>' +
      '<link rel="stylesheet" href="' + esc(cssUrl) + '" data-zh-css>' +
      '<style>' + extraCss + '</style></head>' +
      '<body class="zhi">' +
        shell.top +
        '<div class="zg-wrap zu-main clearfix">' +
          '<div class="zu-main-content"><div class="zu-main-content-inner">' +
            '<div class="zh-question-head">' +
              '<h1 class="zu-question-big-title">' + esc(pageTitle) + '</h1>' +
              '<div class="answers-filter">' +
                '<span class="answers-count"><b class="zh-total">' + totalAnswers + '</b> 个回答</span>' +
                '<span class="sort"><a class="on" data-sort="quality" role="button" aria-current="true">按质量排序</a><a data-sort="time" role="button">按时间排序</a></span>' +
              '</div>' +
            '</div>' +
            '<div id="zh-question-answer-wrap">' + loadedAnswers.map(makeAnswerHtml).join('') + '</div>' +
            (loadedAnswers.length
              ? '<div class="zh-pager">' +
                  '<a class="pager-more" role="button">加载更多回答</a>' +
                  '<a class="pager-top" role="button">回到顶部</a>' +
                '</div>'
              : '<div class="zh-empty">这个问题还没有回答</div>') +
          '</div></div>' +
          '<div class="zu-main-sidebar">' +
            '<div class="zm-side-section">' +
              '<h3>关于本问题</h3>' +
              '<div class="side-row">回答数 <span class="zh-total">' + totalAnswers + '</span></div>' +
              '<div class="side-row">已加载 <span class="zh-loaded">' + loadedAnswers.length + '</span> 条</div>' +
              '<div class="side-row"><a class="zh-exit" href="#">退出旧版（看原页面）</a></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        shell.footer +
      '</body></html>';

    // ---------- 17. 替换整页 ----------
    var preservedStyles = [];
    try {
      var allStyles = document.querySelectorAll('style');
      for (var si = 0; si < allStyles.length; si++) {
        var st = allStyles[si];
        var stTxt = st.textContent || '';
        if (!stTxt) continue;
        var isExt = (st.id === 'Force_Custom_Fonts') ||
                    (st.parentNode === document.documentElement && /font-family/i.test(stTxt));
        if (isExt) preservedStyles.push({ id: st.id || '', css: stTxt });
      }
    } catch (e) {}

    if (location.pathname !== startPath) return false;   // 转换期间用户已经跳走，别把新页面覆盖掉

    try {
      document.open();
      document.write(page);
      document.close();
    } catch (e) {
      document.title = pageTitle;
      toast('页面重建失败，请刷新后重试', true);
      console.error('[zh-old] document.write 失败', e);
      return;
    }

    // 新文档里这些引用都失效了
    lbEl = null;
    videoEl = null;
    scrollLocks = 0;
    navEl = null;
    navIO = null;

    // 扩展注入的字体样式补回去
    for (var pi = preservedStyles.length - 1; pi >= 0; pi--) {
      try {
        var ns2 = document.createElement('style');
        if (preservedStyles[pi].id) ns2.id = preservedStyles[pi].id;
        ns2.setAttribute('type', 'text/css');
        ns2.textContent = preservedStyles[pi].css;
        var headEl = document.head || document.documentElement;
        headEl.insertBefore(ns2, headEl.firstChild);
      } catch (e) {}
    }

    fixImages(document);
    buildNav();
    observeAnswers();
    sortAnswers();
    ensureBaseCss();
    bindEvents();
    if (reachedEnd) updateMoreButtons('end');

    // 评论数不挡首屏：页面上先显示“查看评论”，数字回来了再补
    fillCommentCounts(qid, 0, loadedAnswers.length).then(function (counts) {
      for (var i = 0; i < loadedAnswers.length; i++) {
        var key = String(loadedAnswers[i].id);
        if (loadedAnswers[i].comment_count == null && counts[key] != null) loadedAnswers[i].comment_count = counts[key];
      }
    }, function () {});

    // 从 /answer/<id> 永久链接进来时定位到那条回答
    var wantAid = (location.pathname.match(/\/answer\/(\d+)/) || [])[1];
    if (wantAid) {
      var target = document.getElementById('answer-' + wantAid);
      if (target) {
        var ty = target.getBoundingClientRect().top + window.scrollY - 8;
        window.scrollTo(0, Math.max(0, ty));
      }
    }
    return true;
  }

  // ==================== 入口 ====================

  function routeKind() {
    var p = location.pathname;
    if (p === '/' || p === '/index') return 'home';
    if (/^\/question\/\d+(?:\/answer\/\d+)?\/?$/.test(p)) return 'question';
    return '';
  }

  // 退出旧版：问题页加 zh_raw=1 整页重载（完全不接管）；主页去掉 zh_old=1 再刷新
  function exitOld() {
    if (routeKind() === 'question') {
      location.replace(urlWithRaw(true));
      return;
    }
    var parts = location.search.replace(/^\?/, '').split('&').filter(function (s) {
      return s && s !== 'zh_old=1' && s.indexOf('zh_old=') !== 0;
    });
    var rest = parts.length ? '?' + parts.join('&') : '';
    var hash = location.hash || '';
    // 只看路径：主页 URL 去掉 zh_old 后与当前完全一致时 replace() 不会产生新导航，
    // 部分管理器会因此什么都不发生（点了没反应）。这时改成 reload 强制拿一次原版文档。
    if (location.pathname === '/' && !rest && !hash) {
      try {
        location.reload();
        return;
      } catch (e) {}
    }
    var url = location.pathname + rest + hash;
    try { location.replace(url); } catch (e) { try { location.href = url; } catch (e2) {} }
  }

  // ==================== 主页旧版 ====================

  var HOME_CSS = [
    'body.zh-home{margin:0;background:#f6f6f6;color:#222;font:14px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
    'a{color:#175199;text-decoration:none}',
    '.zh-home-top{background:#fff;border-bottom:1px solid #e5e5e5}',
    '.zh-home-top .inner{max-width:960px;margin:0 auto;display:flex;align-items:center;gap:22px;height:52px;padding:0 16px;box-sizing:border-box}',
    '.zh-home-logo{font-size:20px;font-weight:700;color:#0e6eb8}',
    '.zh-home-nav a{color:#666;margin-right:16px;font-size:14px}',
    '.zh-home-nav a.on{color:#222;font-weight:700}',
    '.zh-home-top .right{margin-left:auto;font-size:13px}',
    '.zh-home-wrap{max-width:960px;margin:16px auto 48px;display:flex;gap:16px;padding:0 16px;align-items:flex-start;box-sizing:border-box}',
    '.zh-home-main{flex:1;min-width:0}',
    '.zh-home-side{width:290px;flex:none}',
    '.zh-feed{background:#fff;border:1px solid #e5e5e5;border-radius:3px}',
    '.zh-feed-item{padding:16px 18px;border-bottom:1px solid #f0f0f0}',
    '.zh-feed-item:last-child{border-bottom:0}',
    '.zh-feed-title{display:block;font-size:16px;font-weight:700;line-height:1.5;color:#222;margin-bottom:8px}',
    '.zh-feed-title:hover{color:#0e6eb8}',
    '.zh-feed-body{display:flex;gap:12px;align-items:flex-start}',
    '.zh-feed-excerpt{margin:0;flex:1;color:#555;font-size:13px;line-height:1.7;max-height:4.9em;overflow:hidden}',
    '.zh-feed-thumb{width:110px;height:74px;object-fit:cover;border-radius:2px;flex:none;background:#eee}',
    '.zh-feed-meta{margin-top:10px;color:#999;font-size:12px}',
    '.zh-feed-meta .type{color:#698ebf;margin-left:4px}',
    '.zh-home-more{text-align:center;padding:16px 0}',
    '.zh-home-more a{display:inline-block;padding:6px 18px;border:1px solid #ddd;border-radius:3px;background:#fff;color:#698ebf;cursor:pointer;font-size:13px}',
    '.zh-home-more a:hover{border-color:#698ebf}',
    '.zh-side-section{background:#fff;border:1px solid #e5e5e5;border-radius:3px;padding:12px 14px;font-size:13px;color:#555;margin-bottom:12px}',
    '.zh-side-section h3{margin:0 0 8px;font-size:14px;color:#222}',
    '.zh-side-section .row{color:#8590a6;margin:4px 0}',
    '.zh-side-section .row b{color:#222}',
    '.zh-hot-list{list-style:none;margin:0;padding:0}',
    '.zh-hot-list li{display:flex;gap:8px;align-items:baseline;padding:5px 0;border-bottom:1px dashed #f0f0f0;line-height:1.5}',
    '.zh-hot-list li:last-child{border-bottom:0}',
    '.zh-hot-list .rank{flex:none;width:16px;color:#999;font-weight:700;font-size:12px}',
    '.zh-hot-list li:nth-child(1) .rank{color:#c00}',
    '.zh-hot-list li:nth-child(2) .rank{color:#e07b00}',
    '.zh-hot-list li:nth-child(3) .rank{color:#c9a227}',
    '.zh-hot-list a{flex:1;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.zh-hot-list a:hover{color:#0e6eb8}',
    '.zh-hot-list .hot{flex:none;color:#bbb;font-size:12px}',
    '@media (max-width:900px){.zh-home-side{display:none}.zh-home-wrap{padding:0 10px}.zh-feed-thumb{width:84px;height:56px}}'
  ].join('');

  var homePageNo = 0, homeLoading = false, homeDone = false;

  function stripTags(html) {
    var s = String(html == null ? '' : html);
    if (!s) return '';
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    s = s.replace(/<[^>]*>/g, ' ');
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
         .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
    return s.replace(/\s+/g, ' ').trim();
  }

  function firstImage(html) {
    var m = String(html == null ? '' : html).match(/<img[^>]+src=["']([^"']+)["']/i);
    if (!m) return '';
    return absUrl(m[1]) || '';
  }

  function clip(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // 旧版主页点出去的链接带上标记，目标页据此自动进入旧版（其它入口一律手动）
  function autoLink(url) {
    if (!url) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'zh_old=1';
  }

  function typeLabel(t) {
    return { answer: '回答', article: '文章', question: '问题', pin: '想法', zvideo: '视频' }[t] || '';
  }

  // 卡片链接可能是 //www.zhihu.com/question/1/answer/2，只保留站内路径
  function normalizeHref(href) {
    if (!href) return '';
    try {
      var u = new URL(href, location.origin);
      if (!/(^|\.)zhihu\.com$/.test(u.hostname)) return '';
      return u.pathname + u.search;
    } catch (e) { return ''; }
  }

  function thumbFrom(e) {
    var t = e.thumbnails;
    if (t && t.length) {
      var x = t[0];
      return absUrl(x && (x.url || x.thumbnail) ? (x.url || x.thumbnail) : x) || '';
    }
    return '';
  }

  function entityOf(entities, type, id) {
    type = String(type || '').toLowerCase();
    var bucket = entities[type + 's'] || entities[type];
    if (!bucket) return null;
    return bucket[id] || bucket[String(id)] || null;
  }

  function normEntity(type, e, fallbackId) {
    if (!e) return null;
    type = String(type || e.type || '').toLowerCase();
    if (type === 'feed') type = String(e.type || '').toLowerCase();
    var id = e.id || fallbackId || e.token;
    if (!id) return null;

    var author = e.author || e.creator || e.member || {};
    if (typeof author === 'string') author = { name: author };
    var raw = e.excerpt_new || e.excerpt || e.content || e.detail || e.excerpt_title || '';
    var content = e.content || '';

    var item = {
      type: type,
      id: String(id),
      author: author.name || '',
      votes: Number(e.voteup_count || e.answer_count || 0),
      comments: Number(e.comment_count || 0),
      time: Number(e.updated_time || e.created_time || e.created || 0),
      img: thumbFrom(e) || firstImage(content) || firstImage(raw),
      title: '',
      excerpt: '',
      url: ''
    };

    if (type === 'answer') {
      var q = e.question || {};
      item.title = stripTags(q.title || e.question_title || '');
      item.excerpt = clip(stripTags(raw), 220);
      var qid = q.id || e.question_id || '';
      item.url = qid ? ('/question/' + qid + '/answer/' + id) : ('/answer/' + id);
    } else if (type === 'article') {
      item.title = stripTags(e.title || '');
      item.excerpt = clip(stripTags(raw), 220);
      item.url = '/p/' + id;
    } else if (type === 'question') {
      item.title = stripTags(e.title || '');
      item.excerpt = clip(stripTags(raw), 220);
      item.url = '/question/' + id;
    } else if (type === 'pin') {
      item.title = clip(stripTags(e.excerpt_title || e.title || ''), 60) || '想法';
      item.excerpt = clip(stripTags(raw), 220);
      item.url = '/pin/' + id;
    } else {
      return null;
    }

    if (!item.title) item.title = item.excerpt ? clip(item.excerpt, 40) : '';
    if (!item.title) return null;
    return item;
  }

  // 首屏数据兜底一：页面内嵌的 initialState（新版首页通常没有 feed）
  function fromInitial() {
    var el = document.getElementById('js-initialData');
    if (!el) return [];
    var raw = el.textContent || el.innerHTML || '';
    if (!raw || raw.length < 2) return [];

    var data;
    try { data = JSON.parse(raw); } catch (e) { return []; }

    var st = (data && data.initialState) || data || {};
    var entities = st.entities || {};
    var list = (st.feed && (st.feed.list || st.feed.items)) || st.feedList ||
               (st.topstory && st.topstory.list) || [];
    if (!list || !list.length) return [];

    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i], n = null;
      if (typeof it === 'string') {
        var m = it.match(/^([a-z]+):(\d+)$/i);
        if (m && m[1].toLowerCase() !== 'ad') n = normEntity(m[1], entityOf(entities, m[1], m[2]), m[2]);
      } else if (it && typeof it === 'object') {
        var t = it.target || it;
        if (t && t.type && t.id) n = normEntity(t.type, t, t.id);
        else if (it.type && it.id) n = normEntity(it.type, entityOf(entities, it.type, it.id), it.id);
      }
      if (n) out.push(n);
    }
    return out;
  }

  // 首屏数据兜底二：直接读已经渲染出来的信息流卡片（真实结构见 2026-11 线上验证）
  function fromDom() {
    var nodes = document.querySelectorAll('.TopstoryItem');
    var out = [];
    for (var i = 0; i < nodes.length && out.length < 30; i++) {
      var node = nodes[i];
      if (!node.querySelector) continue;

      var zop = {};
      var zopEl = node.querySelector('[data-zop]');
      if (zopEl) {
        try { zop = JSON.parse(zopEl.getAttribute('data-zop') || '{}'); } catch (e) { zop = {}; }
      }

      var linkEl = node.querySelector('.ContentItem-title a[href]') || node.querySelector('h2 a[href]');
      var href = normalizeHref(linkEl ? linkEl.getAttribute('href') : '');
      if (!href) continue;

      var type = String(zop.type || '').toLowerCase();
      if (!type) type = /^\/question\//.test(href) ? 'answer' : (/^\/p\//.test(href) ? 'article' : '');

      var titleEl = node.querySelector('.ContentItem-title') || node.querySelector('h2');
      var title = stripTags(titleEl ? titleEl.textContent : '');
      if (!title) continue;

      var excerptEl = node.querySelector('.RichText');
      var voteEl = node.querySelector('meta[itemprop="upvoteCount"]');
      var cmtEl = node.querySelector('meta[itemprop="commentCount"]');
      var imgEl = node.querySelector('meta[itemprop="image"]');

      out.push({
        type: type === 'article' ? 'article' : 'answer',
        id: href,
        title: clip(title, 90),
        excerpt: clip(stripTags(excerptEl ? excerptEl.textContent : ''), 220),
        author: zop.authorName || '',
        votes: Number(voteEl ? voteEl.getAttribute('content') : 0) || 0,
        comments: Number(cmtEl ? cmtEl.getAttribute('content') : 0) || 0,
        time: 0,
        img: imgEl ? (absUrl(imgEl.getAttribute('content')) || '') : '',
        url: href
      });
    }
    return out;
  }

  function collectHomeItems() {
    var items = fromInitial();
    if (items.length < 3) items = items.concat(fromDom());
    var seen = {}, out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.url || !it.title || seen[it.url]) continue;
      seen[it.url] = 1;
      out.push(it);
    }
    return out;
  }

  function homeCard(it) {
    var thumb = it.img
      ? '<img class="zh-feed-thumb" src="' + esc(it.img) + '" alt="" loading="lazy" decoding="async">'
      : '';
    var meta = [];
    if (it.author) meta.push(esc(it.author));
    if (it.type === 'question') meta.push(esc(it.votes) + ' 个回答');
    else meta.push(votesFmt(it.votes) + ' 赞同');
    if (it.comments) meta.push(votesFmt(it.comments) + ' 评论');
    meta.push('<span class="type">' + typeLabel(it.type) + '</span>');

    return '<div class="zh-feed-item">' +
      '<a class="zh-feed-title" href="' + esc(autoLink(it.url)) + '">' + esc(it.title) + '</a>' +
      '<div class="zh-feed-body"><p class="zh-feed-excerpt">' + esc(it.excerpt) + '</p>' + thumb + '</div>' +
      '<div class="zh-feed-meta">' + meta.join(' · ') + '</div>' +
    '</div>';
  }

  function hotHtml(list) {
    if (!list.length) return '';
    var li = '';
    for (var i = 0; i < list.length; i++) {
      li += '<li><span class="rank">' + (i + 1) + '</span>' +
        '<a href="' + esc(autoLink(list[i].url)) + '" title="' + esc(list[i].title) + '">' + esc(clip(list[i].title, 34)) + '</a>' +
        '<span class="hot">' + esc(list[i].hot || (list[i].answers + ' 回答')) + '</span></li>';
    }
    return '<div class="zh-side-section"><h3>热榜</h3><ol class="zh-hot-list">' + li + '</ol></div>';
  }

  function homeHtml(items, hot) {
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="color-scheme" content="light">' +
      '<title>首页 - 知乎旧版</title><style>' + HOME_CSS + '</style></head>' +
      '<body class="zh-home">' +
        '<header class="zh-home-top"><div class="inner">' +
          '<a class="zh-home-logo" href="/">知乎</a>' +
          '<nav class="zh-home-nav"><a class="on" href="/">首页</a></nav>' +
          '<div class="right"><a class="zh-exit" href="#">退出旧版</a></div>' +
        '</div></header>' +
        '<div class="zh-home-wrap">' +
          '<div class="zh-home-main">' +
            '<div class="zh-feed" id="zh-home-feed">' + items.map(homeCard).join('') + '</div>' +
            '<div class="zh-home-more"><a id="zh-home-more" role="button">加载更多</a></div>' +
          '</div>' +
          '<aside class="zh-home-side">' + hot +
            '<div class="zh-side-section"><h3>说明</h3>' +
              '<div class="row">当前 <b id="zh-home-count">' + items.length + '</b> 条 · 点标题进旧版回答页</div>' +
              '<div class="row"><a href="/">打开原版首页</a></div>' +
              '<div class="row"><a class="zh-exit" href="#">退出旧版</a></div>' +
            '</div>' +
          '</aside>' +
        '</div>' +
      '</body></html>';
  }

  async function fetchFeedPage(pageNo) {
    var j = await fetchJSON(
      '/api/v3/feed/topstory/recommend?action=down&desktop=true&ad_interval=3&page_number=' + pageNo,
      { 'x-requested-with': 'fetch' }
    );
    var raw = (j && j.data) || [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var t = raw[i] && (raw[i].target || raw[i]);
      if (!t || !t.type) continue;
      var n = normEntity(t.type, t, t.id);
      if (n) out.push(n);
    }
    return out;
  }

  async function fetchHotList(limit) {
    try {
      var j = await fetchJSON('/api/v3/feed/topstory/hot-lists/total?limit=' + limit, { 'x-requested-with': 'fetch' });
      var raw = (j && j.data) || [];
      var out = [];
      for (var i = 0; i < raw.length && out.length < limit; i++) {
        var t = raw[i] && raw[i].target;
        if (!t || !t.id) continue;
        out.push({
          url: '/question/' + t.id,
          title: t.title || '',
          hot: raw[i].detail_text || '',
          answers: Number(t.answer_count) || 0
        });
      }
      return out;
    } catch (e) { return []; }
  }

  async function zhOldHome() {
    var startPath = location.pathname;

    // 先用接口拿两页（每页 6 条），拿不到再退回 initialData / DOM
    var items = [];
    try {
      var pages = await Promise.all([fetchFeedPage(1), fetchFeedPage(2)]);
      items = pages[0].concat(pages[1] || []);
    } catch (e) {
      console.warn('[zh-old] 推荐流接口失败，退回页面解析', e);
    }
    if (items.length < 3) items = collectHomeItems();

    // 首屏可能还没渲染完，给 2 秒
    for (var i = 0; i < 8 && items.length < 3; i++) {
      await new Promise(function (r) { setTimeout(r, 250); });
      if (location.pathname !== startPath) return false;
      items = collectHomeItems();
    }
    if (items.length < 3) return false;

    var seen = {}, uniq = [];
    for (var k = 0; k < items.length; k++) {
      if (!items[k] || seen[items[k].url]) continue;
      seen[items[k].url] = 1;
      uniq.push(items[k]);
    }
    items = uniq;

    var hot = await fetchHotList(15);
    if (location.pathname !== startPath) return false;

    var page = homeHtml(items, hotHtml(hot));
    try {
      document.open();
      document.write(page);
      document.close();
    } catch (e) {
      console.error('[zh-old] 主页重建失败', e);
      return false;
    }

    homePageNo = 2;
    homeDone = false;
    bindHome();
    return true;
  }

  async function loadHomeMore(link) {
    if (homeLoading || homeDone) return;
    homeLoading = true;
    var old = link.textContent;
    link.textContent = '加载中…';
    link.style.pointerEvents = 'none';
    try {
      var items = await fetchFeedPage(homePageNo + 1);
      var feed = document.getElementById('zh-home-feed');
      if (!items.length) {
        homeDone = true;
        if (link.parentNode) link.parentNode.style.display = 'none';
        return;
      }
      homePageNo++;

      var exist = {};
      var oldNodes = feed ? feed.querySelectorAll('.zh-feed-title') : [];
      for (var i = 0; i < oldNodes.length; i++) exist[oldNodes[i].getAttribute('href')] = 1;
      var fresh = [];
      for (var j = 0; j < items.length; j++) {
        if (!exist[items[j].url]) fresh.push(items[j]);
      }
      if (!fresh.length) {
        homeDone = true;
        if (link.parentNode) link.parentNode.style.display = 'none';
        return;
      }
      if (feed) feed.insertAdjacentHTML('beforeend', fresh.map(homeCard).join(''));
      var cnt = document.getElementById('zh-home-count');
      if (cnt && feed) cnt.textContent = String(feed.querySelectorAll('.zh-feed-item').length);
      link.textContent = old;
      link.style.pointerEvents = '';
    } catch (e) {
      console.warn('[zh-old] 主页加载更多失败', e);
      homeDone = true;
      link.setAttribute('data-failed', '1');
      link.setAttribute('href', '/?zh_old=0');
      link.textContent = '加载失败，去原版继续看';
      link.style.pointerEvents = '';
    } finally {
      homeLoading = false;
    }
  }

  function bindHome() {
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      // 同 onClick：别让卡片链接（带 ?zh_old=1）被认成退出入口
      if (t.closest('.zh-exit') && !t.closest('a[href]:not(.zh-exit)')) { ev.preventDefault(); exitOld(); return; }
      var more = t.closest('#zh-home-more');
      if (more && !more.hasAttribute('data-failed')) { ev.preventDefault(); loadHomeMore(more); }
    });
  }

  // ==================== 悬浮入口 ====================

  var btn = null, btnHandler = null, busy = false, converted = false, badge = null;

  function ensureBtn(text, handler) {
    if (!btn) {
      btn = document.createElement('div');
      btn.setAttribute('role', 'button');
      btn.setAttribute('tabindex', '0');
      btn.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483645;' +
        'padding:9px 16px;background:#0e6eb8;color:#fff;font-size:13px;' +
        'border-radius:3px;cursor:pointer;opacity:.94;user-select:none;' +
        'font-family:-apple-system,"PingFang SC",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.22);';
      btn.addEventListener('click', function () { if (btnHandler) btnHandler(); });
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32) {
          e.preventDefault();
          if (btnHandler) btnHandler();
        }
      });
    }
    btn.textContent = text || '旧版阅读';
    btnHandler = handler || null;
    return btn;
  }

  function showBtn(text, handler) {
    if (!document.body) return;
    var b = ensureBtn(text, handler);
    b.style.display = '';
    // body 可能被 document.write/SPA 换掉：以当前 body 为准重新挂
    if (b.parentNode !== document.body) document.body.appendChild(b);
  }

  function hideBtn() {
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
  }

  function busyBadge(on) {
    if (on) {
      if (!badge) {
        badge = document.createElement('div');
        badge.textContent = '旧版阅读加载中…';
        badge.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483645;' +
          'background:rgba(14,110,184,.92);color:#fff;font-size:12px;padding:6px 12px;border-radius:3px;' +
          'font-family:-apple-system,"PingFang SC",sans-serif;pointer-events:none';
      }
      if (!badge.parentNode && document.body) document.body.appendChild(badge);
    } else if (badge && badge.parentNode) {
      badge.parentNode.removeChild(badge);
    }
  }

  // ==================== 问题页：打开即接管 ====================

  // 原页面模式（?zh_raw=1）：什么都不拦，只给一个回阅读器的入口
  function showRawEntry() {
    showBtn('进旧版阅读', function () { location.replace(urlWithRaw(false)); });
  }

  function startReader() {
    if (busy || converted) return;
    busy = true;
    writeBootSkeleton();

    zhOldReader().then(function (ok) {
      busy = false;
      if (ok) { converted = true; return; }
      // 用户在转换途中跳走了，或者 zhOldReader 自己已经渲染了错误页
    }).catch(function (e) {
      busy = false;
      window.__zhOldReaderError = String((e && e.stack) || e);
      console.error('[zh-old] 接管失败', e);
      renderBootError('旧版阅读加载失败：' + ((e && e.message) || e));
    });
  }

  // 原版知乎是 SPA：点问题链接不会产生新文档，document-start 就没机会接管。
  // 在捕获阶段把 /question/、/answer/ 链接改成整页跳转，保证每次进问题页都是先掐断再渲染。
  var guardInstalled = false;
  function installLinkGuard() {
    if (guardInstalled) return;
    guardInstalled = true;
    document.addEventListener('click', function (ev) {
      if (ev.defaultPrevented || ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var t = ev.target;
      var a = t && t.closest ? t.closest('a[href]') : null;
      if (!a) return;
      if (a.target && a.target !== '_self') return;
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') return;
      var u;
      try { u = new URL(a.href, location.href); } catch (e) { return; }
      if (u.origin !== location.origin) return;
      if (!/^\/(?:question\/\d+|answer\/\d+)(?:[\/?#]|$)/.test(u.pathname)) return;
      ev.preventDefault();
      ev.stopPropagation();
      location.href = u.href;
    }, true);
  }

  // ==================== 主页旧版（仍是手动） ====================

  function runConvert(kind) {
    return (kind === 'home') ? zhOldHome() : zhOldReader();
  }

  function failed(kind) {
    showBtn(kind === 'home' ? '重试旧版主页' : '重试旧版阅读', function () { startManual(); });
    toast(kind === 'home' ? '没取到主页内容，原页面已保留' : '旧版阅读加载失败，原页面已保留', true);
  }

  function startManual() {
    if (busy) return;
    var kind = routeKind();
    if (!kind) return;

    busy = true;
    hideBtn();
    busyBadge(true);
    runConvert(kind).then(function (ok) {
      busy = false;
      busyBadge(false);
      if (ok) { converted = true; return; }
      failed(kind);
    }).catch(function (e) {
      busy = false;
      busyBadge(false);
      window.__zhOldReaderError = String((e && e.stack) || e);
      console.error('[zh-old] 转换失败', e);
      failed(kind);
    });
  }

  // 旧版主页点出来的 ?zh_old=1
  function startFromMark(kind) {
    if (busy || converted) return;
    busy = true;
    var startPath = location.pathname;
    busyBadge(true);
    runConvert(kind).then(function (ok) {
      busy = false;
      busyBadge(false);
      if (location.pathname !== startPath) { hideBtn(); return; }
      if (ok) { converted = true; return; }
      failed(kind);
    }).catch(function (e) {
      busy = false;
      busyBadge(false);
      window.__zhOldReaderError = String((e && e.stack) || e);
      console.error('[zh-old] 自动转换失败', e);
      if (location.pathname === startPath) failed(kind);
    });
  }

  function syncEntry() {
    if (converted || busy) { hideBtn(); return; }
    showBtn('旧版主页', function () { startManual(); });
  }

  function bootHome() {
    if (routeKind() !== 'home') return;
    if (/[?&]zh_old=1(?:&|$)/.test(location.search)) { startFromMark('home'); return; }
    syncEntry();
    setTimeout(syncEntry, 400);
    setTimeout(syncEntry, 1200);
    setTimeout(syncEntry, 2500);

    // 页面把按钮清掉（SPA 重渲染）就补回来；只在没转换时跑
    setInterval(function () {
      if (converted || busy) return;
      if (routeKind() !== 'home') return;
      if (!btn || !btn.parentNode) syncEntry();
    }, 1500);

    // 站内 SPA 跳转后按钮文案跟着换（不自动转换）
    var lastPath = location.pathname + location.search;
    setInterval(function () {
      var now = location.pathname + location.search;
      if (now === lastPath) return;
      lastPath = now;
      if (converted || busy) return;
      syncEntry();
    }, 800);
  }

  function domReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  // ==================== 入口 ====================

  function boot() {
    var kind = routeKind();
    if (!kind) { hideBtn(); return; }

    if (kind === 'question') {
      if (isRawMode()) { domReady(showRawEntry); return; }
      startReader();   // document-start：先掐断原页面，再拉数据
      return;
    }

    installLinkGuard();
    domReady(bootHome);
  }

  boot();
})();
