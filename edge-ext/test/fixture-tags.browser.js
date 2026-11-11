/* fixture 真实结构测试（DOM 取自 <fixture-site>/ 的真站快照）：
     · 新版结构：<section id="tags"><div>Categories: <span><a>doujinshi</a></span></div>
     · 键名（裸文本）要翻成「类别:」，值（chip）要翻成「同人志」
     · 专名行（Artists/Parodies）键名翻、值保留
     · h1/h2 标题都要翻
   node test/fixture.browser.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const spawn = require('node:child_process').spawn;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const PORT = 9560;
const HTTP_PORT = 8970;

const INFO = "<div id=\"info\" class=\"svelte-iec8wt\"><!--[--><h1 class=\"title svelte-iec8wt\"><!--[--><span class=\"before svelte-iec8wt\">[水龍敬] </span><!--]--><span class=\"pretty svelte-iec8wt\">GTS グレートティーチャーサヨコ Lesson10</span><!--[--><span class=\"after svelte-iec8wt\"> (コミックホットミルク 2026年12月号) [古月个人汉化]</span><!--]--></h1><!--]--> <!--[--><h2 class=\"title svelte-iec8wt\">[水龍敬] GTS グレートティーチャーサヨコ Lesson10 (コミックホットミルク 2026年12月号) [中国翻訳]</h2><!--]--> <h3 id=\"gallery_id\" style=\"cursor: pointer;\" class=\"svelte-iec8wt\"><span class=\"hash svelte-iec8wt\">#</span>695705</h3> <section id=\"tags\" class=\"svelte-iec8wt\"><!--[--><!--[--><div class=\"tag-container field-name svelte-iec8wt\">Parodies: <span class=\"tags svelte-iec8wt\"><!--[--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/parody/original/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->original</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"160,798 galleries\">160.8k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--]--></span></div><!--]--><!--[!--><!--]--><!--[--><div class=\"tag-container field-name svelte-iec8wt\">Tags: <span class=\"tags svelte-iec8wt\"><!--[--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/big-breasts/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->big breasts</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"240,953 galleries\">241.0k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/group/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->group</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"126,531 galleries\">126.5k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/stockings/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->stockings</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"114,875 galleries\">114.9k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/blowjob/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->blowjob</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"111,250 galleries\">111.3k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/ahegao/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->ahegao</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"65,251 galleries\">65.3k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/kemonomimi/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->kemonomimi</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"32,096 galleries\">32.1k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/big-ass/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->big ass</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"27,676 galleries\">27.7k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/teacher/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->teacher</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"18,987 galleries\">19.0k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/bunny-girl/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->bunny girl</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"12,327 galleries\">12.3k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/eye-covering-bang/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->eye-covering bang</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"10,285 galleries\">10.3k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/tomboy/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->tomboy</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"7,467 galleries\">7.5k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/exposed-clothing/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->exposed clothing</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"4,398 galleries\">4.4k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/tag/manga/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->manga</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"531 galleries\">531</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--]--></span></div><!--]--><!--[--><div class=\"tag-container field-name svelte-iec8wt\">Artists: <span class=\"tags svelte-iec8wt\"><!--[--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/artist/mizuryu-kei/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->mizuryu kei</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"82 galleries\">82</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--]--></span></div><!--]--><!--[!--><!--]--><!--[--><div class=\"tag-container field-name svelte-iec8wt\">Languages: <span class=\"tags svelte-iec8wt\"><!--[--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/language/translated/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->translated</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"289,918 galleries\">289.9k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/language/chinese/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->chinese</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"164,883 galleries\">164.9k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--]--></span></div><!--]--><!--[--><div class=\"tag-container field-name svelte-iec8wt\">Categories: <span class=\"tags svelte-iec8wt\"><!--[--><!--[!--><!--[!--><!--[!--><!--[!--><!--[--><a class=\"tagchip variant-pill state-normal   svelte-mmywhv\" href=\"/category/doujinshi/\"><!--[!--><!--]--> <span class=\"name svelte-mmywhv\"><!--[!--><!--]-->doujinshi</span> <!--[--><span class=\"count svelte-mmywhv\" title=\"519,544 galleries\">519.5k</span><!--]--><!----></a><!--]--><!--]--><!--]--><!--]--><!--]--><!--]--></span></div><!--]--><!--]--> <dialog class=\"ext-dialog svelte-1hm9rzj\"><div class=\"ext-body svelte-1hm9rzj\"><h2 class=\"svelte-1hm9rzj\"><i class=\"fa fa-exclamation-triangle\" aria-hidden=\"true\"></i> You're leaving fixture</h2> <p class=\"ext-info svelte-1hm9rzj\">This link goes to an outside site. We don't run it, check it, or control\n\t\t\twhat it does with your visit. It has its own tracking and privacy policy.</p> <!--[!--><!--[!--><p class=\"ext-info svelte-1hm9rzj\">It was added by users and accepted by vote. That doesn't make it safe.</p><!--]--><!--]--> <p class=\"ext-url svelte-1hm9rzj\"></p> <div class=\"ext-actions svelte-1hm9rzj\"><span class=\"spacer svelte-1hm9rzj\"></span> <button type=\"button\" class=\"ext-btn svelte-1hm9rzj\">Cancel</button> <!--[--><a class=\"ext-btn primary svelte-1hm9rzj\" href=\"\" target=\"_blank\" rel=\"noopener noreferrer nofollow ugc\">Open in new tab</a><!--]--></div></div></dialog><!----> <div class=\"tag-container field-name svelte-iec8wt\">Pages: <span class=\"tags svelte-iec8wt\"><a class=\"tag svelte-iec8wt\" href=\"/search/?q=pages%3A28\"><span class=\"name svelte-iec8wt\">28</span></a></span></div> <div class=\"tag-container field-name svelte-iec8wt\">Uploaded: <span class=\"tags svelte-iec8wt\"><time class=\"nobold svelte-iec8wt\" datetime=\"2026-11-10T13:41:34.000Z\">45 minutes, 25 seconds ago <span style=\"opacity: 0.6\" class=\"svelte-iec8wt\">(2026年11月10日)</span></time></span></div> <section class=\"ts-root svelte-1gaacp2\"><!--[!--><button type=\"button\" class=\"ts-cta svelte-1gaacp2\" aria-expanded=\"false\"><span class=\"ts-cta-icon svelte-1gaacp2\" aria-hidden=\"true\"><!--[-->🔑<!--]--></span> <span class=\"ts-cta-text svelte-1gaacp2\"><!--[--><strong class=\"svelte-1gaacp2\">Log in to vote</strong> <span class=\"ts-cta-sub svelte-1gaacp2\">help shape this gallery's tags</span><!--]--></span> <span class=\"ts-cta-arrow svelte-1gaacp2\" aria-hidden=\"true\"><i class=\"fa fa-chevron-right\"></i></span></button>  <!--[!--><!--]--><!--]--></section><!----></section> <div class=\"buttons btn-group svelte-iec8wt\"><!--[!--><button type=\"button\" class=\"btn btn-primary btn-disabled tooltip svelte-iec8wt\" disabled=\"\"><i class=\"fas fa-heart svelte-iec8wt\"></i><span class=\"svelte-iec8wt\">Favorite <span class=\"nobold svelte-iec8wt\">(81)</span></span><span class=\"top svelte-iec8wt\">You need to log in to add favorites<i class=\"svelte-iec8wt\"></i></span></button> <button type=\"button\" id=\"download\" class=\"btn btn-secondary btn-disabled tooltip svelte-iec8wt\" disabled=\"\"><i class=\"fa fa-download svelte-iec8wt\"></i> Download<span class=\"top svelte-iec8wt\">You need to log in to download<i class=\"svelte-iec8wt\"></i></span></button><!--]--> <!--[!--><!--]--></div></div>";
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>695705</title>' +
  '<style>body{margin:0;background:#1b1b1b;color:#eee;font:14px/1.5 system-ui}' +
  '#info{max-width:860px;margin:0 auto;padding:16px}' +
  'h1.title{font-size:19px;font-weight:600}h2.title{font-size:16px;color:#bbb;font-weight:400}' +
  '#tags > div{padding:3px 0;line-height:1.9}' +
  '#tags a{color:#7fd3ff;text-decoration:none;background:#3a3a3a;border-radius:3px;padding:1px 5px;margin-right:4px;font-size:12px}' +
  'dialog{display:none}</style></head><body>' + INFO + '</body></html>';

const server = http.createServer(function (q, s) { s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end(PAGE); });

function connect(url) {
  var ws = new WebSocket(url);
  var id = 0, pending = new Map(), contexts = [];
  ws.addEventListener('message', function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { var p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
    else if (m.method === 'Runtime.executionContextsCleared') contexts = [];
  });
  return new Promise(function (res, rej) {
    ws.addEventListener('open', function () { res({
      send: function (me, pa) { return new Promise(function (resolve, reject) { var mid = ++id; pending.set(mid, { resolve: resolve, reject: reject }); ws.send(JSON.stringify({ id: mid, method: me, params: pa || {} })); }); },
      ev: async function (expr, cid) {
        var r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, contextId: cid });
        if (r.exceptionDetails) throw new Error(((r.exceptionDetails.exception || {}).description || 'err').slice(0, 400));
        return r.result.value;
      },
      get contexts() { return contexts; }, close: function () { ws.close(); }
    }); }, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
}

(async function () {
  var fail = 0;
  var profile = path.join(os.tmpdir(), 'dsh-nh-' + Date.now());
  await new Promise(function (r) { server.listen(HTTP_PORT, '127.0.0.1', r); });
  var child = spawn(EDGE, [
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--no-first-run', '--no-default-browser-check', '--disable-component-extensions-with-background-pages',
    'http://127.0.0.1:' + HTTP_PORT + '/'
  ], { stdio: 'ignore' });
  await new Promise(function (r) { setTimeout(r, 8000); });

  try {
    var list = await fetch('http://127.0.0.1:' + PORT + '/json/list').then(function (r) { return r.json(); });
    var page = list.find(function (t) { return t.type === 'page' && t.url.indexOf(String(HTTP_PORT)) >= 0; });
    if (!page) throw new Error('no page');
    var pc = await connect(page.webSocketDebuggerUrl);
    await pc.send('Runtime.enable');
    await new Promise(function (r) { setTimeout(r, 1000); });
    var iso = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'isolated'; }).pop();
    var main = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'default'; }).pop();
    if (!iso) throw new Error('no content script');

    console.log('· 站点规则: ' + await pc.ev('globalThis.__DSH_INTERNALS__.siteRule()', iso.id));
    var n = await pc.ev('globalThis.__DSH_INTERNALS__.collect(document.body).length', iso.id);
    console.log('· 收集单元 ' + n);
    var modes = await pc.ev('"X" + JSON.stringify(globalThis.__DSH_INTERNALS__.collect(document.body).map(function(u){return u.mode;}))', iso.id);
    var modeList = JSON.parse(modes.slice(1));
    var counts = {};
    modeList.forEach(function (x) { counts[x] = (counts[x] || 0) + 1; });
    console.log('· 单元类型分布: ' + JSON.stringify(counts));

    var t0 = Date.now();
    await pc.ev('globalThis.__DSH_INTERNALS__.start("bilingual")', iso.id);
    for (var i = 0; i < 160; i++) {
      await new Promise(function (r) { setTimeout(r, 250); });
      var st = JSON.parse(await pc.ev('JSON.stringify(globalThis.__DSH_INTERNALS__.state())', iso.id));
      if (st.total > 0 && st.done >= st.total) break;
    }
    console.log('· 翻译完成 ' + (Date.now() - t0) + 'ms');

    var r = await pc.ev('(function(){' +
      'var o={};' +
      'o.h1=(document.querySelector("h1.title .dsh-tr")||{}).textContent||"";' +
      'o.h2=(document.querySelector("h2.title .dsh-tr")||{}).textContent||"";' +
      'var rows=Array.from(document.querySelectorAll("#tags > div"));' +
      'o.rows=rows.map(function(d){' +
      '  var label=d.querySelector(".dsh-tr-label");' +
      '  var chips=Array.from(d.querySelectorAll(".tagchip .dsh-tr")).map(function(t){return t.textContent;});' +
      '  return { label: label?label.textContent:"(未翻)", chips: chips };' +
      '});' +
      'return o;' +
      '})()', main.id);

    var hasHan = function (s) { return /\p{Script=Han}/u.test(String(s || '')); };
    var rowsText = r.rows.map(function (x) { return x.label + ' [' + x.chips.join(',') + ']'; }).join(' | ');
    var keyLabels = r.rows.map(function (x) { return x.label; }).join('|');
    var allChips = r.rows.map(function (x) { return x.chips.join(','); }).join(',');

    var checks = [
      ['h1 标题被翻译', hasHan(r.h1), r.h1.slice(0, 40)],
      ['h2 标题被翻译', hasHan(r.h2), r.h2.slice(0, 40)],
      ['标签行键名被翻译', keyLabels.indexOf('标签') >= 0 || keyLabels.indexOf('TAG') < 0, keyLabels],
      ['类别键名被翻译', keyLabels.indexOf('类别') >= 0, keyLabels],
      ['艺术家键名被翻译', keyLabels.indexOf('艺术家') >= 0, keyLabels],
      ['语言键名被翻译', keyLabels.indexOf('语言') >= 0, keyLabels],
      ['页数键名被翻译', keyLabels.indexOf('页数') >= 0, keyLabels],
      ['上传时间键名被翻译', keyLabels.indexOf('上传时间') >= 0, keyLabels],
      ['doujinshi 被翻译成同人志', allChips.indexOf('同人志') >= 0, allChips],
      ['big breasts 被翻译', hasHan(allChips.replace(/[\d.,k]+/g, '')), allChips.slice(0, 80)],
      ['translated 被翻译', allChips.indexOf('翻译') >= 0 || allChips.indexOf('已翻') >= 0, allChips]
    ];
    console.log('');
    for (var c of checks) {
      if (c[1]) { console.log('✓ ' + c[0] + ' → ' + String(c[2]).slice(0, 60)); }
      else { console.log('✗ ' + c[0] + ' → ' + String(c[2]).slice(0, 60)); fail++; }
    }

    pc.close();
  } catch (e) {
    console.log('ERR ' + (e && e.message));
    fail++;
  } finally {
    try { child.kill(); } catch (e) {}
    server.close();
  }
  console.log('\n' + (fail ? ('x 失败 ' + fail + ' 项') : 'OK fixture 真实结构测试通过'));
  process.exit(fail ? 1 : 0);
})();
