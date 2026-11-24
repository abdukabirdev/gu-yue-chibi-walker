// Chibi Walker — фоновый скрипт: ходит в Gemini API за ответами для умного режима.
// Ключ хранится только в chrome.storage.local этого браузера и уходит только в Google.
const DEF = {
  provider: "gemini",
  apiKey: "", model: "gemini-flash-latest",              // Gemini
  claudeKey: "", claudeModel: "claude-haiku-5-5",         // Claude
  name: "Чиби", aiLastComment: 0,
};
const API = "https://generativelanguage.googleapis.com/v1beta/models/";
const CLAUDE_API = "https://api.anthropic.com/v1/messages";

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  // где стоял маскот на этом сайте в этой вкладке — чтобы при переходе по страницам он остался на месте
  if (msg?.type === "pos:set" || msg?.type === "pos:get" || msg?.type === "pos:clear") {
    const key = "pos:global";   // один маскот на весь браузер: общее состояние для всех вкладок
    if (msg.type === "pos:set") chrome.storage.session.set({ [key]: { ...msg.data, at: Date.now() } }).then(() => send(true), () => send(false));
    else if (msg.type === "pos:clear") chrome.storage.session.remove(key).then(() => send(true), () => send(false));
    else chrome.storage.session.get(key).then((v) => send(v[key] || null), () => send(null));
    return true;
  }
  if (msg?.type !== "ai") return;
  ask(msg).then(send, () => send({ ok: false, error: "net" }));
  return true; // ответим асинхронно
});

const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);

function persona(name) {
  return `Ты — ${name}, маленький чиби-маскот: юный культиватор с длинными чёрными волосами, как из китайской новеллы. ` +
    `Ты живёшь в браузере своего хозяина и гуляешь по сайтам, которые он открывает. ` +
    `Характер: озорной, чуть наглый, добрый, любишь чай и шутку «给钱» (дай денег). ` +
    `Всегда отвечай по-русски, простым текстом: без markdown, без звёздочек, без списков и заголовков. ` +
    `Когда просят объяснить или ответить — отвечай точно и по существу (факты, формулы, код), образ только в тоне. ` +
    `Если не уверен в факте — так и скажи.`;
}

function buildPrompt(m) {
  const page = `Страница: «${clip(m.title, 200)}» (${clip(m.url, 300)}).`;
  if (m.mode === "explain") {
    return `${page}\nХозяин выделил на ней текст:\n"""\n${clip(m.text, 5000)}\n"""\n` +
      `Объясни коротко и понятно (до 5 предложений). Если это вопрос или задача — реши и дай ответ. ` +
      `Если это код — скажи, что он делает. Если текст длинный — перескажи главное. Если иностранный — переведи на русский.`;
  }
  if (m.mode === "ask") {
    return `${page}\nТекст страницы (начало):\n"""\n${clip(m.text, 6000)}\n"""\n` +
      `Вопрос хозяина: ${clip(m.question, 500)}\n` +
      `Ответь коротко (до 6 предложений). Если вопрос про страницу — опирайся на её текст; если общий — отвечай из своих знаний.`;
  }
  // comment
  return `${page}\nНачало текста страницы:\n"""\n${clip(m.text, 1500)}\n"""\n` +
    `Скажи одну короткую (до 14 слов) смешную реплику в своём образе про то, что хозяин сейчас смотрит или читает. Только саму реплику.`;
}

