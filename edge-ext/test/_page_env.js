(function () {
  return {
    host: location.hostname,
    siteRule: (function () {
      try { return globalThis.__DSH_INTERNALS__.siteRule(); } catch (e) { return null; }
    })(),
    bodyText: (document.body.textContent || '').trim().length,
    elements: document.querySelectorAll('*').length
  };
})()