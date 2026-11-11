(function () {
  return Array.from(document.querySelectorAll('.dsh-tr')).map(function (t) {
    var par = t.parentElement;
    return {
      src: t.getAttribute('data-dsh-src') || '',
      dst: t.textContent || '',
      cls: t.className.replace('dsh-tr', '').trim(),
      parent: par ? par.tagName + (par.className ? '.' + String(par.className).split(' ')[0] : '') : ''
    };
  });
})()