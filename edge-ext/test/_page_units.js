(function () {
  return globalThis.__DSH_INTERNALS__.collect(document.body).map(function (u) {
    var p = []; var n = u.el; var hops = 0;
    while (n && hops < 4) {
      p.unshift(n.tagName + (n.className ? '.' + String(n.className).split(' ')[0] : ''));
      n = n.parentElement; hops++;
    }
    return { mode: u.mode, text: u.text.slice(0, 60), path: p.join(' > '), rich: !!u.rich };
  });
})()