async function ask(m) {
  const cfg = await chrome.storage.local.get(DEF);
  const claude = cfg.provider === "claude";
  const key = String((claude ? cfg.claudeKey : cfg.apiKey) || "").trim();
  if (!key) return { ok: false, error: claude ? "nokeyClaude" : "nokey" };
  if (m.mode === "comment") {
    // реплики к сайтам — не чаще раза в 4 минуты, чтобы не тратить лимит
    if (Date.now() - (cfg.aiLastComment || 0) < 4 * 60 * 1000) return { ok: false, error: "cooldown" };
    await chrome.storage.local.set({ aiLastComment: Date.now() });
  }
  const sys = persona(clip(cfg.name, 30) || DEF.name);
  const prompt = buildPrompt(m);
  const r = claude
    ? await callClaude(key, String(cfg.claudeModel || "").trim() || DEF.claudeModel, sys, prompt, m.mode)
    : await callGemini(key, String(cfg.model || "").trim() || DEF.model, sys, prompt);
  if (r.ok) r.text = r.text.replace(/\*\*|__|`{1,3}|^#+\s*/gm, "").trim().slice(0, 1200);
  return r;
}

async function post(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    return { res, data };
  } catch {
    return { res: null, data: null };
  } finally {
    clearTimeout(timer);
  }
}
function httpError(st, msg, who) {
  if (st === 429) return { ok: false, error: "limit" };
  if (st === 404) return { ok: false, error: "model" };
  if (st === 401 || st === 403 || /api.?key|x-api-key|authentication/i.test(msg)) return { ok: false, error: "badkey" };
  if (st === 529 || st === 503) return { ok: false, error: "busy" };
  if (/credit|billing|balance/i.test(msg)) return { ok: false, error: "credits" };
  return { ok: false, error: who + " " + st + (msg ? ": " + msg.slice(0, 140) : "") };
}

async function callGemini(key, model, sys, prompt) {
  const { res, data } = await post(API + encodeURIComponent(model) + ":generateContent",
    { "content-type": "application/json", "x-goog-api-key": key },
    {
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      // temperature/top_p/top_k не передаём: в новых моделях Gemini они устарели и могут вызвать ошибку
      generationConfig: { maxOutputTokens: 2048 },
    });
  if (!res) return { ok: false, error: "net" };
  if (!res.ok) return httpError(res.status, String(data?.error?.message || ""), "Gemini");
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  return text ? { ok: true, text } : { ok: false, error: "empty" };
}

async function callClaude(key, model, sys, prompt, mode) {
  const { res, data } = await post(CLAUDE_API,
    {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      // запрос идёт прямо из браузера (расширения), без своего сервера
      "anthropic-dangerous-direct-browser-access": "true",
    },
    {
      model,
      max_tokens: mode === "comment" ? 120 : 700,
      system: sys,
      messages: [{ role: "user", content: prompt }],
    });
  if (!res) return { ok: false, error: "net" };
  if (!res.ok) return httpError(res.status, String(data?.error?.message || ""), "Claude");
  const text = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return text ? { ok: true, text } : { ok: false, error: "empty" };
}

// закрыли вкладку — забываем её позиции
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k === "pos:" + tabId || k.startsWith("pos:" + tabId + ":"));
  if (keys.length) chrome.storage.session.remove(keys);
});

// ================= Рабочий день: будильник раз в минуту =================
const SCHED_DEF = {
  schedOn: true, workStart: "09:00", workEnd: "18:00", breaks: "11:00-11:10, 13:00-14:00, 16:00-16:10",
  workDays: [1, 2, 3, 4, 5, 6], notify: true, schedFired: { date: "", keys: [] },
};
const SCHED_TEXT = {
  start: "Доброе утро! Начинаем работу 💪", preBreak: "Через 5 минут перерыв ☕", break: "Перерыв! Встань, разомнись, попей чаю 🍵",
  preLunch: "Через 5 минут обед 🍲", lunch: "Обед! Приятного аппетита 🍲", back: "Перерыв окончен — за работу 💻",
  preEnd: "Ещё 10 минут — и домой!", end: "Рабочий день окончен! Домой 🎉", water: "Попей воды 💧",
};
function setupAlarm() {
  chrome.alarms.get("tick", (a) => { if (!a) chrome.alarms.create("tick", { periodInMinutes: 1, when: Date.now() + (60000 - (Date.now() % 60000)) + 500 }); });
}
chrome.runtime.onInstalled.addListener(setupAlarm);
chrome.runtime.onStartup.addListener(setupAlarm);
setupAlarm();
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "tick") checkSchedule(); });

const hm = (str) => { const m = /(\d{1,2}):(\d{2})/.exec(str || ""); return m ? +m[1] * 60 + +m[2] : null; };
const parseBreaks = (str) => String(str || "").split(/[,;]+/).map((p) => p.trim().split(/\s*[-–—]\s*/)).map(([a, b]) => [hm(a), hm(b)]).filter(([a, b]) => a != null && b != null && b > a);

function eventsFor(c) {
  const st = hm(c.workStart), en = hm(c.workEnd), br = parseBreaks(c.breaks), evs = [];
  if (st != null) evs.push([st, "start"]);
  if (en != null) { evs.push([en - 10, "preEnd"]); evs.push([en, "end"]); }
  br.forEach(([a, b]) => { const lunch = b - a >= 30; evs.push([a - 5, lunch ? "preLunch" : "preBreak"]); evs.push([a, lunch ? "lunch" : "break"]); evs.push([b, "back"]); });
  // вода — каждые 90 минут работы, не рядом с перерывами
  if (st != null && en != null) for (let m = st + 90; m < en - 15; m += 90) if (!br.some(([a, b]) => m >= a - 15 && m < b + 15)) evs.push([m, "water"]);
  return evs;
}

async function checkSchedule(force) {
  const c = await chrome.storage.local.get(SCHED_DEF);
  if (!c.schedOn && !force) return;
  const now = new Date();
  if (!force && !(c.workDays || []).includes(now.getDay())) return;
  const min = now.getHours() * 60 + now.getMinutes(), date = now.toDateString();
  const fired = c.schedFired?.date === date ? c.schedFired.keys : [];
  const due = eventsFor(c).filter(([m, k]) => min >= m && min <= m + 2 && !fired.includes(k + "@" + m));
  if (!due.length) return;
  await chrome.storage.local.set({ schedFired: { date, keys: [...fired, ...due.map(([m, k]) => k + "@" + m)] } });
  deliver(due[due.length - 1][1], c.notify);
}

async function deliver(ev, notify) {
  let shown = false, focused = false;
  try {
    const w = await chrome.windows.getLastFocused();
    focused = !!w?.focused;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null) shown = await chrome.tabs.sendMessage(tab.id, { type: "sched", ev }).catch(() => false);
  } catch {}
  // уведомление Windows — если маскота не видно (браузер свёрнут, вкладка без него)
  if (notify && !(shown && focused)) {
    chrome.notifications.create("sched-" + Date.now(), { type: "basic", iconUrl: "icon128.png", title: "Чиби", message: SCHED_TEXT[ev] || "⏰", priority: 1 });
  }
}
// для кнопки «проверить» в настройках
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m?.type === "schedTest") { deliver(m.ev || "break", true).then(() => send(true)); return true; }
});

// ================= Переключение вкладок: маскот «перебегает» в новую вкладку с нужной стороны =================
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const key = "act:" + windowId;
  const prev = (await chrome.storage.session.get(key))[key];
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  await chrome.storage.session.set({ [key]: { tabId, index: tab.index } });
  if (!prev || prev.tabId === tabId) return;
  let prevIndex = prev.index;
  try { prevIndex = (await chrome.tabs.get(prev.tabId)).index; } catch {}
  // перешёл на вкладку левее — он прибегает справа (как будто идёт влево), правее — слева
  const from = tab.index < prevIndex ? "right" : "left";
  chrome.tabs.sendMessage(tabId, { type: "enter", from }).catch(() => {});
});

// ================= Помидор 25/5 (×4 → 15) — общий для всех вкладок =================
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m?.type !== "pomo") return;
  (async () => {
    if (m.cmd === "stop") { await chrome.alarms.clear("pomo"); await chrome.storage.local.set({ pomo: null }); return send(true); }
    const end = Date.now() + 25 * 60000;
    await chrome.storage.local.set({ pomo: { phase: "work", end, n: 0 } });
    chrome.alarms.create("pomo", { when: end });
    send(true);
  })();
  return true;
});
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "pomo") return;
  const { pomo } = await chrome.storage.local.get({ pomo: null });
  if (!pomo) return;
  let next, ev;
  if (pomo.phase === "work") {
    const n = (pomo.n || 0) + 1;
    const long = n % 4 === 0;
    next = { phase: "break", end: Date.now() + (long ? 15 : 5) * 60000, n };
    ev = long ? "pomoLong" : "pomoBreak";
  } else {
    next = { phase: "work", end: Date.now() + 25 * 60000, n: pomo.n || 0 };
    ev = "pomoWork";
  }
  await chrome.storage.local.set({ pomo: next });
  chrome.alarms.create("pomo", { when: next.end });
  const { notify } = await chrome.storage.local.get({ notify: true });
  SCHED_TEXT.pomoBreak = "🍅 25 минут прошло — перерыв 5 минут";
  SCHED_TEXT.pomoLong = "🍅×4 — большой перерыв 15 минут";
  SCHED_TEXT.pomoWork = "Перерыв окончен — новый помидор 🍅";
  deliver(ev, notify);
});

// ================= Погода: open-meteo, без ключа =================
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m?.type !== "weather") return;
  getWeather().then(send, () => send({ ok: false, error: "net" }));
  return true;
});
async function getWeather() {
  const { city = "Ташкент", geo = null, wcache = null } = await chrome.storage.local.get({ city: "Ташкент", geo: null, wcache: null });
  if (wcache && wcache.city === city && Date.now() - wcache.at < 30 * 60000) return wcache.data;
  let g = geo && geo.city === city ? geo : null;
  if (!g) {
    try {
      const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&language=ru&name=" + encodeURIComponent(city));
      const j = await r.json();
      const it = j?.results?.[0];
      if (!it) return { ok: false, error: "city" };
      g = { city, name: it.name, lat: it.latitude, lon: it.longitude };
      await chrome.storage.local.set({ geo: g });
    } catch { return { ok: false, error: "net" }; }
  }
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto`);
    const j = await r.json();
    const data = { ok: true, city: g.name, t: j.current.temperature_2m, code: j.current.weather_code, max: j.daily.temperature_2m_max[0], min: j.daily.temperature_2m_min[0], rain: j.daily.precipitation_probability_max?.[0] ?? 0 };
    await chrome.storage.local.set({ wcache: { city, at: Date.now(), data } });
    return data;
  } catch { return { ok: false, error: "net" }; }
}

