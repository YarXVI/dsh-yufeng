(function () {
  var out = []; var seen = 0;
  var all = Array.from(document.querySelectorAll('*'));
  for (var i = 0; i < all.length && out.length < 120; i++) {
    var el = all[i];
    var t = (el.textContent || '').trim();
    if (t.length < 2) continue;
    var direct = 0;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && (n.nodeValue || '').trim().length >= 2) direct += (n.nodeValue || '').trim().length;
    }
    if (!direct) continue;
    seen++;
    try {
      if (!globalThis.__DSH_INTERNALS__.shouldSkip(el)) continue;
      var reason = '站点规则或 skipSelectors';
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') reason = 'CSS 隐藏';
      else if (el.getAttribute('translate') === 'no') reason = 'translate=no';
      else if (el.getAttribute('aria-hidden') === 'true') reason = 'aria-hidden';
      else if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TITLE') reason = '不可翻标签';
      else if (el.tagName === 'PRE' || el.tagName === 'CODE') reason = '代码块';
      else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') reason = '输入控件';
      else if (el.closest && el.closest('#tags > div')) reason = 'nhentai 专名行';
      var p = []; var x = el; var h = 0;
      while (x && h < 3) {
        p.unshift(x.tagName + (x.className ? '.' + String(x.className).split(' ')[0] : ''));
        x = x.parentElement; h++;
      }
      out.push({ text: t.slice(0, 50), path: p.join(' > '), tags: el.tagName, reason: reason });
    } catch (e) { /* ignore */ }
  }
  return { skipped: out, totalTextLeaves: seen };
})()