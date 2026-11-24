const DEFAULTS = {
  enabled: true, size: 140, speed: 1, sleepIdle: true, bubbles: true, skin: "cloak", disabledSites: [],
  physics: true, platforms: true, pageTalk: true, selectTalk: true, ai: false, aiComments: true, pinTop: false, physSpeed: 0.7, explore: true, errors: true,
  sound: true, volume: 0.4, steps: false, cookieBlow: false,
  focusOn: true, focusSites: "youtube.com, instagram.com, tiktok.com, facebook.com, x.com, twitter.com, vk.com, reddit.com, twitch.tv",
  voice: false, weatherOn: true, city: "Ташкент", errorPage: true,
  schedOn: true, workStart: "09:00", workEnd: "18:00", breaks: "11:00-11:10, 13:00-14:00, 16:00-16:10", workDays: [1, 2, 3, 4, 5, 6], notify: true,
  provider: "gemini", apiKey: "", model: "gemini-flash-latest", claudeKey: "", claudeModel: "claude-haiku-5-5", name: "Чиби",
};
const SKINS = [["cloak", "Плащ"], ["disciple", "Ученик"]];
const CHECKS = ["voice", "focusOn", "weatherOn", "errorPage", "sound", "steps", "schedOn", "notify", "cookieBlow", "errors", "explore", "pinTop", "enabled", "sleepIdle", "bubbles", "physics", "platforms", "pageTalk", "selectTalk", "ai", "aiComments"];
const $ = (id) => document.getElementById(id);
const store = chrome.storage.local;
let host = "";

$("skins").innerHTML =
  SKINS.map(([k, t]) => `<button data-skin="${k}" type="button"><img src="poses/${k}/idle.webp" alt="">${t}</button>`).join("") +
  `<button data-skin="random" type="button"><span class="rnd">🎲</span>Случайно</button>`;
document.querySelectorAll("#skins img").forEach((i) => i.addEventListener("error", () => i.closest("button").remove()));

function markSkin(k) {
  document.querySelectorAll("#skins button").forEach((b) => b.classList.toggle("on", b.dataset.skin === k));
  $("logo").src = "poses/" + (k === "random" ? "cloak" : k) + "/wave.webp";
}
function markAi(on) { if (on) $("aiBox").removeAttribute("data-off"); else $("aiBox").setAttribute("data-off", ""); }

const timers = {};
function save(key, value, delay = 0) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => store.set({ [key]: value }), delay);
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  try { const u = new URL(tabs[0].url); host = /^https?:$/.test(u.protocol) ? u.hostname : ""; } catch { host = ""; }
  $("host").textContent = host || "—";
  store.get(DEFAULTS, (s) => {
    CHECKS.forEach((k) => { $(k).checked = !!s[k]; });
    $("site").checked = !s.disabledSites.includes(host);
    $("site").disabled = !host;
    $("size").value = s.size; $("sizeVal").textContent = s.size + " px";
    $("physSpeed").value = s.physSpeed; $("physSpeedVal").textContent = physLabel(s.physSpeed);
    $("speed").value = s.speed; $("speedVal").textContent = "×" + Number(s.speed).toFixed(1);
    $("apiKey").value = s.apiKey;
    $("model").value = s.model;
    $("claudeKey").value = s.claudeKey;
    $("claudeModel").value = s.claudeModel;
    markProvider(s.provider);
    $("name").value = s.name;
    $("title").textContent = s.name || "Чиби-маскот";
    markSkin(s.skin);
    markAi(s.ai);
    $("volume").value = s.volume; $("volumeVal").textContent = Math.round(s.volume * 100) + "%";
    $("workStart").value = s.workStart; $("workEnd").value = s.workEnd; $("breaks").value = s.breaks;
    renderDays(s.workDays);
    $("focusSites").value = s.focusSites; $("city").value = s.city;
  });
});

CHECKS.forEach((k) => $(k).addEventListener("change", (e) => { save(k, e.target.checked); if (k === "ai") markAi(e.target.checked); }));
$("site").addEventListener("change", (e) => {
  store.get(DEFAULTS, (s) => {
    const set = new Set(s.disabledSites);
    e.target.checked ? set.delete(host) : set.add(host);
    store.set({ disabledSites: [...set] });
  });
});
$("skins").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  markSkin(b.dataset.skin);
  save("skin", b.dataset.skin);
});
$("size").addEventListener("input", (e) => { $("sizeVal").textContent = e.target.value + " px"; save("size", Number(e.target.value), 120); });
function physLabel(v) { v = Number(v); return "×" + v.toFixed(2) + (v < 0.55 ? " · плавно" : v > 1.1 ? " · быстро" : ""); }
$("physSpeed").addEventListener("input", (e) => { $("physSpeedVal").textContent = physLabel(e.target.value); save("physSpeed", Number(e.target.value), 120); });
$("speed").addEventListener("input", (e) => { $("speedVal").textContent = "×" + Number(e.target.value).toFixed(1); save("speed", Number(e.target.value), 120); });
$("apiKey").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  save("apiKey", v, 400);
  if (v && !$("ai").checked) { $("ai").checked = true; markAi(true); save("ai", true, 400); } // вставил ключ — включаем
});
$("model").addEventListener("input", (e) => save("model", e.target.value.trim() || DEFAULTS.model, 400));
function markProvider(p) {
  document.querySelectorAll("#provider button").forEach((b) => b.classList.toggle("on", b.dataset.p === p));
  $("gem").hidden = p !== "gemini";
  $("cla").hidden = p !== "claude";
}
$("provider").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  markProvider(b.dataset.p); save("provider", b.dataset.p);
});
$("claudeKey").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  save("claudeKey", v, 400);
  if (v && !$("ai").checked) { $("ai").checked = true; markAi(true); save("ai", true, 400); }
});
$("claudeModel").addEventListener("input", (e) => save("claudeModel", e.target.value.trim() || DEFAULTS.claudeModel, 400));
$("name").addEventListener("input", (e) => { const v = e.target.value.trim() || DEFAULTS.name; $("title").textContent = v; save("name", v, 400); });
$("reset").addEventListener("click", () => {
  // ключ при сбросе не стираем — его неудобно вставлять заново
  store.get({ apiKey: "", claudeKey: "" }, (k) => store.set({ ...DEFAULTS, ...k }, () => location.reload()));
});

