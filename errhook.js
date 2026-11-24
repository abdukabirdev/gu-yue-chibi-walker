// Chibi Walker — крошечный перехватчик в мире страницы: передаёт маскоту необработанные ошибки скриптов.
// Ничего не меняет на сайте и никуда не отправляет — только сообщение внутри этой же вкладки.
(() => {
  const send = (m) => { try { window.postMessage({ chibiErr: String(m || "ошибка").slice(0, 120) }, "*"); } catch {} };
  window.addEventListener("error", (e) => { if (e.target === window || !e.target?.tagName) send(e.message); });
  window.addEventListener("unhandledrejection", (e) => send(e.reason?.message || e.reason));
})();