// ================= Страница не открылась → своя страница ошибки, на которой живёт маскот =================
// Встроенные страницы ошибок Chrome расширениям недоступны, поэтому подменяем их своей.
const SKIP_ERR = /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR|ERR_BLOCKED_BY_RESPONSE|ERR_UNKNOWN_URL_SCHEME|ERR_CERT|ERR_SSL|ERR_BAD_SSL|ERR_INVALID_URL|ERR_DISALLOWED_URL_SCHEME/;
const recentErr = new Map(); // tabId -> {url, at}: защита от зацикливания (кнопка «назад», повторные ошибки)
chrome.webNavigation.onErrorOccurred.addListener(async (d) => {
  if (d.frameId !== 0 || !/^https?:|^file:/.test(d.url) || SKIP_ERR.test(d.error)) return;
  const { errorPage = true } = await chrome.storage.local.get({ errorPage: true });
  if (!errorPage) return;
  const prev = recentErr.get(d.tabId);
  if (prev && prev.url === d.url && Date.now() - prev.at < 30000) return;   // уже подменяли — пусть Chrome покажет свою
  recentErr.set(d.tabId, { url: d.url, at: Date.now() });
  const page = chrome.runtime.getURL("error.html") + "?u=" + encodeURIComponent(d.url) + "&e=" + encodeURIComponent(d.error);
  chrome.tabs.update(d.tabId, { url: page }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((id) => recentErr.delete(id));

// v9: персонаж стал суровым — «Плащ» по умолчанию; старые ненужные настройки убираем
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "update") return;
  const { v9 } = await chrome.storage.local.get({ v9: false });
  if (v9) return;
  const { skin } = await chrome.storage.local.get({ skin: "random" });
  await chrome.storage.local.set({ v9: true, ...(skin === "random" ? { skin: "cloak" } : {}) });
  await chrome.storage.local.remove(["mood", "seasons", "emotions", "flashlight", "myLore", "lore", "nature"]);
  const keys = Object.keys(await chrome.storage.session.get(null)).filter((k) => /^pos:\d+$/.test(k));
  if (keys.length) await chrome.storage.session.remove(keys);
});