// ---- звук ----
$("volume").addEventListener("input", (e) => { $("volumeVal").textContent = Math.round(e.target.value * 100) + "%"; save("volume", Number(e.target.value), 150); });
// ---- рабочий день ----
$("workStart").addEventListener("change", (e) => save("workStart", e.target.value || DEFAULTS.workStart));
$("workEnd").addEventListener("change", (e) => save("workEnd", e.target.value || DEFAULTS.workEnd));
$("breaks").addEventListener("input", (e) => save("breaks", e.target.value, 500));
const DAY_NAMES = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
let workDays = [];
function renderDays(d) {
  workDays = [...d];
  $("days").innerHTML = [1, 2, 3, 4, 5, 6, 0].map((i) => `<button type="button" data-d="${i}" class="${workDays.includes(i) ? "on" : ""}">${DAY_NAMES[i]}</button>`).join("");
}
$("days").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const d = Number(b.dataset.d);
  workDays = workDays.includes(d) ? workDays.filter((x) => x !== d) : [...workDays, d];
  b.classList.toggle("on");
  save("workDays", workDays);
});
$("schedTest").addEventListener("click", () => chrome.runtime.sendMessage({ type: "schedTest", ev: "break" }));
// ---- культивация и достижения ----
const REALMS = ["Закалка тела", "Сбор Ци", "Основание", "Золотое ядро", "Зарождение души", "Преображение духа", "Пустота", "Слияние с Дао", "Бессмертный"];
const STAGES = ["начальная", "средняя", "поздняя"];
function levelOf(xp) { let lvl = 0, need = 60; while (xp >= need && lvl < REALMS.length * 3 - 1) { xp -= need; lvl++; need = Math.round(need * 1.35); } return { lvl, into: xp, need }; }
const ACH = [["bugs",1,"Первый баг"],["bugs",25,"Охотник на баги"],["bugs",100,"Гроза багов"],["throws",10,"Выдержка"],["throws",100,"Непоколебимый"],["meters",500,"Путник"],["meters",5000,"Странник Дао"],["notes",5,"Хранитель свитков"],["breaks",10,"Дисциплина"],["days",7,"Неделя"],["days",30,"Месяц"]];
function showStats(st) {
  st = st || {};
  const L = levelOf(st.xp || 0);
  $("realm").textContent = `🧘 ${REALMS[Math.floor(L.lvl / 3)]}, ${STAGES[L.lvl % 3]} стадия`;
  $("xpTxt").textContent = `${L.into}/${L.need} ци`;
  $("xpBar").style.width = Math.round((L.into / L.need) * 100) + "%";
  const days = st.firstDay ? Math.floor((Date.now() - new Date(st.firstDay).getTime()) / 864e5) + 1 : 1;
  $("statsTxt").textContent = `вместе ${days} дн. · багов ${st.bugs || 0} · бросков ${st.throws || 0} · прошёл ${st.meters || 0} м`;
  const got = st.ach || [];
  $("ach").innerHTML = ACH.map(([k, n, name]) => `<span class="${got.includes(k + n) ? "" : "off"}" title="${k} ≥ ${n}">${name}</span>`).join("");
}
chrome.storage.local.get({ stats: {} }, (v) => showStats(v.stats));
chrome.storage.onChanged.addListener((ch) => { if (ch.stats) showStats(ch.stats.newValue); });

$("focusSites").addEventListener("input", (e) => save("focusSites", e.target.value, 500));
$("city").addEventListener("input", (e) => save("city", e.target.value.trim() || "Ташкент", 700));
// ---- сегодня ----
function fmt(sec) { const m = Math.round(sec / 60); return m < 60 ? m + " мин" : Math.floor(m / 60) + " ч " + (m % 60 ? (m % 60) + " мин" : ""); }
chrome.storage.local.get({ day: null }, ({ day }) => {
  if (!day || day.date !== new Date().toDateString()) { $("todayTxt").textContent = "пока пусто"; return; }
  const top = Object.entries(day.sites || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const total = Object.values(day.sites || {}).reduce((a, b) => a + b, 0);
  $("todayTxt").textContent = `в браузере ${fmt(total)}: ` + top.map(([h, t]) => `${h} ${fmt(t)}`).join(", ") + ` · жучков ${day.bugs || 0} · перерывов ${day.breaks || 0} · +${day.xp || 0} ци`;
});
