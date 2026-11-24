// Страница вместо встроенной страницы ошибки Chrome: на ней живёт маскот, объясняет, что случилось,
// и сам открывает сайт снова, когда появляется сеть.
(() => {
  const q = new URLSearchParams(location.search);
  const url = q.get("u") || "";
  const err = (q.get("e") || "net::ERR_FAILED").replace(/^net::/, "");
  const NET = {
    ERR_INTERNET_DISCONNECTED: ["Нет интернета", "Компьютер не подключён к сети. Как только связь появится — открою сайт сам.", true],
    ERR_NETWORK_CHANGED: ["Сеть переключилась", "Соединение сменилось во время загрузки. Открою снова.", true],
    ERR_NAME_NOT_RESOLVED: ["Домен не найден", "Такого адреса нет или DNS не отвечает. Проверь адрес на опечатки.", false],
    ERR_NAME_RESOLUTION_FAILED: ["DNS не ответил", "Не удалось узнать адрес сервера. Проверь сеть или DNS.", true],
    ERR_CONNECTION_REFUSED: ["Соединение отклонено", "Сервер не принимает подключения: не запущен или не тот порт.", false],
    ERR_CONNECTION_TIMED_OUT: ["Сервер не ответил", "Время ожидания вышло. Сервер перегружен или недоступен.", true],
    ERR_TIMED_OUT: ["Сервер не ответил", "Время ожидания вышло.", true],
    ERR_CONNECTION_RESET: ["Соединение сброшено", "Связь оборвалась на полпути. Повтори.", true],
    ERR_CONNECTION_CLOSED: ["Соединение закрыто", "Сервер закрыл соединение без ответа.", true],
    ERR_EMPTY_RESPONSE: ["Пустой ответ", "Сервер ничего не прислал.", true],
    ERR_ADDRESS_UNREACHABLE: ["Адрес недоступен", "До сервера не добраться из этой сети.", true],
    ERR_TOO_MANY_REDIRECTS: ["Бесконечные редиректы", "Сайт гоняет по кругу. Почисти cookies этого сайта.", false],
    ERR_PROXY_CONNECTION_FAILED: ["Прокси не отвечает", "Проверь настройки прокси или VPN.", true],
    ERR_HTTP2_PROTOCOL_ERROR: ["Ошибка протокола", "Сервер ответил некорректно. Повтори позже.", true],
    ERR_QUIC_PROTOCOL_ERROR: ["Ошибка протокола", "Сбой QUIC. Повтори.", true],
    ERR_FILE_NOT_FOUND: ["Файл не найден", "Такого файла на диске нет.", false],
    ERR_UNSAFE_PORT: ["Запрещённый порт", "Chrome не открывает этот порт из соображений безопасности. Используй другой.", false],
    ERR_INVALID_RESPONSE: ["Битый ответ", "Сервер прислал что-то непонятное.", true],
  };
  const [title, why, auto] = NET[err] || ["Страница не открылась", "Сайт не загрузился. Повтори или проверь адрес.", true];
  document.getElementById("code").textContent = err;
  document.getElementById("title").textContent = title;
  document.getElementById("why").textContent = why;
  document.getElementById("url").textContent = url;
  document.title = title;
  const go = () => { if (url) location.replace(url); };
  document.getElementById("retry").addEventListener("click", go);
  // «Назад» — мимо упавшей страницы, чтобы не попасть на неё снова
  document.getElementById("back").addEventListener("click", () => (history.length > 2 ? history.go(-2) : history.back()));
  const hint = document.getElementById("hint");
  // сам проверяет, ожил ли сайт (тихий запрос), и только тогда открывает его — без мигания ошибками
  const probe = async () => {
    if (!url || !navigator.onLine) return false;
    try { await fetch(url, { mode: "no-cors", cache: "no-store" }); return true; } catch { return false; }
  };
  if (auto) {
    hint.textContent = navigator.onLine ? "Проверяю каждые 10 секунд…" : "Жду сеть…";
    window.addEventListener("online", async () => { hint.textContent = "Сеть есть. Проверяю сайт…"; if (await probe()) go(); });
    window.addEventListener("offline", () => { hint.textContent = "Жду сеть…"; });
    let n = 0;
    setInterval(async () => { if (++n <= 60 && await probe()) go(); }, 10000);
  }
  // для маскота: что сказать на этой странице
  window.__chibiErrorPage = { code: err, title };
})();
