// Chibi Walker v2 — маскот гуляет по сайтам, ходит по элементам страницы, летает, когда его бросают,
// читает, о чём сайт, и (в умном режиме) объясняет выделенный текст и отвечает на вопросы.
// Всё живёт в закрытом Shadow DOM: стили сайта его не ломают, а он — сайт.
(() => {
  "use strict";
  if (window.top !== window || document.getElementById("chibi-walker-host")) return;

  // ================= Константы =================
  const POSES = ["idle", "sit", "sleep", "cool", "wave", "laugh", "think", "derp", "shock"];   // есть в каждом образе
  const SKINS = ["cloak", "disciple"]; // новые образы: папка в poses/ + имя сюда и в popup.js
  // Чего нет в образе — подменяем похожей позой
  const FALLBACK = { held: "shock", fall: "shock", fly: "shock", tumble: "shock", splat: "crouch", dizzy: "derp", rub: "think", crouch: "idle",
    pout: "think", blink: "idle", pet: "laugh", eat: "tea", read: "tea", tea: "think", point: "wave", leap: "crouch", skid: "crouch", edge: "cool", meditate: "sit" };
  const BASE_CFG = { walk: ["idle"], walkFps: 4.5, faces: { walk: -1 }, has: [], ax: {} };
  const EMOTES = ["cool", "think", "read", "laugh", "sit", "idle"];
  const CLICK_REACT = ["cool", "shock", "think", "pout", "wave"];
  const PHRASES = ["…", "Работай.", "Не отвлекайся.", "Хм.", "Тишина.", "Сосредоточься.", "Я наблюдаю."];
  const DEFAULTS = {
    enabled: true, size: 140, speed: 1, sleepIdle: true, bubbles: true, skin: "cloak", disabledSites: [],
    physics: true, platforms: true, pageTalk: true, selectTalk: true, ai: false, aiComments: true,
    pinTop: false, physSpeed: 0.7, explore: true, errors: true, curSkin: "",
    sound: true, volume: 0.4, steps: false, cookieBlow: false,
    focusOn: true, focusSites: "youtube.com, instagram.com, tiktok.com, facebook.com, x.com, twitter.com, vk.com, reddit.com, twitch.tv",
    voice: false, weatherOn: true, city: "Ташкент",
    schedOn: true, workStart: "09:00", workEnd: "18:00", breaks: "11:00-11:10, 13:00-14:00, 16:00-16:10", workDays: [1, 2, 3, 4, 5, 6],
  };
  const PIN_POSES = ["sit", "sit", "think", "cool", "read", "sleep"];
  const G = 2600;               // гравитация, px/с²
  const PLAT_SEL = "img,video,canvas,iframe,button,input,textarea,select,pre,table,h1,h2,h3,blockquote,[role=button],[role=img]";

  // ================= Утилиты =================
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const vw = () => document.documentElement.clientWidth || innerWidth;
  const vh = () => innerHeight;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ================= Состояние =================
  let s = { ...DEFAULTS };
  let host, shadow, el, img, spinEl, bubble, askBox, askInput;
  let curH = 140, pinned = false;
  let skin = "cloak", curPose = "", curW = 100, skinCfg = { ...BASE_CFG };
  let entering = false;
  let walkPhase = 0, jumping = false, sliding = false, maxImpact = 0, fallFrom = 0, seq = null;
  const cfgCache = {};
  let x = 0, yb = 0, vx = 0, vy = 0, rot = 0, spin = 0, dir = 1;
  let ground = "floor";          // "floor" | Element (стоит на элементе сайта) | null (в воздухе)
  let platEdges = [0, 0], edgeDecided = false;
  let state = "idle", until = 0;
  let thrown = false, bounces = 0, lastBonk = 0;
  let dragging = false, dragDX = 0, dragDY = 0, moved = false, downAt = 0, samples = [], downSel = "";
  let lastUserAct = Date.now(), lastT = performance.now(), raf = 0, greeted = false;
  let lastClick = 0, clickTimer = 0;
  let lastSel = { text: "", at: 0 }, selHinted = false, lastMathSel = "";
  let keyTimes = [], lastTypeTalk = 0;
  let pageInfo = null, lastHref = location.href;

  // Натура: хитрый манипулятор. Маска «милый» / «суровый» меняет и картинки, и речь.
  const CUTE_SKINS = { cloak: "cloak_cute", disciple: "disciple_cute" };
  let mask = "stern", maskUntil = 0, maskWhy = "";
  const face = () => (mask === "cute" && CUTE_SKINS[skin] ? CUTE_SKINS[skin] : skin);
  const url = (p) => chrome.runtime.getURL("poses/" + face() + "/" + p + ".webp");
  // какой файл рисовать для позы с учётом того, что есть в образе
  function frameOf(p) {
    for (let i = 0; i < 4 && p; i++) { if (skinCfg.has.includes(p) || POSES.includes(p)) return p; p = FALLBACK[p]; }
    return "idle";
  }
  // куда смотрит нарисованная поза: 1 — вправо, -1 — влево, 0 — анфас (не отражаем)
  function facingOf(p) {
    const f = skinCfg.faces || {};
    if (p in f) return f[p];
    if (/^w\d|^walk/.test(p)) return f.walk ?? -1;
    if (/^r\d/.test(p)) return f.run ?? f.walk ?? -1;
    return 0;
  }
  const H = () => clamp(Number(s.size) || 140, 60, 320);
  const feetPad = () => 6 * H() / 320; // прозрачный отступ под ногами в картинках

  function chooseSkin(change, keep) {
    const pool = change ? SKINS.filter((k) => k !== skin) : SKINS;
    // «случайно»: один и тот же образ во всех вкладках (хранится в curSkin), меняется раз в 10 минут
    const shared = !change && SKINS.includes(s.curSkin) ? s.curSkin : null;
    skin = SKINS.includes(s.skin) ? s.skin : keep || shared || pick(pool.length ? pool : SKINS);
    if (s.skin === "random" && skin !== s.curSkin) { s.curSkin = skin; try { chrome.storage.local.set({ curSkin: skin }); } catch {} }
    curPose = "";
    skinCfg = cfgCache[face()] || { ...BASE_CFG };
    preload(["idle", "blink", ...skinCfg.walk, ...POSES]);
    loadSkinCfg(face());
    // вторая маска того же образа — заранее, чтобы смена была мгновенной
    idle(() => { const other = face() === skin ? CUTE_SKINS[skin] : skin; if (other) loadSkinCfg(other, true); });
  }
  const loaded = new Set();
  function preload(list) { for (const p of list) { const u = url(p); if (loaded.has(u)) continue; loaded.add(u); frameImg(u); } }
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500));
  // poses/<образ>/skin.json — какие кадры есть: цикл ходьбы, падение и т.д.
  function loadSkinCfg(k, warm) {
    if (cfgCache[k]) return;
    fetch(chrome.runtime.getURL("poses/" + k + "/skin.json"))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((j) => {
        const c = { ...BASE_CFG, ...j, faces: { ...BASE_CFG.faces, ...(j.faces || {}) }, has: [...(j.has || []), ...(j.walk || [])] };
        cfgCache[k] = c;
        if (face() === k) {
          skinCfg = c;
          preload([...c.walk, ...c.has]);
          el && el.classList.toggle("cycle", c.walk.length >= 4);
        } else if (warm) {                       // прогреваем кадры второй маски
          for (const n of ["idle", "blink", ...c.walk, ...c.has]) { const u = chrome.runtime.getURL("poses/" + k + "/" + n + ".webp"); if (!loaded.has(u)) { loaded.add(u); frameImg(u); } }
        }
      });
  }

  // ================= Разметка =================
  const CSS = `
    .c { position:fixed; left:0; bottom:0; pointer-events:auto; cursor:grab; user-select:none;
         -webkit-user-drag:none; will-change:transform; touch-action:none; }
    .c.drag { cursor:grabbing; }
    .sp { transform-origin:50% 55%; will-change:transform; }
    .c img { display:block; width:auto; pointer-events:none; will-change:transform;
             filter:drop-shadow(0 4px 5px rgba(0,0,0,.25)); transform-origin:50% 100%; }
    .c.flip img { transform:scaleX(-1); }
    .c.walk img { animation:bob .36s ease-in-out infinite; }
    .c.flip.walk img { animation-name:bobf; }
    .c.breathe img { animation:breathe 3.4s ease-in-out infinite; }
    .c.flip.breathe img { animation-name:breathef; }
    .c.happy img { animation:hop .8s ease-in-out infinite; }
    .c.flip.happy img { animation-name:hopf; }
    .c.cycle.walk img { animation:none; }
    .c.drag img { animation:dangle 1s ease-in-out infinite; }
    .c.squash img { animation:squash .35s ease-out 1; }
    .c:hover img { filter:drop-shadow(0 4px 5px rgba(0,0,0,.25)) brightness(1.04); }
    .b { position:absolute; bottom:calc(100% + 10px); left:50%; translate:-50% 0;
         background:#fff; color:#222; font:600 13px/1.3 system-ui,sans-serif; padding:6px 10px;
         border-radius:12px; box-shadow:0 2px 10px rgba(0,0,0,.28); white-space:nowrap;
         opacity:0; transition:opacity .2s; pointer-events:none; cursor:default; }
    .b.long { white-space:pre-wrap; width:max-content; max-width:min(300px, 80vw); max-height:240px; overflow:auto;
              font-weight:500; text-align:left; pointer-events:auto; cursor:pointer; overscroll-behavior:contain; }
    .b::after { content:""; position:absolute; left:calc(50% - var(--s, 0px)); bottom:-6px; translate:-50% 0;
                border:6px solid transparent; border-top-color:#fff; border-bottom:0; }
    .b.long::after { display:none; }
    .b.ai { max-width:min(360px, 86vw); max-height:300px; font-size:13.5px; line-height:1.45; border:1px solid #e6e6ee; }
    .b.ai::before { content:"✕"; position:sticky; float:right; top:0; margin:-2px -4px 0 8px; color:#aaa; font-size:11px; }
    .b.on { opacity:1; }
    .c.top .b, .c.top .q { bottom:auto; top:calc(100% + 10px); }
    .c.top .b::after { bottom:auto; top:-6px; border:6px solid transparent; border-bottom-color:#fff; border-top:0; }
    .b:not(.on) { pointer-events:none; }
    .q { position:absolute; bottom:calc(100% + 10px); left:50%; translate:-50% 0; display:none;
         background:#fff; border-radius:12px; box-shadow:0 2px 10px rgba(0,0,0,.3); padding:6px; cursor:default; }
    .q.on { display:block; }
    .q input { all:unset; box-sizing:border-box; width:240px; font:500 13px/1.3 system-ui,sans-serif; color:#222;
               padding:6px 8px; border:1px solid #ddd; border-radius:8px; background:#fff; cursor:text; }
    .q small { display:block; font:11px system-ui,sans-serif; color:#888; margin:4px 2px 0; }
    .c.aura img { animation:aura 1.4s ease-in-out infinite !important; }
    @keyframes aura { 0%,100% { filter:drop-shadow(0 0 4px #ffd86b) drop-shadow(0 0 10px rgba(255,180,0,.6)) }
                      50% { filter:drop-shadow(0 0 9px #fff1b8) drop-shadow(0 0 22px rgba(255,180,0,.9)) } }
    .focus { position:fixed; inset:0; background:rgba(15,15,25,.55); backdrop-filter:blur(3px); display:grid; place-items:center; pointer-events:auto; }
    .fc { background:#fff; color:#222; border-radius:16px; padding:18px 20px; max-width:360px; box-shadow:0 10px 40px rgba(0,0,0,.35); font:14px/1.4 system-ui,sans-serif; text-align:center; }
    .fc b { font-size:20px; display:block; margin-bottom:6px; }
    .fc p { margin:0 0 12px; color:#555; }
    .fr { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; }
    .fr button { all:unset; cursor:pointer; padding:8px 12px; border-radius:10px; background:#f1f1f4; font:600 13px system-ui,sans-serif; color:#222; }
    .fr button:first-child { background:#c0392b; color:#fff; }
    .sign { position:absolute; left:50%; bottom:calc(100% + 2px); translate:-50% 0; background:#fffbe9; color:#5a3b00; border:2px solid #b8860b;
            border-radius:6px; padding:1px 6px; font:700 12px/1.3 ui-monospace,monospace; white-space:nowrap; pointer-events:none; box-shadow:0 2px 4px rgba(0,0,0,.2); }
    .c.top .sign { bottom:auto; top:calc(100% + 2px); }
    .c.flip .hat { transform:scaleX(-1); }
    .dust { position:absolute; bottom:0; width:10px; height:10px; border-radius:50%; background:rgba(170,160,150,.55); pointer-events:none; animation:dust .6s ease-out forwards; }
    @keyframes dust { 0% { opacity:.9; transform:translate(0,0) scale(.5) } 100% { opacity:0; transform:translate(var(--dx,10px),-14px) scale(1.6) } }
    .bug { position:fixed; left:0; top:0; font:20px/1 system-ui; pointer-events:none; translate:-50% -100%;
           filter:drop-shadow(0 2px 2px rgba(0,0,0,.3)); }
    .pt { position:absolute; top:4%; font:700 18px system-ui; pointer-events:none; text-shadow:0 1px 2px rgba(0,0,0,.25);
          animation:pt 1.1s ease-out forwards; opacity:0; }
    @keyframes pt { 0% { opacity:0; transform:translate(0,0) scale(.6) } 20% { opacity:1 } 100% { opacity:0; transform:translate(var(--dx,6px),-46px) scale(1.15) } }
    .mn { position:absolute; bottom:calc(100% + 8px); left:50%; translate:-50% 0; min-width:190px; padding:6px;
          background:#fff; border-radius:12px; box-shadow:0 4px 18px rgba(0,0,0,.3); display:grid; gap:2px; cursor:default; z-index:3; }
    .c.top .mn { bottom:auto; top:calc(100% + 8px); }
    .mn .mh { font:600 11px system-ui,sans-serif; color:#888; padding:4px 8px 6px; border-bottom:1px solid #eee; margin-bottom:2px; }
    .mn button { all:unset; font:500 13px/1.2 system-ui,sans-serif; color:#222; padding:7px 10px; border-radius:8px; cursor:pointer; white-space:nowrap; }
    .mn button:hover { background:#f2f2f5; }
    .z { position:absolute; right:10%; top:-4%; font:700 16px system-ui; color:#7fb2ff;
         text-shadow:0 1px 2px rgba(0,0,0,.3); animation:zzz 2.4s ease-in-out infinite; display:none; }
    .c.sleeping .z { display:block; }
    @keyframes bob { 0%,100% { transform:translateY(0) rotate(-1.5deg) } 50% { transform:translateY(-4%) rotate(1.5deg) } }
    @keyframes bobf { 0%,100% { transform:scaleX(-1) translateY(0) rotate(-1.5deg) } 50% { transform:scaleX(-1) translateY(-4%) rotate(1.5deg) } }
    @keyframes breathe { 0%,100% { transform:scale(1,1) } 50% { transform:scale(1.015,.985) } }
    @keyframes breathef { 0%,100% { transform:scale(-1,1) } 50% { transform:scale(-1.015,.985) } }
    @keyframes hop { 0%,100% { transform:translateY(0) } 50% { transform:translateY(-6%) } }
    @keyframes hopf { 0%,100% { transform:scaleX(-1) translateY(0) } 50% { transform:scaleX(-1) translateY(-6%) } }
    @keyframes dangle { 0%,100% { transform:rotate(-6deg) } 50% { transform:rotate(6deg) } }
    @keyframes squash { 0% { transform:scale(1.25,.75) } 60% { transform:scale(.92,1.08) } 100% { transform:scale(1,1) } }
    @keyframes zzz { 0%,100% { opacity:.3; translate:0 0 } 50% { opacity:1; translate:4px -8px } }
    @media (prefers-reduced-motion: reduce) { .c img, .z { animation:none !important; } }
  `;

  function build() {
    host = document.createElement("div");
    host.id = "chibi-walker-host";
    host.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;";
    const root = shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    el = document.createElement("div");
    el.className = "c";
    img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    img.addEventListener("load", fitImg);
    img.addEventListener("error", () => { if (face() !== "cloak") { skin = "cloak"; mask = "stern"; skinCfg = cfgCache.cloak || { ...BASE_CFG }; const p = curPose; curPose = ""; pose(p || "idle"); } });
    bubble = document.createElement("div");
    bubble.className = "b";
    bubble.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (bubble.classList.contains("long")) hideBubble(); });
    bubble.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

    askBox = document.createElement("div");
    askBox.className = "q";
    askInput = document.createElement("input");
    askInput.placeholder = "Вопрос?";
    askInput.maxLength = 500;
    const hint = document.createElement("small");
    hint.textContent = "Enter — спросить, Esc — закрыть";
    askBox.append(askInput, hint);
    askBox.addEventListener("pointerdown", (e) => e.stopPropagation());
    // чтобы горячие клавиши сайта (YouTube и т.п.) не ловили наш ввод
    for (const t of ["keydown", "keyup", "keypress"]) askInput.addEventListener(t, (e) => e.stopPropagation());
    askInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && askInput.value.trim()) { const q = askInput.value.trim(); closeAsk(); askQuestion(q); }
      else if (e.key === "Escape") closeAsk();
    });
    askInput.addEventListener("blur", () => setTimeout(closeAsk, 150));

    const z = document.createElement("div");
    z.className = "z";
    z.textContent = "z Z z";
    spinEl = document.createElement("div");
    spinEl.className = "sp";
    spinEl.append(img);
    el.append(bubble, askBox, z, spinEl);
    root.append(style, el);
    // появляется сразу, ещё до загрузки страницы: вешаемся на <html>, а не на <body>
    document.documentElement.appendChild(host);
    // если сайт перестроит документ и выкинет нас — возвращаемся
    new MutationObserver(() => { if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host); })
      .observe(document.documentElement, { childList: true });

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("contextmenu", openMenu);
    el.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("text/plain")) { e.preventDefault(); if (ground && curPose !== "read") pose("read"); } });
    el.addEventListener("drop", (e) => { const t = e.dataTransfer?.getData("text/plain"); if (t) { e.preventDefault(); addNote(t); } });
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("pointercancel", onUp, { passive: true });
    window.addEventListener("resize", () => { x = clamp(x, 0, Math.max(0, vw() - curW)); }, { passive: true });
    window.addEventListener("scroll", () => wake(), { passive: true });
    window.addEventListener("pointerdown", () => wake(), { passive: true });
    window.addEventListener("keydown", onKey, { passive: true });
    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("mouseup", () => setTimeout(onSelectDone, 30), { passive: true });
    document.addEventListener("fullscreenchange", applyVisibility);
    document.addEventListener("visibilitychange", () => { lastT = performance.now(); });
  }

  // ================= Размер и видимость =================
  function fitImg() {
    if (!img.naturalHeight) return;
    const h = H() * img.naturalHeight / 320; // все кадры в одном масштабе: стоящий = 320px
    img.style.height = h + "px";
    curH = h;
    curW = H() * img.naturalWidth / 320;
  }
  function applySettings(skinChanged) {
    if (skinChanged) { chooseSkin(); pose(state === "sleep" ? "sleep" : "idle"); }
    fitImg();
    applyVisibility();
  }
  const EXT_PAGE = location.protocol === "chrome-extension:";   // наша страница ошибки: страницу не «читаем»
  const siteOff = () => (s.disabledSites || []).includes(location.hostname);
  function applyVisibility() {
    const show = s.enabled && !siteOff() && !document.fullscreenElement;
    host.style.display = show ? "" : "none";
    if (show && !raf) { lastT = performance.now(); raf = requestAnimationFrame(loop); }
  }

  // ================= Позы и облачко =================
  // p — поза; look — куда он сейчас смотрит/движется (1 вправо, -1 влево)
  // кадры храним готовыми (уже декодированными) и меняем картинку, только когда новый кадр готов — без мигания
  const frameCache = new Map();
  function frameImg(u) {
    let it = frameCache.get(u);
    if (!it) {
      const im = new Image(); im.decoding = "async"; im.src = u;
      it = { im, ready: false };
      (im.decode ? im.decode() : new Promise((r) => (im.onload = r))).then(() => { it.ready = true; if (wantUrl === u) showUrl(u); }, () => {});
      frameCache.set(u, it);
    }
    return it;
  }
  let wantUrl = "", wantFlip = false, curAx = 0.5;
  // «якорь» кадра — где по ширине картинки голова (доля 0..1, из skin.json). При смене кадра
  // сдвигаем x так, чтобы голова осталась на месте: картинки разной ширины больше не дёргают его вбок.
  const axOf = (u, flip) => { const a = skinCfg.ax?.[u.slice(u.lastIndexOf("/") + 1, -5)] ?? 0.5; return flip ? 1 - a : a; };
  function showUrl(u) {
    if (img.getAttribute("src") === u) return;
    const it = frameCache.get(u);
    if (it && it.ready && it.im.naturalHeight) {      // размер нового кадра ставим сразу, до смены картинки
      const h = H() * it.im.naturalHeight / 320;
      const w = H() * it.im.naturalWidth / 320, ax = axOf(u, wantFlip);
      if (img.getAttribute("src") && !dragging) x += curAx * curW - ax * w;
      img.style.height = h + "px"; curH = h; curW = w; curAx = ax;
    }
    el.classList.toggle("flip", wantFlip);
    img.src = u;
  }
  function pose(p, look) {
    const f = frameOf(p);
    const fc = facingOf(f), lw = look ?? dir;
    const flip = fc !== 0 && lw !== 0 && Math.sign(lw) !== fc;
    if (f !== curPose) {
      curPose = f; wantFlip = flip;
      const u = url(f); wantUrl = u;
      const it = frameImg(u);
      if (it.ready || !img.getAttribute("src")) showUrl(u);   // не готов — пока остаётся прошлый кадр (разворот — вместе с новым)
      return;
    }
    if (flip === wantFlip) return;
    wantFlip = flip;
    if (img.getAttribute("src") !== wantUrl) return;          // кадр ещё грузится — развернётся вместе с ним
    const ax = axOf(wantUrl, flip);                           // тот же кадр, просто развернулся — голова на месте
    if (!dragging) x += (curAx - ax) * curW;
    curAx = ax;
    el.classList.toggle("flip", flip);
  }
  function setAnim(a) {
    el.classList.toggle("walk", a === "walk");
    el.classList.toggle("breathe", a === "breathe");
    el.classList.toggle("happy", a === "happy");
    el.classList.toggle("sleeping", state === "sleep");
  }
  // Облачко: каждое сообщение висит минимум 5 с, новые ждут в очереди (лишняя болтовня выбрасывается).
  // Приоритеты: 0 — болтовня, 1 — важное (ответ на действие, напоминание), 2 — ответ нейросети:
  // его ничто не перебивает, он висит, пока не прочитаешь (по длине текста), и закрывается кликом.
  const MIN_SHOW = 5000;
  let bubblePrio = -1, bubbleMinUntil = 0, sayQueue = [];
  const bubbleBusy = () => bubble.classList.contains("on");
  function readTime(text, prio) {
    const n = text.length;
    return prio >= 2 ? clamp(8000 + n * 90, 8000, 90000) : clamp(2500 + n * 75, MIN_SHOW, 30000);
  }
  function say(text, ms, opt = {}) {
    if (!text || (!s.bubbles && !opt.force && !opt.ai)) return;
    const prio = opt.ai ? 2 : opt.force ? 1 : 0;
    const now = performance.now();
    if (bubbleBusy()) {
      const locked = bubblePrio >= 2 || now < bubbleMinUntil;   // ответ нейросети или ещё не прошло 5 с
      if (locked && !(prio > bubblePrio && bubblePrio < 2) && !(prio === 2 && bubblePrio === 2)) {
        if (prio === 0) { if (!sayQueue.some((q) => q[2].prio0)) sayQueue.push([text, ms, { ...opt, prio0: true }]); }
        else { sayQueue = sayQueue.filter((q) => !q[2].prio0); sayQueue.push([text, ms, opt]); }
        if (sayQueue.length > 3) sayQueue.shift();
        return;
      }
    }
    show(text, ms, opt, prio);
  }
  function show(text, ms, opt, prio) {
    bubble.textContent = text;
    bubble.classList.toggle("long", !!opt.long || prio >= 2 || text.length > 42);
    bubble.classList.toggle("ai", prio >= 2);
    bubble.title = prio >= 2 ? "клик — закрыть" : "";
    bubble.scrollTop = 0;
    bubble.classList.add("on");
    placeBubble();
    bubblePrio = prio;
    const dur = Math.max(prio >= 2 ? 0 : MIN_SHOW, ms && prio < 2 ? ms : readTime(text, prio));
    bubbleMinUntil = performance.now() + (prio >= 2 ? dur : MIN_SHOW);
    clearTimeout(say.t);
    say.t = setTimeout(hideBubble, dur);
    if (!text.startsWith("🎤") && !text.startsWith("…")) speak(text);
  }
  function hideBubble() {
    bubble.classList.remove("on", "ai"); clearTimeout(say.t); bubblePrio = -1; bubbleMinUntil = 0;
    // следующее из очереди — после короткой паузы
    clearTimeout(hideBubble.q);
    hideBubble.q = setTimeout(() => { const q = sayQueue.shift(); if (q && !bubbleBusy()) say(...q); }, 600);
  }
  // облачко не должно вылезать за края экрана
  function placeBubble() { keepOnScreen(bubble); }
  function keepOnScreen(box) {
    box.style.translate = "-50% 0";
    box.style.setProperty("--s", "0px");
    const r = box.getBoundingClientRect();
    let shift = 0;
    if (r.left < 8) shift = 8 - r.left;
    else if (r.right > vw() - 8) shift = vw() - 8 - r.right;
    box.style.translate = `calc(-50% + ${shift}px) 0`;
    box.style.setProperty("--s", shift + "px");
  }

  // ================= Поведение =================
  function go(next, ms) {
    state = next;
    until = performance.now() + ms;
    switch (next) {
      case "walk":
        if (Math.random() < 0.5) dir = -dir;
        if (x < 20) dir = 1;
        if (x > vw() - curW - 20) dir = -1;
        edgeDecided = false;
        walkPhase = 0;
        setAnim("walk");
        break;
      case "idle": pose("idle"); setAnim("breathe"); break;
      case "sleep": pose("sleep"); setAnim("breathe"); break;
      case "perch": pose("sit"); setAnim("breathe"); break;
      case "watch": pose(Math.random() < 0.5 ? "read" : "sit"); setAnim("breathe"); break;
      case "emote": {
        const e = pick(mask === "cute" ? CUTE_EMOTES : EMOTES);
        pose(e);
        setAnim(e === "laugh" || e === "cool" || e === "wave" || e === "pet" ? "happy" : "breathe");
        if (Math.random() < 0.25 && !bubbleBusy()) say(mask === "cute" ? pick(CUTE_PHRASES) : s.pageTalk && pageInfo && Math.random() < 0.6 ? topicLine() : pick(PHRASES));
        break;
      }
      case "react": setAnim("happy"); break;  // позу ставит тот, кто вызвал
      case "chase": setAnim(""); break;
      case "hold": setAnim("breathe"); break; // ждёт ответа нейросети
    }
  }
  let bornAt = performance.now();
  function nextState() {
    // первые секунды на странице — спокойно: стоит, моргает, оглядывается
    const age = performance.now() - bornAt;
    if (age < 7000) { Math.random() < 0.7 ? go("idle", rnd(2000, 3500)) : go("emote", rnd(2500, 4000)); return; }
    if (s.sleepIdle && Date.now() - lastUserAct > 90000) return go("sleep", 30000);
    if (videoPlaying() && Math.random() < 0.35) { go("watch", rnd(6000, 12000)); if (Math.random() < 0.3) say(pick(["Смотрю.", "Хм.", "Перемотай."])); return; }
    const r = Math.random();
    const brk = breakNow();
    if (ground && (brk ? Math.random() < 0.35 : Math.random() < 0.04)) { meditate(rnd(8000, 15000)); return; }
    if (afterWork() && Math.random() < 0.08) say(pick(["День окончен. Отдыхай.", "Поздно. Заканчивай.", "Пора домой."]), 2500);
    if (s.physics && s.platforms && r < 0.14 && tryJump()) return;
    if (canFly() && age > 15000 && ground === "floor" && Math.random() < 0.07) { flyRandom(); return; }
    if (s.explore && age > 15000 && r >= 0.14 && r < 0.36 && Date.now() - lastExplore > 12000 && startExplore()) return;
    // курсор недавно двигался — иногда бежит к нему (обиженный — убегает)
    if (age > 15000 && r > 0.86 && Date.now() - mouseAt < 4000 && mouseY > vh() * 0.4) { walkPhase = 0; go("chase", 6000); return; }
    if (r < 0.55) go("walk", rnd(3000, 9000));
    else if (r < 0.78) go("idle", rnd(2500, 6000));
    else go("emote", rnd(3500, 7000));
  }
  function wake() {
    lastUserAct = Date.now();
    if (state === "sleep") { pose("shock"); go("react", 1200); say("Я не спал."); }
  }
  function onKey() {
    wake();
    const now = Date.now();
    keyTimes.push(now);
    while (keyTimes.length && now - keyTimes[0] > 8000) keyTimes.shift();
    if (s.pageTalk && keyTimes.length > 40 && now - lastTypeTalk > 120000 && ground && state !== "hold") {
      lastTypeTalk = now;
      pose("cool"); go("react", 2200);
      say(pick(["Темп хороший.", "Быстро.", "Продолжай."]));
    }
  }
  function videoPlaying() {
    for (const v of document.querySelectorAll("video")) if (!v.paused && !v.ended && v.offsetWidth > 200) return true;
    return false;
  }

  // ================= Живость: моргание, бег за курсором, стены, вис, поглаживание, меню, настроение =================
  const has = (p) => skinCfg.has.includes(p);
  let mouseX = -1, mouseY = -1, mouseAt = 0;
  let blinkAt = 0, blinkEnd = 0;
  let wallSide = 0, climbTarget = 0, climbPhase = 0, hangPhase = 0;

  window.addEventListener("pointermove", (e) => { mouseX = e.clientX; mouseY = e.clientY; mouseAt = Date.now(); }, { passive: true });

  // --- частицы: сердечки, искры, крошки ---
  function particles(ch, n = 3, color = "#ff4d6d") {
    for (let i = 0; i < n; i++) {
      const p = document.createElement("span");
      p.className = "pt";
      p.textContent = ch;
      p.style.color = color;
      p.style.left = (35 + Math.random() * 30) + "%";
      p.style.animationDelay = (i * 0.12) + "s";
      p.style.setProperty("--dx", rnd(-18, 18).toFixed(0) + "px");
      p.addEventListener("animationend", () => p.remove());
      el.appendChild(p);
    }
  }

  // --- моргание в покое ---
  function blinkTick(t) {
    if (!has("blink")) return;
    if (blinkEnd && t > blinkEnd) { blinkEnd = 0; if (curPose === "blink") pose("idle"); }
    if (state === "idle" && curPose === "idle" && t > blinkAt) {
      pose("blink"); blinkEnd = t + 140;
      blinkAt = t + (Math.random() < 0.2 ? 260 : rnd(2500, 5500)); // иногда моргает дважды
    }
  }

  // --- бег: к курсору (или от него, если обижен) ---
  function runFrames() { return skinCfg.run || skinCfg.walk; }
  function runFps() { return skinCfg.run ? skinCfg.runFps || 13 : skinCfg.walkFps * 1.5; }
  const runSpeed = () => (skinCfg.run ? 190 : 120) * (Number(s.speed) || 1) * (H() / 140);
  function chaseTick(dt, t) {
    const target = clamp(mouseX - curW / 2, 0, Math.max(0, vw() - curW));
    const dx = target - x;
    if (Math.abs(dx) < 14 || t > until) {
      pose("idle"); go("react", 1600); if (Math.random() < 0.4) say(pick(["Здесь.", "Что?", "Звал?"]));
      return;
    }
    dir = Math.sign(dx);
    walkPhase += dt * runFps();
    const fr = runFrames();
    pose(fr[Math.floor(walkPhase) % fr.length], dir);
    x += dir * Math.min(Math.abs(dx), runSpeed() * dt);
  }

  // --- лазание по стене окна ---
  function startClimb(side) {
    wallSide = side; climbPhase = 0; dir = side;
    climbTarget = rnd(140, Math.max(160, vh() - H() * 1.05));
    ground = null; vy = vx = 0; state = "climb"; setAnim("");
  }
  function climbTick(dt) {
    const maxX = Math.max(0, vw() - curW);
    x = wallSide > 0 ? maxX : 0;
    climbPhase += dt * 3.2 * Math.sqrt(Number(s.speed) || 1);
    pose(Math.floor(climbPhase) % 2 ? "climb2" : "climb1", wallSide);
    yb += 42 * (Number(s.speed) || 1) * dt * (H() / 140);
    const top = vh() - curH;
    if (yb >= top - 2) { yb = top; startHang(); return; }
    if (yb >= climbTarget) {
      if (Math.random() < 0.5 && has("hang1")) { climbTarget = top; return; } // лезет до самого верха
      say(pick(["Хм.", "Спускаюсь.", "…"]), 1200);
      launch(-wallSide * rnd(120, 320), rnd(150, 450), false);
    }
  }

  // --- вис на верхнем крае окна ---
  function startHang() {
    state = "hang"; hangPhase = 0; until = performance.now() + rnd(3500, 8000);
    ground = null; vy = vx = 0; setAnim("");
    if (Math.random() < 0.5) say(pick(["Обзор неплох.", "…", "Тренировка хвата."]), 1600);
  }
  function hangTick(dt, t) {
    hangPhase += dt * 1.8;
    pose(Math.floor(hangPhase) % 2 ? "hang2" : "hang1", 0);
    yb = vh() - curH;
    x = clamp(x + (wallSide ? -wallSide * 30 * dt : 0), 0, Math.max(0, vw() - curW)); // чуть отползает от угла
    if (t > until) { say(pick(["Хватит.", "…", "Спуск."]), 1000); launch(rnd(-80, 80), 0, false); }
  }

  // --- меню по правому клику ---
  let menu = null;
  function openMenu(e) {
    e.preventDefault(); e.stopPropagation();
    closeMenu();
    menu = document.createElement("div");
    menu.className = "mn";
    const items = [
      [s.pinTop ? "📍" : "📌", s.pinTop ? "Открепить" : "Закрепить наверху", () => { pinned = false; setPinned(!s.pinTop); if (!s.pinTop) launch(0, 0, false); }],
      ["💤", state === "sleep" ? "Разбудить" : "Уложить спать", () => { if (state === "sleep") wake(); else if (ground) { lastUserAct = 0; go("sleep", 30000); say("Отдохну.", 1500); } }],
      ["❓", "Спросить…", () => openAsk()],
      ["📊", "Отчёт за сегодня", () => dayReport()],
      ["🍅", pomoState && pomoState.end > Date.now() ? "Остановить помидор" : "Помидор 25/5", () => pomoToggle()],
      ["🎤", "Спросить голосом", () => voiceAsk()],
      ["🌤", "Погода", () => weatherSay(true)],
      ["🧘", "Медитировать", () => meditate(12000)],
      ...(canFly() ? [["🕊", "Полетать", () => flyRandom(true)]] : []),
      ["📜", `Заметки (${notes.length})`, () => setTimeout(notesMenu, 0)],
      ["🚫", "Спрятать на этом сайте", () => { try { chrome.storage.local.get({ disabledSites: [] }, (v) => chrome.storage.local.set({ disabledSites: [...new Set([...v.disabledSites, location.hostname])] })); } catch {} }],
    ];
    const head = document.createElement("div");
    head.className = "mh";
    head.textContent = realmName(levelOf(stats.xp || 0).lvl);
    menu.appendChild(head);
    for (const [ic, label, fn] of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = ic + "  " + label;
      b.addEventListener("click", (ev) => { ev.stopPropagation(); closeMenu(); fn(); });
      menu.appendChild(b);
    }
    menu.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    el.appendChild(menu);
    keepOnScreen(menu);
    setTimeout(() => window.addEventListener("pointerdown", closeMenu, { once: true }), 0);
  }
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); }, { passive: true });

  // Лёгкое чтение текста страницы: без innerText (он пересчитывает раскладку всей страницы), с ограничением объёма
  function textSample(root, max = 20000) {
    root = root || document.body;
    if (!root) return "";
    let out = "", n = 0;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/i.test(t.parentNode?.nodeName || "") || (host && host.contains(t))) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (w.nextNode() && out.length < max && n++ < 6000) {
      const v = w.currentNode.nodeValue;
      if (v && v.trim()) out += v.replace(/\s+/g, " ") + " ";
    }
    return out.slice(0, max);
  }
  const textOf = (e, max = 300) => (e ? (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, max) : "");

  // ================= Понимание кода и текста (офлайн, без нейросети) =================
  const STOP = new Set(("и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее её мне было вот от меня еще ещё нет о из ему теперь когда даже ну ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех можно при об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя свою этой перед иногда лучше чуть том такой более всегда конечно между это также такие которые который которая которых является может году года лет очень просто " +
    "the and for that this with from have are was were will would your you they them their there what which when where who how why not but can all any been more most other some such than then into over also just only its our out about after before between both each few here same very these those through under while being does doing did had has having should could may might must one two use used using make made get got new like time") .split(/\s+/));

  function langOfText(t) {
    const cyr = (t.match(/[а-яё]/gi) || []).length, lat = (t.match(/[a-z]/gi) || []).length;
    if (/[oʻgʻ]ʻ|o'z|g'|\b(va|bilan|uchun|emas|ham|bu|men|siz|qilish|bo'lib|yoki)\b/i.test(t) && lat > cyr) return "uz";
    if (/[ўқғҳ]/i.test(t)) return "uz";
    if (cyr > lat * 1.5) return "ru";
    if (lat > cyr * 1.5) return "en";
    return "mixed";
  }
  function keywords(t, n = 4) {
    const f = new Map();
    for (const w of (t.toLowerCase().match(/[a-zа-яёўқғҳ][a-zа-яёўқғҳ'-]{3,}/g) || [])) {
      if (STOP.has(w) || w.length > 22) continue;
      f.set(w, (f.get(w) || 0) + 1);
    }
    return [...f.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
  }
  const wordCount = (t) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  const readMin = (w) => Math.max(1, Math.round(w / 200));
  function firstSentence(t, max = 150) {
    const m = t.replace(/\s+/g, " ").trim().match(/^.{20,}?[.!?](\s|$)/);
    const s1 = (m ? m[0] : t).trim();
    return s1.length > max ? s1.slice(0, max - 1) + "…" : s1;
  }

  // --- код ---
  const LANGS = [
    ["Python", /^\s*(def|class|import|from|elif|async def)\b|^\s*@\w+|self\.|print\(|:\s*$/m],
    ["TypeScript", /:\s*(string|number|boolean|any|void|unknown)\b|\binterface\s+\w+|\btype\s+\w+\s*=|<\w+>\(/],
    ["JavaScript", /\b(const|let|var|function|=>|console\.log|require\(|document\.|window\.)|import .* from|export (default|const|function)/],
    ["PHP", /<\?php|\$\w+\s*=|->\w+\(|\becho\s|\bfunction\s+\w+\s*\(\$/],
    ["SQL", /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE|WHERE|JOIN|GROUP BY)\b/i],
    ["HTML", /<\/?(div|span|html|body|head|a|p|ul|li|section|button|input|script)\b[^>]*>/i],
    ["CSS", /^[\s.#\w-]+[\w\])-]\s*\{[^}]*:[^}]*;?\s*\}?/m],
    ["Bash", /^\s*(\$ |sudo |apt(-get)? |cd |ls |chmod |chown |echo |export |npm |pip |git |docker |curl |wget |systemctl )/m],
    ["JSON", /^\s*[[{]\s*"[^"]+"\s*:/],
    ["Go", /\bfunc\s+(\(\w+ \*?\w+\)\s*)?\w+\(|\bpackage\s+\w+|:=/],
    ["Rust", /\bfn\s+\w+|\blet\s+mut\b|\bimpl\b|println!\(/],
    ["Java/C#", /\b(public|private|protected)\s+(static\s+)?(void|class|int|String|bool|var)\b/],
    ["C/C++", /#include\s*[<"]|\bstd::|\bprintf\(|\bint\s+main\s*\(/],
  ];
  function looksLikeCode(t) {
    const lines = t.split("\n");
    const sig = (t.match(/[;{}()=<>[\]]/g) || []).length / Math.max(1, t.length);
    return (lines.length > 1 && sig > 0.03) || LANGS.some(([, re]) => re.test(t)) && sig > 0.015;
  }
  function stripStrings(code) {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/^\s*#(?!include).*$/gm, "")
      .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""');
  }
  function analyzeCode(code) {
    code = code.slice(0, 20000);
    let lang = "код", best = 0;
    for (const [name, re] of LANGS) {
      const n = (code.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || []).length;
      if (n > best) { best = n; lang = name; }
    }
    if (lang === "JavaScript" && /:\s*(string|number|boolean)\b|\binterface\s/.test(code)) lang = "TypeScript";
    const lines = code.split("\n");
    const loc = lines.filter((l) => l.trim()).length;
    const funcs = [...new Set([...code.matchAll(/(?:\bdef|\bfunction|\bfunc|\bfn)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g)].map((m) => m[1] || m[2]))];
    const classes = [...new Set([...code.matchAll(/\bclass\s+([A-Z]\w*)/g)].map((m) => m[1]))];
    const issues = [];
    const bare = stripStrings(code);
    const bal = (o, c) => (bare.split(o).length - 1) - (bare.split(c).length - 1);
    const br = [["(", ")", "круглых"], ["{", "}", "фигурных"], ["[", "]", "квадратных"]].map(([o, c, nm]) => [bal(o, c), nm]).filter(([d]) => d !== 0);
    if (/(api[_-]?key|secret|passw(or)?d|token|private[_-]?key)\s*[:=]\s*["'`][^"'`\s]{6,}/i.test(code)) issues.push("ключ или пароль прямо в коде — убери в .env");
    if (/\b(SELECT|UPDATE|DELETE|INSERT)\b[^;\n]*(["'`]\s*\+\s*\w|\$\{|%s|\{\w+\})/i.test(code)) issues.push("SQL склеивается из переменных — риск инъекции, используй параметры");
    if (br.length && loc > 2) issues.push(br.map(([d, nm]) => `${nm} скобок ${d > 0 ? "открыто" : "закрыто"} на ${Math.abs(d)} больше`).join(", ") + " — проверь");
    if (/\beval\s*\(/.test(bare)) issues.push("eval() — опасно, лучше без него");
    if (/catch\s*\([^)]*\)\s*\{\s*\}|except\s*:\s*pass|except\s+\w+\s*:\s*pass/.test(code)) issues.push("ошибка ловится и молча глотается — хотя бы залогируй");
    if (/def\s+\w+\([^)]*=\s*(\[\]|\{\})/.test(code)) issues.push("изменяемое значение по умолчанию (=[] или ={}) — классическая ловушка Python");
    if (/\bexcept\s*:/.test(code)) issues.push("голый except: ловит вообще всё, даже Ctrl+C");
    const todo = (code.match(/\b(TODO|FIXME|HACK|XXX)\b/g) || []).length;
    if (todo) issues.push(`вижу ${todo > 1 ? todo + " " : ""}TODO/FIXME — не забудь доделать`);
    const dbg = (code.match(/console\.(log|debug)\(|\bprint\(|var_dump\(|\bdd\(|\bdebugger\b/g) || []).length;
    if (dbg >= 2 || (dbg && lang !== "Python")) issues.push(`${dbg} отладочных вывод${dbg === 1 ? "" : "а"} (console.log/print) — убери перед коммитом`);
    if ((lang === "JavaScript" || lang === "TypeScript") && /[^=!<>]==[^=]/.test(bare)) issues.push("== вместо === — сравнение с приведением типов");
    if ((lang === "JavaScript" || lang === "TypeScript") && /\bvar\s/.test(bare)) issues.push("var? в 2026-м лучше let/const");
    if (/:\s*any\b/.test(code) && lang === "TypeScript") issues.push("any в TypeScript — типизация теряется");
    const longL = lines.filter((l) => l.length > 120).length;
    if (longL >= 2) issues.push(`${longL} длинных строк (>120 символов) — читать тяжело`);
    const depth = Math.max(0, ...lines.map((l) => (l.match(/^\s*/)[0].replace(/\t/g, "    ").length)));
    if (depth >= 24) issues.push("очень глубокая вложенность — может, вынести в функции?");
    const comments = (code.match(/^\s*(\/\/|#(?!include)|--|\/\*|\*)/gm) || []).length;
    const praise = [];
    if (!issues.length) {
      if (loc <= 25 && funcs.length) praise.push("Короткая функция. Правильно.");
      if (comments >= 2) praise.push("Комментарии есть. Хорошо.");
      if (/\b(test|it|describe|assert)\s*\(|def test_/.test(code)) praise.push("Тесты есть. Достойно.");
      if (!praise.length) praise.push(pick(["Чисто.", "Ошибок не вижу.", "Аккуратно.", "Сойдёт."]));
    }
    return { lang, loc, funcs, classes, issues, praise };
  }
  function codeComment(code) {
    const a = analyzeCode(code);
    const what = [a.lang === "код" ? "это код" : `это ${a.lang}`, `${a.loc} строк${a.loc % 10 === 1 && a.loc % 100 !== 11 ? "а" : [2, 3, 4].includes(a.loc % 10) && ![12, 13, 14].includes(a.loc % 100) ? "и" : ""}`];
    if (a.classes.length) what.push(`класс ${a.classes.slice(0, 2).join(", ")}`);
    if (a.funcs.length) what.push(`функци${a.funcs.length > 1 ? "и" : "я"} ${a.funcs.slice(0, 3).map((f) => f + "()").join(", ")}${a.funcs.length > 3 ? "…" : ""}`);
    return what.join(", ") + ".\n" + (a.issues.length ? "⚠ " + a.issues.slice(0, 2).join("\n⚠ ") : a.praise[0]);
  }

  // --- выделенный текст: маленькие помощники для программиста ---
  function selectionFacts(t) {
    const s1 = t.trim();
    // JSON
    if (/^[[{]/.test(s1) && /[\]}]$/.test(s1)) {
      try {
        const j = JSON.parse(s1);
        const keys = Array.isArray(j) ? `массив из ${j.length} элементов` : `${Object.keys(j).length} ключей: ${Object.keys(j).slice(0, 4).join(", ")}${Object.keys(j).length > 4 ? "…" : ""}`;
        return { auto: true, text: `JSON валидный ✅ ${keys}` };
      } catch (e) {
        const pos = /position (\d+)/.exec(e.message)?.[1];
        return { auto: true, text: `JSON с ошибкой ❌${pos ? ` около символа ${pos}` : ""}: ${short(e.message, 60)}` };
      }
    }
    // время Unix
    if (/^\d{10}(\d{3})?$/.test(s1)) {
      const ms = s1.length === 13 ? +s1 : +s1 * 1000;
      const d = new Date(ms);
      if (d.getFullYear() > 1990 && d.getFullYear() < 2100) return { auto: true, text: `🕒 ${d.toLocaleString("ru-RU")}` };
    }
    // цвет
    const col = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s1) || /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s1);
    if (col) return { auto: true, text: `🎨 цвет ${s1} — ${colorName(s1)}`, color: s1 };
    // base64
    if (s1.length >= 12 && s1.length <= 4000 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(s1) && s1.length % 4 !== 1) {
      try {
        const bin = atob(s1.replace(/-/g, "+").replace(/_/g, "/"));
        const txt = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
        if (/^[\p{L}\p{N}\p{P}\p{Zs}\n\r\t{}<>$=+*/\\|~^`'"-]+$/u.test(txt) && txt.length > 3) return { auto: true, text: `base64 → «${short(txt, 80)}»` };
      } catch {}
    }
    // JWT
    if (/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(s1)) {
      try { const p = JSON.parse(atob(s1.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); return { auto: true, text: `JWT 🔑 поля: ${Object.keys(p).slice(0, 5).join(", ")}${p.exp ? `, истекает ${new Date(p.exp * 1000).toLocaleString("ru-RU")}` : ""}` }; } catch {}
    }
    const dev = devFacts(t);
    if (dev) return dev;
    // ссылка
    if (/^https?:\/\/\S+$/i.test(s1)) {
      try { const u = new URL(s1); const q = [...u.searchParams.keys()]; return { auto: false, text: `ссылка на ${u.hostname}${u.pathname.length > 1 ? `, путь ${short(u.pathname, 30)}` : ""}${q.length ? `, параметры: ${q.slice(0, 4).join(", ")}` : ""}` }; } catch {}
    }
    if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(s1)) return { auto: false, text: `это почта, домен ${s1.split("@")[1]} ✉️` };
    // список чисел
    const nums = s1.match(/-?\d+(?:[.,]\d+)?/g);
    if (nums && nums.length >= 3 && nums.join("").length > s1.replace(/[\s,;|]/g, "").length * 0.6) {
      const v = nums.map((n) => parseFloat(n.replace(",", ".")));
      const sum = v.reduce((a, b) => a + b, 0), r = (x) => parseFloat(x.toPrecision(10));
      return { auto: true, text: `${v.length} чисел: сумма ${r(sum)}, среднее ${r(sum / v.length)}, мин ${Math.min(...v)}, макс ${Math.max(...v)}` };
    }
    // код
    if (looksLikeCode(t)) return { auto: false, text: codeComment(t), long: true };
    // текст
    const w = wordCount(t);
    if (w >= 25) {
      const kw = keywords(t, 3), lang = { ru: "по-русски", en: "по-английски", uz: "по-узбекски", mixed: "на смеси языков" }[langOfText(t)];
      return { auto: false, long: true, text: `${w} слов ${lang}, ~${readMin(w)} мин чтения.${kw.length ? `\nглавные слова: ${kw.join(", ")}` : ""}\nначало: «${firstSentence(t, 110)}»` };
    }
    if (w >= 1) return { auto: false, text: `${w} ${w === 1 ? "слово" : w < 5 ? "слова" : "слов"}, ${s1.length} символов${/\d/.test(s1) ? ", есть цифры" : ""}` };
    return null;
  }
  function colorName(c) {
    let r, g, b;
    const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (h) { let x = h[1]; if (x.length === 3) x = x.replace(/./g, "$&$&"); [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); }
    else [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 510;
    if (mx - mn < 18) return l > 0.85 ? "почти белый" : l < 0.15 ? "почти чёрный" : "серый";
    let hue = mx === r ? ((g - b) / (mx - mn)) * 60 : mx === g ? (2 + (b - r) / (mx - mn)) * 60 : (4 + (r - g) / (mx - mn)) * 60;
    hue = (hue + 360) % 360;
    const names = [[15, "красный"], [40, "оранжевый"], [65, "жёлтый"], [160, "зелёный"], [200, "бирюзовый"], [250, "синий"], [290, "фиолетовый"], [335, "розовый"], [360, "красный"]];
    const nm = names.find(([hh]) => hue < hh)[1];
    return (l > 0.75 ? "светло-" : l < 0.3 ? "тёмно-" : "") + nm;
  }

  // --- чтение страницы: собираем «факты», которые он потом рассказывает ---
  const PRIVATE_HOST = /mail\.|outlook|telegram|web\.whatsapp|instagram\.com\/direct|vk\.com\/im|bank|click\.uz|payme|paynet|uzum\.uz\/.*(cart|checkout)|accounts\.|login|signin|auth/i;
  let pageFacts = null;
  function readPage() {
    if (pageFacts) return pageFacts;
    if (EXT_PAGE) return (pageFacts = []);
    const F = [];
    const host2 = location.hostname.replace(/^www\./, ""), path = location.pathname;
    const title = shortTitle();
    const priv = PRIVATE_HOST.test(location.hostname + path) || !!document.querySelector("input[type=password]");
    // сайты, которые он узнаёт «в лицо»
    if (/github\.com$/.test(host2)) {
      const [, owner, repo, kind, num] = path.split("/");
      if (kind === "pull" && num) F.push(`PR #${num}. Проверь тесты.`, `PR #${num}. Конфликты?`);
      else if (kind === "issues" && num) F.push(`Issue #${num}. Охота на баг.`);
      else if (kind === "actions") F.push("CI. Проверь, что зелёный.");
      else if (kind === "blob") { const f = path.split("/").pop(); F.push(`Файл ${f}.`, `${f}. Есть что улучшить.`); }
      else if (kind === "commits") F.push("История коммитов.");
      else if (owner && repo) F.push(`репозиторий ${owner}/${repo}`, `${repo}.`);
    } else if (/youtube\.com$/.test(host2) && /watch/.test(path)) {
      const t = (document.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "");
      if (t) F.push(`Видео: «${short(t, 40)}».`, `«${short(t, 34)}». Полезно?`);
    } else if (/stackoverflow\.com|stackexchange\.com/.test(host2)) {
      const q = textOf(document.querySelector("h1"), 120);
      if (q) F.push(`Вопрос: «${short(q, 60)}». Ответ нашёл?`, "Смотри принятый ответ, не первый.");
    } else if (/wikipedia\.org$/.test(host2)) {
      const p = [...document.querySelectorAll("#mw-content-text p")].find((x) => textOf(x, 400).length > 60);
      if (p) F.push(firstSentence(textOf(p, 600), 160));
    } else if (/google\.|yandex\.|bing\.com|duckduckgo/.test(host2)) {
      const q = new URLSearchParams(location.search).get("q") || new URLSearchParams(location.search).get("text");
      if (q) F.push(`Ищешь «${short(q, 40)}».`, `«${short(q, 30)}». Уточни запрос.`);
    } else if (/uzse\.uz|tradingview|investing\.com/.test(host2)) {
      F.push("Графики. Без эмоций.", "Падение — не повод паниковать.");
    }
    // общее чтение (не на личных страницах вроде почты, мессенджеров, банков)
    if (!priv) {
      const main = document.querySelector("article, main, [role=main], #content, .content") || document.body;
      const text = textSample(main, 30000);
      const w = wordCount(text);
      const lang = langOfText(text);
      if (lang === "uz") F.push("По-узбекски.", "O'zbekcha.");
      else if (lang === "en" && w > 150) F.push("Текст на английском.");
      if (w > 700) {
        const kw = keywords(text, 3);
        F.push(`Статья: ~${w} слов, ~${readMin(w)} мин.`);
        if (kw.length) F.push(`Тема: ${kw.join(", ")}.`, `Ключевое: ${kw.join(", ")}.`);
      }
      const pres = [...document.querySelectorAll("pre, code")].filter((p) => (p.textContent || "").length > 60).slice(0, 12);
      if (pres.length) {
        const langs = {};
        pres.forEach((p) => { const l = analyzeCode(p.textContent || "").lang; langs[l] = (langs[l] || 0) + 1; });
        const top = Object.entries(langs).sort((a, b) => b[1] - a[1])[0];
        F.push(pres.length > 1 ? `${pres.length} блоков кода${top && top[0] !== "код" ? `, в основном ${top[0]}` : ""}.` : `Код на странице${top && top[0] !== "код" ? ` (${top[0]})` : ""}.`);
      }
      const imgs = [...document.images].filter((i) => i.naturalWidth > 150).length;
      if (imgs > 15) F.push(`${imgs} картинок. Тяжёлая страница.`);
      const inputs = document.querySelectorAll("input:not([type=hidden]), textarea, select").length;
      if (inputs > 8) F.push(`${inputs} полей. Не спеши.`);
      const tbl = document.querySelectorAll("table").length;
      if (tbl && /\d{3,}/.test(textOf(document.querySelector("table"), 500))) F.push("Таблица. Проверь итоги.");
      const links = document.links.length;
      if (links > 300) F.push(`${links} ссылок. Не утони.`);
    }
    if (title && F.length < 2) F.push(`«${title}».`);
    return (pageFacts = F);
  }

  // ================= Исследователь страницы (без нейросети) =================
  // Сам находит на странице кнопки, поля ввода, картинки, цены, код и видео,
  // идёт к ним, запрыгивает сверху и комментирует. На поле, в котором ты печатаешь, — садится и смотрит.
  const EX_SEL = "input,textarea,[contenteditable=true],button,[role=button],a[href],img,video,pre,select,[class*=price],[itemprop=price],h1,h2";
  const BTN_RULES = [
    ["buy", /купить|в корзину|оформить|заказать|buy|add to cart|checkout|order|sotib|savat|xarid/i],
    ["login", /войти|вход|log ?in|sign ?in|kirish/i],
    ["signup", /регистрац|зарегистр|sign ?up|create account|ro.yxat/i],
    ["subscribe", /подпис|subscribe|follow|obuna/i],
    ["download", /скачать|загрузить|download|yuklab/i],
    ["send", /отправить|опубликовать|send|submit|post|yubor/i],
    ["delete", /удалить|delete|remove|o.chir/i],
    ["like", /нравится|лайк|like|♥|❤/i],
    ["close", /^(×|✕|x)$|закрыть|close|отмена|cancel/i],
    ["more", /ещё|еще|далее|подробнее|more|next|show|batafsil/i],
    ["play", /смотреть|играть|play|watch|▶/i],
  ];
  const SAY = {
    buy: ["«T». Тебе это нужно?", "Покупка. Подумай.", "«T» — кошелёк не бездонный."],
    login: ["Вход. Пароль — твоё дело.", "«T». Двухфакторка включена?"],
    signup: ["Ещё одна регистрация.", "«T». Запомни пароль."],
    subscribe: ["«T». Решай сам."],
    download: ["«T». Проверь источник.", "Скачивай. Я подожду."],
    send: ["«T». Уверен?", "Отправляй."],
    delete: ["«T» — это навсегда.", "Бэкап сделал?"],
    like: ["Лайк. Как хочешь."],
    close: ["Закрыть — правильно."],
    more: ["«T». Посмотрим."],
    play: ["«T». Недолго."],
    button: ["Кнопка «T».", "«T». Нажимать не обязательно."],
    search: ["Поиск. Формулируй точно.", "Ищи."],
    input: ["Поле ввода.", "Пиши. Я смотрю."],
    image: ["Картинка.", "«T»."],
    video: ["Видео. Недолго."],
    code: ["Код. Разберу."],
    price: ["T. Дорого.", "T. Подумай ещё раз.", "T. Поищи дешевле."],
    heading: ["«T».", "«T». Хм."],
    select: ["Выбирай с умом."],
    link: ["Ссылка «T»."],
  };
  let exTarget = null, exCat = "", exText = "", lastExplore = 0, lastClickTalk = 0;
  let watchInput = null, typedInWatch = 0;

  const isTextInput = (e) => e && (e.matches?.("textarea,[contenteditable=true],[contenteditable='']") ||
    (e.tagName === "INPUT" && /^(text|search|email|url|number|tel|password|)$/i.test(e.type || "")));
  const label = (e) => (e.getAttribute?.("aria-label") || textOf(e, 120) || e.value || e.title || e.placeholder || e.alt || "")
    .replace(/\s+/g, " ").trim();
  const short = (t, n = 26) => (t.length > n ? t.slice(0, n - 1).trim() + "…" : t);
  const PRICE_RE = /(\d[\d\s.,]*\s?(₽|руб|so.m|сум|sum|uzs|\$|€|£|usd|eur))|((\$|€|£)\s?\d[\d.,]*)/i;

  function classify(e) {
    const tag = e.tagName;
    const t = label(e);
    if (tag === "INPUT" || tag === "TEXTAREA" || e.isContentEditable) {
      if (e.type === "password") return ["login", t];
      if (/^(checkbox|radio|range|hidden|file|color)$/i.test(e.type)) return null;
      if (/^(submit|button)$/i.test(e.type)) return [btnCat(t), t];
      const hint = (e.type + " " + (e.name || "") + " " + (e.placeholder || "") + " " + (e.getAttribute("aria-label") || "")).toLowerCase();
      return [/search|поиск|найти|qidir/.test(hint) ? "search" : "input", e.placeholder || ""];
    }
    if (tag === "SELECT") return ["select", t];
    if (tag === "IMG") return e.naturalWidth > 80 ? ["image", e.alt || ""] : null;
    if (tag === "VIDEO") return ["video", ""];
    if (tag === "PRE") return ["code", ""];
    if (tag === "H1" || tag === "H2") return t.length > 2 ? ["heading", t] : null;
    if (/price/i.test(e.className || "") || e.getAttribute("itemprop") === "price") {
      const m = textOf(e, 80).match(PRICE_RE); return m ? ["price", m[0].trim()] : null;
    }
    if (tag === "A") return t.length > 1 && t.length < 40 ? [btnCat(t) === "button" ? "link" : btnCat(t), t] : null;
    if (t && t.length < 40) return [btnCat(t), t];
    return null;
  }
  function btnCat(t) { for (const [c, re] of BTN_RULES) if (re.test(t)) return c; return "button"; }

  // Что сейчас видно на экране
  function scanPage() {
    const out = [], W_ = vw(), H_ = vh();
    const els = document.querySelectorAll(EX_SEL);
    for (let i = 0; i < els.length && i < 2500 && out.length < 60; i++) {
      const e = els[i];
      const r = e.getBoundingClientRect();
      if (r.width < 24 || r.height < 14 || r.bottom < 0 || r.top > H_ - 20 || r.right < 0 || r.left > W_) continue;
      if (e.checkVisibility && !e.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const c = classify(e);
      if (!c) continue;
      // интересное — чаще: кнопки покупки, поля, картинки, цены
      const w = { buy: 4, search: 4, input: 3, login: 3, price: 4, image: 2, video: 3, code: 3, delete: 3, subscribe: 2, download: 2, heading: 1, link: 0.4, button: 1 }[c[0]] ?? 1.5;
      out.push({ e, r, cat: c[0], text: short(c[1] || ""), w });
    }
    return out;
  }
  function pickWeighted(list) {
    let sum = list.reduce((a, b) => a + b.w, 0), r = Math.random() * sum;
    for (const it of list) { r -= it.w; if (r <= 0) return it; }
    return list[list.length - 1];
  }
  function lineFor(cat, text) {
    const arr = SAY[cat] || SAY.button;
    const opts = text ? arr : arr.filter((p) => !p.includes("T"));
    return pick(opts.length ? opts : arr).replace("T", text);
  }
  // можно ли встать сверху на элемент
  const canStand = (r) => r.width >= Math.max(50, curW * 0.55) && r.top > H() * 1.05 + 10 && r.top < vh() - 40;

  function startExplore() {
    if (!s.explore || !ground || s.pinTop) return false;
    const list = scanPage();
    if (!list.length) return false;
    const it = pickWeighted(list);
    lastExplore = Date.now();
    exTarget = it.e; exCat = it.cat; exText = it.text;
    const cx = clamp(it.r.left + it.r.width / 2 - curW / 2, 0, Math.max(0, vw() - curW));
    // идём под элемент, потом прыгаем на него (если можно), иначе смотрим снизу и комментируем
    goTo(cx, () => {
      const r = exTarget && exTarget.isConnected ? exTarget.getBoundingClientRect() : null;
      if (r && s.physics && canStand(r) && Math.random() < 0.75) jumpTo(exTarget, () => arriveComment());
      else arriveComment();
    });
    return true;
  }
  function arriveComment() {
    if (exCat === "code" && exTarget) {
      pose("think"); go("react", 4500);
      setTimeout(() => { if (state === "react" || state === "idle") pose(Math.random() < 0.5 ? "cool" : "think"); }, 1200);
      say(codeComment(exTarget.textContent || ""), 0, { long: true });
      return;
    }
    const p = { buy: "cool", price: "shock", delete: "shock", image: "think", video: "cool", code: "think", search: "point", login: "think", heading: "point" }[exCat] || pick(["point", "think", "cool"]);
    pose(p); go("react", 2600);
    say(lineFor(exCat, exText));
    
  }

  // идти/бежать к точке x
  let gotoX = 0, gotoThen = null, pendingGoto = null;
  function goTo(tx, then) {
    if (canFly() && ground === "floor" && Math.abs(tx - x) > Math.max(520, vw() * 0.45) && Math.random() < 0.6) { flyTo(tx, then); return; }
    gotoX = tx; gotoThen = then; walkPhase = 0;
    state = "goto"; until = performance.now() + 9000; setAnim("walk");
  }
  function gotoTick(dt, t) {
    const dx = gotoX - x;
    if (Math.abs(dx) < 8 || t > until) { const f = gotoThen; gotoThen = null; state = "idle"; f ? f() : go("idle", 1500); return; }
    dir = Math.sign(dx);
    const far = Math.abs(dx) > 260;
    const fr = far ? runFrames() : skinCfg.walk;
    walkPhase += dt * (far ? runFps() : skinCfg.walkFps * (Number(s.speed) || 1));
    pose(fr[Math.floor(walkPhase) % fr.length], dir);
    const v = far ? runSpeed() : 60 * (Number(s.speed) || 1) * (H() / 140);
    x += dir * Math.min(Math.abs(dx), v * dt); walkedPx += Math.min(Math.abs(dx), v * dt);
    if (ground !== "floor") { // на элементе: дошёл до края — спрыгивает и после приземления идёт дальше
      const [l, r] = platEdges, cx = x + curW / 2;
      if (cx < l || cx > r) { pendingGoto = { x: gotoX, then: gotoThen, until }; gotoThen = null; state = "walk"; fall(); }
    }
  }

  // прыжок точно на элемент (цингун: может и высоко)
  let jumpTarget = null, onJumpLand = null;
  function jumpTo(target, cb) {
    const r = target.getBoundingClientRect();
    const cx = x + curW / 2;
    const tx = clamp(cx, r.left + Math.min(20, r.width / 3), r.right - Math.min(20, r.width / 3));
    const py = vh() - r.top;
    const up = Math.max(40, py - yb + 40);
    const v0 = Math.sqrt(2 * G * up);
    const T = v0 / G + Math.sqrt(2 * Math.max(10, up - (py - yb)) / G);
    dir = tx >= cx ? 1 : -1;
    jumpTarget = target; onJumpLand = cb;
    if (up > 360 && Math.random() < 0.6) say(pick(["Цингун.", "Хоп.", "Лёгкость тела."]), 900);
    play([{ p: "crouch", ms: 240 }], () => { jumping = true; SND.jump(); launch((tx - cx) / T, v0, false); });
  }

  // ты кликнул в поле ввода — он запрыгивает на него и смотрит, как ты печатаешь
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!s.explore || !el || !isTextInput(t) || host.contains(t) || s.pinTop) return;
    // занят (летит, падает, его держат) — подойдёт, как только освободится
    if (dragging || !ground || ["seq", "held", "climb", "hang", "air"].includes(state)) { wantInput = t; return; }
    approachInput(t);
  }, true);
  let wantInput = null;
  function approachInput(t) {
    wantInput = null;
    watchInput = t; typedInWatch = 0;
    exTarget = t; exCat = t.type === "password" ? "login" : "input"; exText = "";
    const r = t.getBoundingClientRect();
    const cx = clamp(r.left + r.width / 2 - curW / 2, 0, Math.max(0, vw() - curW));
    if (ground === t) { watchPose(); return; }
    goTo(cx, () => {
      const rr = t.isConnected ? t.getBoundingClientRect() : null;
      if (rr && s.physics && canStand(rr)) jumpTo(t, () => watchPose());
      else watchPose();
    });
  }
  document.addEventListener("focusout", (e) => {
    if (e.target !== watchInput) return;
    watchInput = null;
    if (state === "watchInput") { go("idle", 1500); if (Math.random() < 0.4) say(pick(["Готово?", "Отправляй.", "Сойдёт."]), 1500); }
  }, true);
  function watchPose() {
    if (!watchInput) return arriveComment();
    state = "watchInput"; until = performance.now() + 60000; setAnim("breathe");
    if (watchInput.type === "password") { pose("derp", 0); say(pick(["Не смотрю.", "Пароль — твоё дело.", "Отвернулся."]), 2200); }
    else { pose(pick(["sit", "think", "cool"]), 0); say(lineFor(/search/i.test(watchInput.type + watchInput.placeholder) ? "search" : "input", ""), 2000); }
  }
  document.addEventListener("input", (e) => {
    if (e.target !== watchInput || state !== "watchInput") return;
    typedInWatch++;
    if (watchInput.type === "password") return;
    if (typedInWatch % 25 === 0) say(pick(["Пиши.", "Длинно.", "Проверь опечатки.", "…", "Дальше."]), 1600);
  }, true);

  // комментирует твои клики по кнопкам (редко)
  document.addEventListener("click", (e) => {
    if (!s.explore || !el || host.contains(e.target) || Date.now() - lastClickTalk < 25000 || Math.random() > 0.25) return;
    const b = e.target.closest?.("button,[role=button],input[type=submit],a[href]");
    if (!b) return;
    const c = classify(b);
    if (!c || c[0] === "link" || c[0] === "button" && Math.random() < 0.5) return;
    lastClickTalk = Date.now();
    setTimeout(() => { if (ground && state !== "seq") { pose(c[0] === "delete" ? "shock" : "cool"); go("react", 1800); say(lineFor(c[0], short(c[1] || ""))); } }, 250);
  }, true);

  // ================= Ловец ошибок (без нейросети) =================
  // Страницы 404/500/403, упавшие скрипты и запросы, сломанные картинки, пропавший интернет.
  // Ошибки становятся жучками 🐞: падают сверху, ползают, а он бегает и ловит их.
  const bugs = [];
  let lastBugAt = 0, caught = 0;
  const ERR_PAGE = [
    [404, /\b404\b|not found|не найден|страница не существует|sahifa topilmadi/i, ["404. Страницы нет.", "404. Ссылка ведёт в пустоту.", "Здесь ничего нет."]],
    [403, /\b403\b|forbidden|доступ запрещ|access denied|ruxsat yo.q/i, ["403. Доступ закрыт.", "Нас не пускают."]],
    [500, /\b500\b|internal server error|внутренняя ошибка сервера/i, ["500. Сервер упал.", "Ошибка сервера. Не наша."]],
    [502, /\b502\b|bad gateway/i, ["502. Шлюз не отвечает.", "Сервер молчит."]],
    [503, /\b503\b|service unavailable|maintenance|техническ\w* работ/i, ["503. Сервер недоступен.", "Обслуживание. Позже."]],
    [429, /\b429\b|too many requests|слишком много запросов/i, ["429. Слишком часто.", "Притормози."]],
  ];
  const NET_LINES = {
    ERR_INTERNET_DISCONNECTED: ["Сети нет. Жду.", "Интернет пропал. Подождём.", "Без сети даже я не пройду."],
    ERR_NAME_NOT_RESOLVED: ["Такого адреса нет. Проверь буквы.", "DNS не знает этот домен."],
    ERR_CONNECTION_REFUSED: ["Сервер закрыт. Не запущен или не тот порт.", "Отказ. Там никого нет."],
    ERR_CONNECTION_TIMED_OUT: ["Сервер молчит.", "Не ответил вовремя."],
    ERR_CONNECTION_RESET: ["Связь оборвалась. Повтори."],
    ERR_TOO_MANY_REDIRECTS: ["Сайт ходит по кругу. Почисти cookies."],
  };
  function checkErrorPage() {
    if (!s.errors || !el) return;
    // своя страница «сайт не открылся» (вместо встроенной Chrome)
    const ne = window.__chibiErrorPage;
    if (ne) {
      setTimeout(() => {
        play([{ p: "think", ms: 1600, say: pick(NET_LINES[ne.code] || ["Сайт не открылся. Проверю ещё раз сам."]) },
          { p: "cool", ms: 2400 }], () => go("idle", 2000));
        addEventListener("online", () => say("Сеть вернулась. Открываю.", 3000, { force: true }), { once: true });
      }, 900);
      return;
    }
    const nav = performance.getEntriesByType?.("navigation")?.[0];
    const st = nav?.responseStatus || 0;
    const text = (document.title + " " + textOf(document.querySelector("h1"))).slice(0, 300);
    let hit = st >= 400 ? ERR_PAGE.find(([c]) => c === st) || [st, null, [`Ошибка ${st}.`]] : null;
    // по тексту — только если страница короткая (настоящая страница ошибки, а не статья про 404)
    if (!hit && textSample(document.body, 3200).length < 3000) hit = ERR_PAGE.find(([, re]) => re.test(text)) || null;
    if (!hit) return;
    const [code, , lines] = hit;
    setTimeout(() => {
      if (!ground) return;
      play([
        { p: "shock", ms: 1400, say: pick(lines) },
        { p: code === 404 ? "think" : "derp", ms: 2200 },
      ], () => { if (code === 404) { go("walk", 5000); say("Ищу.", 1500); } else go("idle", 1500); });
      particles(String(code), 1, "#e74c3c");
    }, 1800);
  }

  function spawnBug(what) {
    if (!s.errors || !el || host.style.display === "none") return;
    sternNow();
    const now = Date.now();
    if (now - lastBugAt < 2500 || bugs.length >= 3) return;
    lastBugAt = now;
    const n = document.createElement("div");
    n.className = "bug";
    n.textContent = "🐞";
    shadow.appendChild(n);
    SND.pop();
    bugs.push({ n, x: rnd(40, vw() - 60), y: vh() + 10, vy: 0, dir: Math.random() < 0.5 ? -1 : 1, what: short(String(what || "ошибка"), 40), born: now });
    if (ground && Math.random() < 0.6) { pose("shock"); go("react", 900); say(pick(["Баг.", "Ошибка. Ловлю.", "Вижу баг."]), 1200); }
  }
  // жучки падают и ползают; он бегает за ближайшим
  function bugsTick(dt) {
    for (let i = bugs.length - 1; i >= 0; i--) {
      const b = bugs[i];
      if (b.y > 18) { b.vy -= G * 0.5 * dt; b.y = Math.max(18, b.y + b.vy * dt); }
      else { b.x += b.dir * 40 * dt; if (b.x < 10 || b.x > vw() - 30) b.dir = -b.dir; }
      b.n.style.transform = `translate(${b.x}px, ${vh() - b.y}px) scaleX(${b.dir})`;
      if (Date.now() - b.born > 25000) { b.n.remove(); bugs.splice(i, 1); }
    }
    if (!bugs.length || !ground || ground !== "floor" || s.pinTop) return;
    if (!["idle", "walk", "emote", "react", "watch", "goto"].includes(state) || (state === "goto" && gotoThen && !gotoThen.bug)) return;
    const cx = x + curW / 2;
    const b = bugs.reduce((a, c) => (Math.abs(c.x - cx) < Math.abs(a.x - cx) ? c : a));
    if (b.y > 30) return; // ещё падает
    if (Math.abs(b.x - cx) < 30) {
      b.n.remove(); bugs.splice(bugs.indexOf(b), 1); caught++;
      SND.ding(); stat("bugs"); addXp(5);
      pose("cool"); go("react", 2400); particles("✨", 3, "#ffc94d");
      say(caught % 5 === 0 ? `${caught} багов. Счёт растёт.` : pick([`поймал баг: ${b.what}`, `Пойман: «${b.what}»`, "Устранён."]), 3200);
      return;
    }
    const f = () => {}; f.bug = true;
    if (state !== "goto") goTo(clamp(b.x - curW / 2, 0, Math.max(0, vw() - curW)), f);
    else gotoX = clamp(b.x - curW / 2, 0, Math.max(0, vw() - curW));
  }

  // ошибки скриптов страницы и неудачные загрузки
  window.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && t.tagName) {          // не загрузился ресурс
      if (t.tagName === "IMG" && s.errors && el) {
        const r = t.getBoundingClientRect();
        if (r.width > 40 && r.bottom > 0 && r.top < vh() && ground && !["seq", "held"].includes(state)) {
          exTarget = t; exCat = "brokenImg"; exText = "";
          goTo(clamp(r.left + r.width / 2 - curW / 2, 0, Math.max(0, vw() - curW)), () => { pose("shock"); go("react", 2500); say(pick(["Картинка сломана.", "Картинка не загрузилась.", "Битая ссылка на картинку."])); });
        }
      } else spawnBug((t.tagName === "SCRIPT" ? "скрипт " : "файл ") + ((t.src || t.href || "").split("/").pop() || "не загрузился"));
      return;
    }
    spawnBug(e.message || "ошибка скрипта");
  }, true);
  window.addEventListener("unhandledrejection", (e) => spawnBug(e.reason?.message || String(e.reason || "промис упал")));
  // ошибки из мира страницы приходят от errhook.js
  window.addEventListener("message", (e) => { if (e.source === window && typeof e.data?.chibiErr === "string") spawnBug(e.data.chibiErr); });
  // картинки, сломавшиеся ещё до его появления
  function checkBrokenImages() {
    if (!s.errors || !el) return;
    const img = [...document.images].find((i) => i.complete && i.naturalWidth === 0 && i.getAttribute("src") && (() => {
      const r = i.getBoundingClientRect(); return r.width > 40 && r.height > 20 && r.bottom > 0 && r.top < vh();
    })());
    if (!img || !ground || ["seq", "held"].includes(state)) return;
    const r = img.getBoundingClientRect();
    goTo(clamp(r.left + r.width / 2 - curW / 2, 0, Math.max(0, vw() - curW)), () => { pose("shock"); go("react", 2500); say(pick(["Картинка сломана.", "Картинка не загрузилась.", "Битая ссылка на картинку."])); });
  }
  // упавшие запросы сайта (4xx/5xx)
  try {
    new PerformanceObserver((list) => {
      for (const en of list.getEntries()) {
        const st = en.responseStatus || 0;
        if (st >= 400 && !/favicon|apple-touch-icon|\/beacon|\/collect|analytics|doubleclick/i.test(en.name)) spawnBug(st + " " + (en.name.split("?")[0].split("/").pop() || en.name));
      }
    }).observe({ type: "resource", buffered: false });
  } catch {}
  // интернет
  window.addEventListener("offline", () => { if (!s.errors || !el) return; pose("shock"); go("react", 3000); say(pick(["Сеть пропала.", "Связи нет.", "Офлайн. Ждём."]), 3500); });
  window.addEventListener("online", () => { if (!s.errors || !el) return; pose("laugh"); go("react", 2000); say(pick(["Сеть вернулась.", "Снова онлайн."]), 2500); particles("✨", 3, "#ffc94d"); });

  // рабочий график (из настроек) — чтобы знать, перерыв сейчас или конец дня
  const hm = (str) => { const m = /(\d{1,2}):(\d{2})/.exec(str || ""); return m ? +m[1] * 60 + +m[2] : null; };
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const workDay = () => (s.workDays || [1, 2, 3, 4, 5, 6]).includes(new Date().getDay());
  function breakNow() {
    if (!s.schedOn || !workDay()) return false;
    const m = nowMin();
    return String(s.breaks || "").split(/[,;]+/).some((p) => { const [a, b] = p.split(/[-–—]/).map(hm); return a != null && b != null && m >= a && m < b; });
  }
  const afterWork = () => s.schedOn && workDay() && hm(s.workEnd) != null && nowMin() >= hm(s.workEnd) && nowMin() < 23 * 60;

  // ================= Звук: синтез через WebAudio, без файлов =================
  let actx = null;
  function audio() {
    if (!s.sound) return null;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return null; // до первого клика браузер звук не даст
    try { actx = actx || new AudioContext(); if (actx.state === "suspended") actx.resume(); return actx; } catch { return null; }
  }
  const vol = () => clamp(Number(s.volume) || 0.5, 0, 1);
  function tone(f, f2, dur, type = "sine", v = 0.15, delay = 0) {
    const a = audio(); if (!a) return;
    const t0 = a.currentTime + delay;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v * vol()), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.03);
  }
  function noise(dur, freq = 800, v = 0.15, delay = 0) {
    const a = audio(); if (!a) return;
    const t0 = a.currentTime + delay;
    const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = a.createBufferSource(); src.buffer = buf;
    const fl = a.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = freq;
    const g = a.createGain(); g.gain.value = v * vol();
    src.connect(fl).connect(g).connect(a.destination); src.start(t0);
  }
  const SND = {
    step: () => s.steps && tone(150, 95, 0.05, "triangle", 0.035),
    jump: () => tone(260, 620, 0.16, "square", 0.045),
    land: () => noise(0.1, 320, 0.22),
    thud: () => { noise(0.22, 220, 0.35); tone(120, 55, 0.2, "sine", 0.22); },
    ouch: () => tone(950, 470, 0.18, "sawtooth", 0.045),
    boing: () => tone(170, 540, 0.22, "sine", 0.12),
    ding: () => { tone(880, 0, 0.18, "triangle", 0.12); tone(1320, 0, 0.28, "triangle", 0.1, 0.09); },
    pop: () => tone(480, 920, 0.07, "sine", 0.1),
    sip: () => { for (let i = 0; i < 4; i++) tone(620 + Math.random() * 380, 320, 0.06, "sine", 0.06, i * 0.13); },
    nom: () => { for (let i = 0; i < 3; i++) noise(0.05, 1300, 0.12, i * 0.15); },
    purr: () => tone(95, 82, 0.28, "sawtooth", 0.02),
    whoosh: () => noise(0.35, 1600, 0.12),
    chime: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0, 0.38, "triangle", 0.1, i * 0.12)),
    fanfare: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0, 0.3, "square", 0.04, i * 0.11)),
    levelup: () => [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0, 0.45, "sine", 0.1, i * 0.08)),
    sad: () => [392, 349, 311].forEach((f, i) => tone(f, 0, 0.32, "triangle", 0.07, i * 0.18)),
  };

  // ================= Статистика, достижения, культивация =================
  let stats = { xp: 0, bugs: 0, throws: 0, feeds: 0, pets: 0, games: 0, best: 0, meters: 0, found: 0, notes: 0, breaks: 0, flights: 0, firstDay: "", ach: [] };
  let statsT = 0, walkedPx = 0;
  function flushStats() { clearTimeout(statsT); statsT = setTimeout(() => { try { chrome.storage.local.set({ stats }); } catch {} }, 1500); }
  function stat(k, d = 1) { stats[k] = (stats[k] || 0) + d; flushStats(); checkAch(); if (["bugs", "throws", "feeds", "breaks"].includes(k)) dayAdd(k, d); }
  const ACH = [
    ["bugs", 1, "Первый баг"], ["bugs", 25, "Охотник на баги"], ["bugs", 100, "Гроза багов"],
    ["throws", 10, "Бывалый летун"], ["throws", 100, "Неубиваемый"],
    ["meters", 500, "Путешественник"], ["meters", 5000, "Странник Дао"],
    ["notes", 5, "Хранитель свитков"], ["breaks", 10, "Отдых — тоже работа"],
    ["days", 7, "Неделя вместе"], ["days", 30, "Месяц вместе"],
  ];
  function daysTogether() { return stats.firstDay ? Math.floor((Date.now() - new Date(stats.firstDay).getTime()) / 864e5) + 1 : 1; }
  function checkAch() {
    for (const [k, n, name] of ACH) {
      const id = k + n, v = k === "days" ? daysTogether() : stats[k] || 0;
      if (v >= n && !stats.ach.includes(id)) { stats.ach.push(id); flushStats(); setTimeout(() => celebrate(`Достижение: «${name}».`), 1200); }
    }
  }
  function celebrate(text) {
    if (!el) return;
    if (ground && !["seq", "held"].includes(state)) { pose("cool"); go("react", 3000); }
    say(text, 4500, { force: true });
    SND.chime();
  }
  // культивация: опыт за время работы, баги, игры; ступени как в новеллах
  const REALMS = ["Закалка тела", "Сбор Ци", "Основание", "Золотое ядро", "Зарождение души", "Преображение духа", "Пустота", "Слияние с Дао", "Бессмертный"];
  const STAGES = ["начальная", "средняя", "поздняя"];
  function levelOf(xp) {
    let lvl = 0, need = 60;
    while (xp >= need && lvl < REALMS.length * 3 - 1) { xp -= need; lvl++; need = Math.round(need * 1.35); }
    return { lvl, into: xp, need };
  }
  const realmName = (lvl) => `${REALMS[Math.floor(lvl / 3)]}, ${STAGES[lvl % 3]} стадия`;
  function addXp(n) {
    const before = levelOf(stats.xp || 0).lvl;
    stats.xp = (stats.xp || 0) + n;
    flushStats(); dayAdd("xp", n);
    const after = levelOf(stats.xp).lvl;
    if (after > before) setTimeout(() => breakthrough(after), 600);
  }
  function breakthrough(lvl) {
    if (!el) return;
    const go2 = () => {
      el.classList.add("aura");
      say(`Прорыв. ${realmName(lvl)}.`, 5000, { force: true });
      particles("✨", 6, "#ffc94d"); particles("⚡", 2, "#ffd86b");
      SND.levelup();
      setTimeout(() => el.classList.remove("aura"), 4500);
    };
    if (ground && !["held"].includes(state)) play([{ p: has("meditate") ? "meditate" : "sit", ms: 1800 }, { p: "cool", ms: 2600 }], () => { go("idle", 1500); });
    go2();
  }
  // опыт за активную работу: минута в открытой вкладке = 1
  setInterval(() => {
    if (!el || document.hidden || Date.now() - lastUserAct > 120000) return;
    addXp(1);
    if (walkedPx > 0) { stat("meters", Math.round(walkedPx / 300)); walkedPx = 0; }
  }, 60000);

  // медитация: светится, вокруг ци
  function meditate(ms) {
    if (!ground) return;
    state = "meditate"; until = performance.now() + ms; setAnim("breathe");
    pose(has("meditate") ? "meditate" : "sit", 0);
    el.classList.add("aura");
    if (Math.random() < 0.6) say(pick(["Не мешай. Культивирую.", "Собираю ци.", "Тишина.", "Дао внутри."]), 2200);
  }
  function meditateTick(t) {
    if (Math.random() < 0.03) particles(pick(["✨", "·", "✦"]), 1, "#ffd86b");
    if (t > until) { el.classList.remove("aura"); addXp(2); go("idle", 1500); }
  }

  // ================= Заметки: перетащи на него текст — съест и запомнит =================
  let notes = [];
  function addNote(t) {
    t = String(t || "").trim().slice(0, 2000);
    if (!t) return;
    notes.unshift({ t, at: Date.now(), host: location.hostname });
    notes = notes.slice(0, 30);
    try { chrome.storage.local.set({ notes }); } catch {}
    stat("notes");
    if (ground) play([{ p: "read", ms: 1600, say: pick(["Записал.", "В свиток.", "Сохранено."]) }], () => go("idle", 1000));
    SND.nom();
  }
  function notesMenu() {
    closeMenu();
    if (!notes.length) { say("Свиток пуст. Перетащи на меня текст.", 3000, { force: true }); return; }
    menu = document.createElement("div"); menu.className = "mn";
    const head = document.createElement("div"); head.className = "mh"; head.textContent = "📜 заметки — клик, чтобы скопировать";
    menu.appendChild(head);
    notes.slice(0, 10).forEach((n) => {
      const b = document.createElement("button"); b.type = "button";
      b.textContent = "· " + short(n.t.replace(/\s+/g, " "), 34);
      b.title = n.t;
      b.addEventListener("click", (ev) => { ev.stopPropagation(); closeMenu(); navigator.clipboard?.writeText(n.t).then(() => say("Скопировано.", 1400), () => say("не смог скопировать", 1400)); });
      menu.appendChild(b);
    });
    const clr = document.createElement("button"); clr.type = "button"; clr.textContent = "🗑  Очистить";
    clr.addEventListener("click", (ev) => { ev.stopPropagation(); closeMenu(); notes = []; try { chrome.storage.local.set({ notes }); } catch {} say("свиток чист", 1200); });
    menu.appendChild(clr);
    menu.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    el.appendChild(menu); keepOnScreen(menu);
    setTimeout(() => window.addEventListener("pointerdown", closeMenu, { once: true }), 0);
  }

  // ================= Чтение длинных страниц, частые сайты =================
  const readMarks = new Set();
  window.addEventListener("scroll", () => {
    if (!el || !s.pageTalk) return;
    const h = document.documentElement.scrollHeight;
    if (h < innerHeight * 3) return;
    const p = (scrollY + innerHeight) / h;
    for (const [m, line] of [[0.5, "Половина."], [0.97, "Дочитал. Хорошо."]]) {
      if (p >= m && !readMarks.has(m)) { readMarks.add(m); if (ground && !["seq", "held", "game"].includes(state)) { pose(m > 0.9 ? "cool" : "think"); go("react", 2000); } say(line, 2200); if (m > 0.9) addXp(2); }
    }
  }, { passive: true });
  function countVisit() {
    if (performance.getEntriesByType?.("navigation")?.[0]?.type === "reload") return; // обновление — не новый визит
    const d = new Date().toDateString(), host = location.hostname;
    chrome.storage.local.get({ visits: { date: "", counts: {} } }, ({ visits }) => {
      if (visits.date !== d) visits = { date: d, counts: {} };
      const n = (visits.counts[host] || 0) + 1;
      visits.counts[host] = n;
      const keys = Object.keys(visits.counts);
      if (keys.length > 300) delete visits.counts[keys[0]];
      chrome.storage.local.set({ visits });
      if (s.pageTalk && [3, 5, 10, 20].includes(n)) setTimeout(() => say(n >= 10 ? `${host} — уже ${n}-й раз сегодня. Хватит.` : `${host}, ${n}-й раз за день.`, 3200), 7000);
    });
  }

  // ================= Сдувает cookie-баннеры =================
  const COOKIE_SEL = "#onetrust-banner-sdk,#CybotCookiebotDialog,.cc-window,.cookie-banner,#cookie-banner,.cookie-consent,#cookie-consent,[class*=cookie-notice],[id*=cookie-notice],[class*=CookieBanner],[aria-label*=cookie i]";
  function blowCookies() {
    if (!s.cookieBlow || !el) return;
    const b = [...document.querySelectorAll(COOKIE_SEL)].find((e) => {
      const r = e.getBoundingClientRect(); return r.width > 150 && r.height > 30 && r.bottom > 0 && r.top < vh() && (!e.checkVisibility || e.checkVisibility());
    });
    if (!b || !ground) return;
    const r = b.getBoundingClientRect();
    goTo(clamp(r.left + r.width / 2 - curW / 2, 0, Math.max(0, vw() - curW)), () => {
      pose("laugh"); go("react", 1800); say(pick(["Мешает.", "Убираю.", "Баннер убран."]), 1800); SND.whoosh();
      b.style.transition = "transform .7s ease-in, opacity .7s"; b.style.transform = "translateY(-40px) rotate(-4deg) scale(.9)"; b.style.opacity = "0";
      setTimeout(() => b.style.setProperty("display", "none", "important"), 750);
    });
  }

  // ================= Рабочий день: события приходят от фонового скрипта =================
  const SCHED_LINES = {
    pomoBreak: ["Перерыв."], pomoWork: ["Работаем."], pomoLong: ["Большой перерыв."],
    start: ["Утро. Начинаем.", "9:00. За работу.", "Новый день. Работай."],
    preBreak: ["Через 5 минут перерыв.", "Перерыв скоро. Доделай мысль."],
    break: ["Перерыв. Встань, отойди от экрана.", "Перерыв. Восстанови ци."],
    preLunch: ["Через 5 минут обед."],
    lunch: ["Обед. Час. Поешь нормально.", "Обед. Экран подождёт."],
    back: ["Перерыв окончен. Работаем.", "Возвращайся к делу."],
    preEnd: ["10 минут до конца дня. Закрывай задачи."],
    end: ["Рабочий день окончен. Отдыхай.", "18:00. Достаточно на сегодня."],
    water: ["Выпей воды.", "Вода. Сейчас."],
  };
  function handleSched(ev) {
    if (!el || host.style.display === "none") return false;
    const line = pick(SCHED_LINES[ev] || ["⏰"]);
    if (ev === "pomoBreak" || ev === "pomoWork" || ev === "pomoLong") {
      SND.chime();
      const L = { pomoBreak: "25 минут. Перерыв 5 минут. Встань.", pomoWork: "Перерыв окончен. Следующие 25 минут.", pomoLong: "Четыре круга. Перерыв 15 минут." }[ev];
      if (ev !== "pomoWork" && ground && !s.pinTop) meditate(8000);
      say(L, 5000, { force: true });
      return true;
    }
    if (ev === "end") { celebrate(line); setTimeout(dayReport, 4500); }
    else if (ev === "start") { pose("wave"); go("react", 2400); say(line, 4000, { force: true }); SND.chime(); setTimeout(() => weatherSay(), 4500); }
    else if (ev === "break" || ev === "lunch") {
      SND.chime(); stat("breaks");
      if (ground && !s.pinTop) {
        if (ev === "lunch") play([{ p: "read", ms: 4000, say: line }], () => go("idle", 1500));
        else { meditate(9000); say(line, 4000, { force: true }); }
      } else say(line, 4000, { force: true });
    } else {
      ev === "water" ? SND.sip() : SND.ding();
      if (ground && !["seq", "held", "game"].includes(state)) { pose(ev === "start" || ev === "back" ? "wave" : "think"); go("react", 2400); }
      say(line, 4000, { force: true });
    }
    return true;
  }
  if (alive()) chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (m?.type === "sched") send(handleSched(m.ev));
    if (m?.type === "enter") enterFrom(m.from);
  });
  // пришёл из соседней вкладки: влетает из-за края экрана
  // Вкладку спрятали — сразу прячем и его: при возврате не мелькнёт на старом месте.
  // Вернулись: если фоновый скрипт пришлёт «enter» — влетит сбоку, если нет (переключил окно) — просто появится.
  let awaitEnter = 0;
  document.addEventListener("visibilitychange", () => {
    if (!el) return;
    if (document.hidden) { el.style.visibility = "hidden"; awaitEnter = 0; return; }
    awaitEnter = setTimeout(async () => {
      awaitEnter = 0;
      const g = await msg({ type: "pos:get" });
      if (g && !dragging && Date.now() - g.at < 6 * 3600 * 1000) applySnapshot(g, true);
      el.style.visibility = "";
    }, 350);
  });
  function enterFrom(from) {
    clearTimeout(awaitEnter); awaitEnter = 0;
    el && (el.style.visibility = "");
    if (!el || host.style.display === "none" || dragging) return;
    closeMenu(); hideBubble();
    seq = null; sliding = false; jumpTarget = null; onJumpLand = null; gotoThen = null; pendingGoto = null; spin = 0; rot = 0;
    const fromLeft = from === "left";
    dir = fromLeft ? 1 : -1;
    if (s.pinTop) { x = fromLeft ? 0 : Math.max(0, vw() - curW); pinned = false; return; } // закреплённый — просто на месте
    const off = fromLeft ? -curW - 8 : vw() + 8;
    const H_ = vh();
    // каждый раз по-разному и с разной силой
    const kind = pick(["leap", "leap", "hop", "run", "tumble", "drop", "far", ...(canFly() ? ["fly", "fly"] : [])]);
    x = off; entering = true; thrown = false; jumping = false;
    if (kind === "fly") {                       // влетает по воздуху и мягко садится
      entering = false; yb = rnd(H_ * 0.25, H_ * 0.55);
      flyTo(clamp(fromLeft ? rnd(vw() * 0.2, vw() * 0.5) : rnd(vw() * 0.4, vw() * 0.75), 0, Math.max(0, vw() - curW)),
        () => { if (Math.random() < 0.35) say(pick(["Прибыл.", "Здесь.", "…"]), 1300); }, true);
      return;
    }
    if (kind === "run") {                       // вбегает по полу
      yb = 0; entering = false; ground = "floor";
      goTo(clamp(fromLeft ? rnd(vw() * 0.15, vw() * 0.45) : rnd(vw() * 0.45, vw() * 0.8), 0, Math.max(0, vw() - curW)), () => { pose("wave"); go("react", 1200); if (Math.random() < 0.4) say(pick(["Здесь.", "На месте.", "…"]), 1300); });
      gotoX = clamp(gotoX, 0, Math.max(0, vw() - curW));
      return;
    }
    if (kind === "hop") { yb = rnd(0, H_ * 0.06); fallFrom = yb; launch(dir * rnd(280, 380), rnd(320, 520), false); }
    else if (kind === "leap") { yb = rnd(H_ * 0.12, H_ * 0.4); fallFrom = yb; launch(dir * rnd(380, 620), rnd(250, 650), false); }
    else if (kind === "far") { yb = rnd(H_ * 0.25, H_ * 0.5); fallFrom = yb; launch(dir * rnd(700, 950), rnd(500, 800), false); SND.whoosh(); }
    else if (kind === "tumble") { yb = rnd(H_ * 0.2, H_ * 0.4); fallFrom = yb; launch(dir * rnd(500, 750), rnd(300, 600), false); spin = dir * rnd(500, 800); }
    else { x = fromLeft ? rnd(0, vw() * 0.3) : rnd(vw() * 0.55, Math.max(0, vw() - curW)); yb = H_ - curH * 0.2; fallFrom = yb; entering = "inside"; launch(dir * rnd(20, 90), 0, false); }
    if (kind !== "far" && Math.random() < 0.25) SND.whoosh();
  }

  // ================= Время на сайтах за день и отчёт =================
  const today = () => new Date().toDateString();
  let day = { date: today(), sites: {}, bugs: 0, xp: 0, breaks: 0, throws: 0, feeds: 0, focusBlocks: 0 };
  let dayT = 0;
  function dayLoad(cb) {
    chrome.storage.local.get({ day: null }, (v) => {
      if (v.day && v.day.date === today()) day = { ...day, ...v.day };
      else day = { date: today(), sites: {}, bugs: 0, xp: 0, breaks: 0, throws: 0, feeds: 0, focusBlocks: 0 };
      cb && cb();
    });
  }
  function dayAdd(k, n = 1) {
    if (day.date !== today()) day = { date: today(), sites: {}, bugs: 0, xp: 0, breaks: 0, throws: 0, feeds: 0, focusBlocks: 0 };
    day[k] = (day[k] || 0) + n;
    clearTimeout(dayT); dayT = setTimeout(() => { try { chrome.storage.local.set({ day }); } catch {} }, 2000);
  }
  // каждые 15 с активной работы в видимой вкладке — плюс 15 с этому сайту (между вкладками сливаем через хранилище)
  setInterval(() => {
    if (!el || document.hidden || !document.hasFocus() || Date.now() - lastUserAct > 120000) return;
    const h = location.hostname.replace(/^www\./, "") || "файлы";
    chrome.storage.local.get({ day: null }, (v) => {
      if (v.day && v.day.date === today()) day = { ...day, ...v.day, sites: { ...v.day.sites } };
      day.sites[h] = (day.sites[h] || 0) + 15;
      const keys = Object.keys(day.sites);
      if (keys.length > 200) delete day.sites[keys.sort((a, b) => day.sites[a] - day.sites[b])[0]];
      try { chrome.storage.local.set({ day }); } catch {}
    });
  }, 15000);
  const fmtDur = (sec) => { const m = Math.round(sec / 60); return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60 ? (m % 60) + " мин" : ""}`.trim(); };
  function dayReport() {
    dayLoad(() => {
      const top = Object.entries(day.sites).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const total = Object.values(day.sites).reduce((a, b) => a + b, 0);
      const lines = [`📊 за сегодня в браузере ${fmtDur(total)}`];
      top.forEach(([h, t]) => lines.push(`· ${h} — ${fmtDur(t)}`));
      const extra = [];
      if (day.bugs) extra.push(`жучков ${day.bugs}`);
      if (day.breaks) extra.push(`перерывов ${day.breaks}`);
      if (day.xp) extra.push(`+${day.xp} ци`);
      if (day.focusBlocks) extra.push(`отвлекался ${day.focusBlocks} раз`);
      if (extra.length) lines.push(extra.join(" · "));
      const fun = top.find(([h]) => FOCUS_DEFAULT.some((f) => h.endsWith(f)));
      if (fun && fun[1] > 1800) lines.push(`${fun[0]}: ${fmtDur(fun[1])}. Много.`);
      else if (total > 6 * 3600) lines.push("Много работал. Отдохни.");
      say(lines.join("\n"), 14000, { force: true, long: true });
    });
  }

  // ================= Режим фокуса: в рабочее время мягко отгоняет от отвлекающих сайтов =================
  const FOCUS_DEFAULT = ["youtube.com", "instagram.com", "tiktok.com", "facebook.com", "x.com", "twitter.com", "vk.com", "reddit.com", "twitch.tv", "kinopoisk.ru"];
  let focusEl = null;
  const workNow = () => s.schedOn && workDay() && hm(s.workStart) != null && hm(s.workEnd) != null && nowMin() >= hm(s.workStart) && nowMin() < hm(s.workEnd) && !breakNow();
  function focusList() { return String(s.focusSites || "").split(/[\s,;]+/).map((x) => x.trim().replace(/^www\./, "")).filter(Boolean); }
  function focusCheck() {
    if (!s.focusOn || !el || focusEl || !workNow()) return;
    const h = location.hostname.replace(/^www\./, "");
    if (!focusList().some((f) => h === f || h.endsWith("." + f))) return;
    chrome.storage.local.get({ focusSnooze: {} }, ({ focusSnooze }) => {
      const until = focusSnooze[h] || 0;
      if (Date.now() < until) { setTimeout(focusCheck, until - Date.now() + 500); return; }
      showFocus(h);
    });
  }
  function showFocus(h) {
    sternNow();
    dayAdd("focusBlocks");
    focusEl = document.createElement("div");
    focusEl.className = "focus";
    const card = document.createElement("div"); card.className = "fc";
    const t = document.createElement("b"); t.textContent = "Работай.";
    const p1 = document.createElement("p"); p1.textContent = `${h} — это отвлекает. Сейчас рабочее время, до ${s.workEnd} осталось ${fmtDur((hm(s.workEnd) - nowMin()) * 60)}.`;
    const row = document.createElement("div"); row.className = "fr";
    const mk = (txt, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = txt; b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); row.appendChild(b); return b; };
    mk("⬅ Уйти", () => { hideFocus(); history.length > 1 ? history.back() : say("Закрой вкладку.", 2000); });
    mk("Ещё 5 минут", () => snooze(h, 5 * 60000, "5 минут. Не больше."));
    mk("Сегодня можно", () => snooze(h, endOfDay() - Date.now(), "Сегодня — можно."));
    card.append(t, p1, row);
    focusEl.appendChild(card);
    focusEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    shadow.insertBefore(focusEl, el);
    // сам подбегает к центру и машет
    if (ground && !s.pinTop) goTo(clamp(vw() / 2 - curW / 2, 0, Math.max(0, vw() - curW)), () => { pose("pout", 0); go("react", 3000); });
    say(pick(["Сейчас работа.", "Это не работа.", "Сначала дело."]), 2500, { force: true });
    SND.ding();
  }
  const endOfDay = () => { const d = new Date(); d.setHours(23, 59, 59, 0); return d.getTime(); };
  function snooze(h, ms, line) {
    chrome.storage.local.get({ focusSnooze: {} }, ({ focusSnooze }) => {
      focusSnooze[h] = Date.now() + ms;
      chrome.storage.local.set({ focusSnooze });
      hideFocus(); say(line, 1800, { force: true });
      if (ms < 3600000) setTimeout(focusCheck, ms + 500);
    });
  }
  function hideFocus() { focusEl && focusEl.remove(); focusEl = null; }

  // ================= Помидор 25/5 (общий для всех вкладок, будильник — в фоне) =================
  let signEl = null;
  function pomoToggle() {
    chrome.storage.local.get({ pomo: null }, ({ pomo }) => {
      if (pomo && pomo.end > Date.now()) { msg({ type: "pomo", cmd: "stop" }); say("Таймер остановлен.", 1500); }
      else { msg({ type: "pomo", cmd: "start" }); say("25 минут. Время пошло.", 2500, { force: true }); SND.chime(); }
    });
  }
  let pomoState = null;
  function pomoTick() {
    if (!pomoState || pomoState.end <= Date.now()) { if (signEl) { signEl.remove(); signEl = null; } return; }
    if (!signEl) { signEl = document.createElement("div"); signEl.className = "sign"; el.appendChild(signEl); }
    const left = Math.max(0, Math.round((pomoState.end - Date.now()) / 1000));
    signEl.textContent = `${pomoState.phase === "work" ? "🍅" : "🍵"} ${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
  }
  setInterval(pomoTick, 1000);

  // ================= Помощники программиста для выделенного текста =================
  const HTTP = { 200: "OK — всё хорошо", 201: "создано", 204: "успех, но без тела ответа", 301: "переехало навсегда (редирект)", 302: "временный редирект", 304: "не изменилось — бери из кэша",
    400: "кривой запрос — проверь параметры/JSON", 401: "не авторизован — нет или протух токен", 403: "запрещено — прав не хватает", 404: "не найдено — проверь URL", 405: "метод не тот (GET/POST?)",
    408: "сервер не дождался запроса", 409: "конфликт — данные уже изменились", 413: "слишком большой запрос/файл", 415: "не тот Content-Type", 418: "я чайник 🫖", 422: "данные не прошли валидацию",
    429: "слишком часто — притормози, лимит", 500: "сервер упал внутри — смотри логи", 502: "прокси/шлюз не достучался до бэкенда", 503: "сервис недоступен/перегружен", 504: "шлюз не дождался ответа — таймаут" };
  const ERRS = [
    [/ECONNREFUSED|Connection refused|SQLSTATE\[HY000\] \[2002\]/i, "соединение отклонено: сервис не запущен или не тот порт/хост"],
    [/ETIMEDOUT|timed out|timeout/i, "таймаут: сервер не ответил вовремя — сеть, файрвол или он завис"],
    [/ENOTFOUND|getaddrinfo|Name or service not known/i, "домен не найден — опечатка в адресе или DNS"],
    [/EADDRINUSE|address already in use/i, "порт уже занят — найди процесс: lsof -i :ПОРТ (или netstat -ano на Windows)"],
    [/ENOENT|No such file or directory/i, "файла или папки нет — проверь путь"],
    [/EACCES|Permission denied(?! \(publickey)/i, "нет прав — проверь владельца/права (chmod/chown)"],
    [/Permission denied \(publickey\)/i, "SSH-ключ не подошёл: ssh-add, проверь ключ в GitHub/на сервере"],
    [/CORS|Access-Control-Allow-Origin/i, "CORS: сервер не разрешил запрос с этого домена — нужен заголовок Access-Control-Allow-Origin"],
    [/non-fast-forward|\[rejected\]|Updates were rejected/i, "git: на сервере есть новые коммиты — сделай git pull --rebase, потом push"],
    [/CONFLICT|Merge conflict|<<<<<<<|>>>>>>>/i, "конфликт слияния: поправь файлы с <<<<<<< и сделай git add + commit"],
    [/detached HEAD/i, "ты не на ветке: git switch -c новая-ветка, чтобы не потерять коммиты"],
    [/not a git repository/i, "тут нет git: перейди в папку проекта или git init"],
    [/Your branch is behind/i, "ветка отстаёт: git pull"],
    [/ModuleNotFoundError|No module named/i, "модуль не установлен: pip install …, или не то окружение (venv)"],
    [/Cannot find module|MODULE_NOT_FOUND/i, "модуль не найден: npm install, или проверь путь импорта"],
    [/IndentationError|unexpected indent/i, "отступы поехали — пробелы и табы перемешаны?"],
    [/KeyError/i, "такого ключа нет в словаре — используй .get()"],
    [/(TypeError|Cannot read propert(y|ies) of (undefined|null))/i, "обращение к undefined/null — где-то значение не пришло, проверь ?."],
    [/is not defined|ReferenceError|NameError/i, "переменная не объявлена или опечатка в имени"],
    [/SyntaxError/i, "синтаксическая ошибка — смотри строку и символ рядом (скобка, запятая, кавычка)"],
    [/NullPointerException/i, "NPE: объект null — проверь инициализацию"],
    [/Segmentation fault|SIGSEGV/i, "segfault: обращение к чужой памяти — указатели/выход за массив"],
    [/Allowed memory size .* exhausted/i, "PHP съел всю память: утечка в цикле или подними memory_limit"],
    [/Maximum execution time/i, "PHP: скрипт работает слишком долго — set_time_limit или оптимизируй"],
    [/out of memory|OOMKilled|JavaScript heap out of memory/i, "закончилась память — утечка или большие данные; node: --max-old-space-size"],
    [/FLOOD_WAIT_?(\d+)/i, (m) => `Telegram: подожди ${m[1]} с (${fmtDur(+m[1])}) — слишком частые запросы`],
    [/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|AUTH_KEY_DUPLICATED/i, "Telegram: сессия умерла — нужно заново войти по номеру"],
    [/PHONE_NUMBER_BANNED|USER_DEACTIVATED/i, "Telegram: номер заблокирован"],
    [/PEER_FLOOD/i, "Telegram: спам-ограничение аккаунта — сбавь темп, напиши @SpamBot"],
    [/PHONE_CODE_(INVALID|EXPIRED)/i, "Telegram: код неверный или истёк — запроси новый"],
    [/SESSION_PASSWORD_NEEDED/i, "Telegram: включена 2FA — нужен облачный пароль"],
  ];
  function devFacts(t) {
    const s1 = t.trim();
    // cron
    const cr = s1.split(/\s+/);
    if (cr.length === 5 && cr.every((p) => /^(\*|\d+)([-,/]\d+|,\d+)*$|^\*\/\d+$/.test(p))) return { auto: true, text: "⏰ " + cronText(cr) };
    // ошибки
    for (const [re, ans] of ERRS) { const m = s1.match(re); if (m && s1.length < 1500) return { auto: false, long: true, text: "🔧 " + (typeof ans === "function" ? ans(m) : ans) }; }
    // регулярка
    if (/^\/.+\/[gimsuy]*$/.test(s1) || (/[\\^$|?*+()[\]{}]/.test(s1) && /\\[dws]|\[[^\]]+\]|\(\?|[+*?]\)|\^.*\$/.test(s1) && !/\s{2,}/.test(s1) && s1.length < 200)) return { auto: false, long: true, text: "регулярка:\n" + regexText(s1.replace(/^\/(.*)\/[gimsuy]*$/, "$1")) };
    // HTTP-код
    const hc = /^(?:HTTP\/[\d.]+\s+)?([1-5]\d\d)(?:\s+[A-Za-z ]+)?$/.exec(s1);
    if (hc && HTTP[hc[1]]) return { auto: true, text: `HTTP ${hc[1]}: ${HTTP[hc[1]]}` };
    // байты
    if (/^\d{4,}$/.test(s1) && +s1 >= 1024) {
      const b = +s1, u = ["Б", "КБ", "МБ", "ГБ", "ТБ"]; let i = 0, v = b; while (v >= 1024 && i < 4) { v /= 1024; i++; }
      return { auto: false, text: `${s1} байт = ${parseFloat(v.toFixed(2))} ${u[i]}` };
    }
    // px ↔ rem, мс
    const px = /^(\d+(?:\.\d+)?)px$/.exec(s1); if (px) return { auto: true, text: `${s1} = ${parseFloat((+px[1] / 16).toFixed(3))}rem` };
    const rem = /^(\d+(?:\.\d+)?)rem$/.exec(s1); if (rem) return { auto: true, text: `${s1} = ${+rem[1] * 16}px` };
    const ms = /^(\d+)\s?ms$/.exec(s1); if (ms) return { auto: true, text: `${s1} = ${+ms[1] / 1000} с` };
    return null;
  }
  function cronText([mi, h, dom, mo, dow]) {
    const D = ["вс", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
    const part = (v, unit, names) => v === "*" ? null : v.startsWith("*/") ? `каждые ${v.slice(2)} ${unit}` : v.replace(/\d+/g, (n) => (names ? names[+n] : n));
    let when;
    if (mi.startsWith("*/")) when = `каждые ${mi.slice(2)} мин`;
    else if (h === "*") when = mi === "*" ? "каждую минуту" : `каждый час в :${mi.padStart(2, "0")}`;
    else if (h.startsWith("*/")) when = `каждые ${h.slice(2)} ч в :${mi.padStart(2, "0")}`;
    else when = `в ${h.split(",").map((x) => (x.includes("-") ? x : x.padStart(2, "0") + ":" + mi.padStart(2, "0"))).join(", ")}`;
    const days = dow !== "*" ? `, ${part(dow, "дн", D)}` : "";
    const dates = dom !== "*" ? `, ${part(dom, "дн")} числа` : "";
    const months = mo !== "*" ? `, месяц ${part(mo, "мес")}` : "";
    return when + days + dates + months;
  }
  function regexText(r) {
    const T = [[/\^/, "^ — начало строки"], [/\$/, "$ — конец строки"], [/\\d/, "\\d — цифра"], [/\\w/, "\\w — буква/цифра/_"], [/\\s/, "\\s — пробел"], [/\\b/, "\\b — граница слова"],
      [/\.(?![*+?])/, ". — любой символ"], [/\.\*/, ".* — что угодно (жадно)"], [/\.\+\?|\*\?/, "*? / +? — лениво, как можно меньше"], [/\[[^\]]+\]/, "[…] — один из символов"], [/\[\^/, "[^…] — любой, кроме"],
      [/\{\d+(,\d*)?\}/, "{n,m} — от n до m раз"], [/\+/, "+ — один или больше"], [/\*(?!\?)/, "* — ноль или больше"], [/\?(?![:=!<])/, "? — необязательно"], [/\(\?:/, "(?:…) — группа без захвата"],
      [/\(\?<\w+>/, "(?<имя>…) — именованная группа"], [/\(\?=/, "(?=…) — дальше должно идти"], [/\(\?!/, "(?!…) — дальше НЕ должно идти"], [/\|/, "| — или"], [/\((?!\?)/, "(…) — группа с захватом"]];
    const out = T.filter(([re]) => re.test(r)).map(([, d]) => "· " + d);
    try { new RegExp(r); } catch (e) { out.unshift("⚠ ошибка: " + short(e.message, 60)); }
    return out.slice(0, 8).join("\n") || "простая строка без спецсимволов";
  }

  // ================= Горячие клавиши: Alt+C — ко мне, Alt+H — спрятать на этом сайте =================
  window.addEventListener("keydown", (e) => {
    if (!el || !e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.code;
    if (k === "KeyC") {
      if (host.style.display === "none") return;
      if (s.pinTop) setPinned(false);
      if (!ground) return;
      seq = null; walkPhase = 0;
      goTo(clamp((mouseX >= 0 ? mouseX : vw() / 2) - curW / 2, 0, Math.max(0, vw() - curW)), () => { pose("wave"); go("react", 1400); say(pick(["Звал?", "Здесь.", "Что?"]), 1300); });
      e.preventDefault();
    } else if (k === "KeyH") {
      chrome.storage.local.get({ disabledSites: [] }, (v) => {
        const set = new Set(v.disabledSites), h = location.hostname;
        set.has(h) ? set.delete(h) : set.add(h);
        chrome.storage.local.set({ disabledSites: [...set] });
      });
      e.preventDefault();
    }
  }, true);

  // ================= Голос: озвучка реплик и вопрос голосом =================
  function speak(text) {
    if (!s.voice || !window.speechSynthesis || document.hidden) return;
    const t = String(text).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}✨♥⚔️🍵🍡]/gu, "").trim();
    if (!t || t.length > 160) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(t);
      const v = speechSynthesis.getVoices().find((x) => /^ru/i.test(x.lang));
      if (v) u.voice = v;
      u.lang = "ru-RU"; u.pitch = 0.8; u.rate = 1.0; u.volume = clamp(Number(s.volume) || 0.5, 0, 1);
      speechSynthesis.speak(u);
    } catch {}
  }
  function voiceAsk() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { say("Браузер не умеет слушать голос.", 2000, { force: true }); return; }
    const r = new SR();
    r.lang = "ru-RU"; r.interimResults = false; r.maxAlternatives = 1;
    pose("think"); go("hold", 12000); say("🎤 Слушаю.", 12000, { force: true });
    r.onresult = (e) => {
      const q = e.results[0][0].transcript.trim();
      say(`«${short(q, 60)}»`, 1500, { force: true });
      const m = mathOf(q.replace(/плюс/g, "+").replace(/минус/g, "-").replace(/умножить на|на(?= \d)/g, "*").replace(/разделить на/g, "/"));
      if (m !== null) { setTimeout(() => { pose("cool"); go("react", 2500); say(`= ${m}`, 4000, { force: true }); }, 900); return; }
      setTimeout(() => askQuestion(q), 600);
    };
    r.onerror = (e) => { pose("shock"); go("react", 1500); say(e.error === "not-allowed" ? "Разреши микрофон для этого сайта." : "Не расслышал.", 2500, { force: true }); };
    r.onend = () => { if (state === "hold" && bubble.textContent.startsWith("🎤")) { hideBubble(); go("idle", 800); } };
    try { r.start(); } catch { say("Микрофон занят.", 1500, { force: true }); }
  }

  // ================= Погода (open-meteo, без ключа; запрос делает фоновый скрипт) =================
  const WCODE = { 0: "ясно ☀️", 1: "почти ясно 🌤", 2: "переменная облачность ⛅", 3: "пасмурно ☁️", 45: "туман 🌫", 48: "туман с изморозью 🌫", 51: "морось 🌦", 53: "морось 🌦", 55: "сильная морось 🌧",
    61: "небольшой дождь 🌧", 63: "дождь 🌧", 65: "ливень 🌧", 66: "ледяной дождь 🧊", 67: "ледяной дождь 🧊", 71: "небольшой снег 🌨", 73: "снег 🌨", 75: "снегопад ❄️", 77: "снежная крупа 🌨",
    80: "ливни 🌦", 81: "ливни 🌧", 82: "сильные ливни ⛈", 85: "снегопад 🌨", 86: "сильный снегопад ❄️", 95: "гроза ⛈", 96: "гроза с градом ⛈", 99: "гроза с градом ⛈" };
  async function weatherSay(force) {
    if (!s.weatherOn && !force) return;
    const w = await msg({ type: "weather" });
    if (!w || !w.ok) { if (force) say(w?.error === "city" ? "Город не найден. Проверь настройки." : "Погода не загрузилась.", 2500, { force: true }); return; }
    const sgn = (t) => (t > 0 ? "+" : "") + Math.round(t) + "°";
    const lines = [`${w.city}: сейчас ${sgn(w.t)}, ${WCODE[w.code] || "погода как погода"}`, `днём ${sgn(w.min)}…${sgn(w.max)}`];
    if (w.rain >= 50) lines.push(`Осадки ${w.rain}%. Возьми зонт.`);
    else if (w.t <= 3) lines.push("Холодно. Оденься теплее.");
    else if (w.max >= 33) lines.push("Жара. Пей воду.");
    pose(w.t <= 3 ? "pout" : "wave"); go("react", 3000);
    say(lines.join("\n"), 9000, { force: true, long: true });
  }

  // ================= Пыль при приземлении =================
  function dust(n = 5) {
    for (let i = 0; i < n; i++) {
      const d = document.createElement("i"); d.className = "dust";
      d.style.left = (50 + rnd(-30, 30)) + "%"; d.style.setProperty("--dx", rnd(-28, 28).toFixed(0) + "px");
      d.addEventListener("animationend", () => d.remove());
      el.appendChild(d);
    }
  }

  // ================= Физика =================
  // Элементы сайта, на которые можно встать (кэш на 0.7 с)
  // Элементы, на которые можно встать, вместе с их прямоугольниками.
  // Меряем страницу не чаще раза в 0.4 с (после прокрутки — через 0.12 с), а не каждый кадр: так сайт не тормозит.
  let scrolledAt = 0;
  window.addEventListener("scroll", () => { scrolledAt = performance.now(); }, { passive: true, capture: true });
  function surfaces() {
    const now = performance.now();
    const age = now - surfaces.t;
    if (age < 400 && !(scrolledAt > surfaces.t && age > 120)) return surfaces.list;
    surfaces.t = now;
    const list = [];
    if (s.platforms) {
      const els = document.querySelectorAll(PLAT_SEL), W_ = vw(), H_ = vh();
      for (let i = 0; i < els.length && i < 800 && list.length < 120; i++) {
        const e = els[i];
        const r = e.getBoundingClientRect();
        if (r.width < 70 || r.height < 18 || r.top < 40 || r.top > H_ - 40 || r.right < 0 || r.left > W_) continue;
        if (e.checkVisibility && !e.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
        list.push({ e, l: r.left, r: r.right, top: r.top });
      }
    }
    return (surfaces.list = list);
  }
  surfaces.t = 0; surfaces.list = [];
  // прямоугольник того, на чём стоит, — тоже не чаще раза в 0.1 с (и сразу после прокрутки)
  let gRect = null, gRectT = 0, gRectEl = null;
  function groundRect(e) {
    const now = performance.now();
    if (gRectEl !== e || now - gRectT > 100 || scrolledAt > gRectT) { gRect = e.getBoundingClientRect(); gRectT = now; gRectEl = e; }
    return gRect;
  }
  // соседний элемент на той же высоте под ногами — чтобы переходить без «падения» и рывков
  function surfaceAt(cx, py, not) {
    for (const it of surfaces()) {
      if (it.e === not || !it.e.isConnected) continue;
      if (Math.abs((vh() - it.top) - py) <= 4 && cx > it.l + 2 && cx < it.r - 2) return it.e;
    }
    return null;
  }

  // Параметры «игрушечной» физики
  const PHY = {
    airDrag: 0.82,        // доля горизонтальной скорости, остающаяся через 1 с полёта
    wallBounce: 0.62,     // упругость стен
    floorBounce: 0.48,    // упругость пола (для брошенного)
    bounceMin: 520,       // ниже этой скорости удара — уже не отскакивает
    slideFriction: 0.06,  // доля скорости при скольжении по полу через 1 с
    hardHit: 1500,        // удар сильнее — шлёпается лицом и валяется
  };

  function launch(nvx, nvy, wasThrown) {
    ground = null; vx = nvx; vy = nvy; thrown = wasThrown; bounces = 0; fallFrom = yb;
    airPeak = yb; airAt = performance.now();
    state = "air";
    setAnim("");
  }
  function fall() { launch(state === "walk" ? dir * 70 : 0, 0, false); }

  // Прыжок на элемент повыше: присел → прыгнул
  function tryJump() {
    const cx = x + curW / 2, cur = yb, cands = [];
    for (const it of surfaces()) {
      const r = { left: it.l, right: it.r, top: it.top };
      const py = vh() - r.top, dh = py - cur;
      if (dh < 50 || dh > 300) continue;
      const tx = clamp(cx, r.left + 20, r.right - 20);
      if (Math.abs(tx - cx) > 380 || r.right - r.left < curW * 0.6) continue;
      if (r.top - H() < 0) continue;
      cands.push({ r, dh });
    }
    if (!cands.length) return false;
    const c = pick(cands);
    const tx = clamp(rnd(c.r.left + 20, c.r.right - 20), 0, vw());
    const up = c.dh + 40;
    const v0 = Math.sqrt(2 * G * up);
    const T = v0 / G + Math.sqrt(2 * 40 / G);
    dir = tx > cx ? 1 : -1;
    play([{ p: "crouch", ms: 260 }], () => { jumping = true; SND.jump(); launch((tx - cx) / T, v0, false); });
    return true;
  }

  function bonk(force) {
    const now = performance.now();
    if (now - lastBonk < 500) return;
    lastBonk = now;
    squash(); SND.land();
    if (force > 900 && Math.random() < 0.6) say(pick(["Тц.", "Стена.", "…", "Хм."]), 900);
  }

  // Какой кадр показывать в полёте — по скорости и вращению
  let airPoseAt = 0, airPeak = 0, airAt = 0;
  function airPoseSet(p, look) {
    const now = performance.now();
    if (p !== curPose && curPose !== "crouch" && now - airPoseAt < 180 && p !== "tumble") return;
    if (p !== curPose) airPoseAt = now;
    pose(p, look);
  }
  function airPose() {
    if (state === "held") return;
    if (yb > airPeak) airPeak = yb;
    const look = Math.sign(vx) || dir;
    // «падение с раскрытым плащом» — только для настоящего падения с высоты,
    // а не для прыжка на сантиметр или шага с края
    const big = airPeak - yb > H() * 1.2 || vy < -1000;
    if (Math.abs(spin) > 260) { airPoseSet("tumble"); return; }
    if (entering) { airPoseSet(vy > 120 ? "leap" : big ? "fall" : Math.abs(vx) > 420 ? "fly" : "leap", look); return; }
    if (jumping) { airPoseSet(big && vy < 0 ? "fall" : "leap", look); return; }
    if (thrown) {
      if (Math.abs(vx) > 520 && Math.abs(vx) > Math.abs(vy) * 0.6) { airPoseSet("fly", look); return; }
      airPoseSet(big ? "fall" : "held", look);         // подбросили несильно — висит в воздухе, скрестив руки
      return;
    }
    // шагнул с края / маленький перепад — остаётся в своей позе, пока это не настоящее падение
    if (!big || performance.now() - airAt < 160) return;
    airPoseSet("fall", look);
  }


  function air(dt) {
    const prev = yb;
    vy -= G * dt;
    x += vx * dt; yb += vy * dt;
    vx *= Math.pow(PHY.airDrag, dt);
    rot += spin * dt; spin *= Math.pow(0.7, dt);
    if (Math.abs(spin) < 260 && Math.abs(rot % 360) > 1) rot += (Math.round(rot / 360) * 360 - rot) * Math.min(1, dt * 8); // докручиваемся ровно
    const maxX = Math.max(0, vw() - curW);
    if (entering && x >= 0 && x <= maxX) entering = "inside";
    if (entering !== true && (x < 0 || x > maxX)) {
      const f = Math.abs(vx);
      x = clamp(x, 0, maxX);
      vx = (x <= 0 ? 1 : -1) * f * PHY.wallBounce;
      if (f > 900) spin = clamp(-spin * 0.6 + (x <= 0 ? 1 : -1) * 400, -1100, 1100);
      bonk(f);
    }
    const ceil = vh() - H() * 0.95;
    if (yb > ceil) { yb = ceil; bonk(Math.abs(vy)); vy = -Math.abs(vy) * 0.35; }
    airPose();
    if (vy > 0) return;
    // приземление: пол или верх элемента, пересечённый за этот кадр
    const cx = x + curW / 2;
    let land = null, landY = -1;
    if (yb <= 0) { land = "floor"; landY = 0; }
    const cands = s.platforms ? surfaces() : [];
    const list = jumpTarget && jumpTarget.isConnected && !cands.some((c) => c.e === jumpTarget)
      ? [...cands, (() => { const r = groundRect(jumpTarget); return { e: jumpTarget, l: r.left, r: r.right, top: r.top }; })()] : cands;
    for (const it of list) {
      if (!it.e.isConnected) continue;
      const py = vh() - it.top;
      if (py <= prev + 1 && py >= yb - 1 && cx > it.l + 6 && cx < it.r - 6 && py > landY) { land = it.e; landY = py; }
    }
    if (!land) return;
    yb = landY;
    const impact = -vy;
    if (thrown && impact > PHY.bounceMin && bounces < 6) {   // отскок, как у мячика
      bounces++; airPeak = yb;                              // после отскока считаем высоту заново
      vy = impact * PHY.floorBounce;
      vx *= 0.8;
      spin = spin * 0.6 + vx * 0.25;
      maxImpact = Math.max(maxImpact, impact);
      squash(); SND.boing(); dust(4);
      if (impact > PHY.hardHit && bounces === 1) say(pick(["Тц.", "…", "Хм."]), 900);
      return;
    }
    maxImpact = Math.max(maxImpact, impact);
    touchDown(land);
  }
  function squash() { el.classList.remove("squash"); void el.offsetWidth; el.classList.add("squash"); }

  function touchDown(land) {
    ground = land; vy = 0; spin = 0; rot = 0; jumping = false;
    if (entering) {
      entering = false; vx = 0; spin = 0; rot = 0; squash(); SND.land(); dust(5);
      x = clamp(x, 0, Math.max(0, vw() - curW));
      play([{ p: "crouch", ms: 220 }], () => { pose("wave"); go("react", 1400); if (Math.random() < 0.45) say(pick(["Здесь.", "…", "Другая вкладка.", "Хм.", "На месте."]), 1400); });
      return;
    }
    const cb = onJumpLand, hitTarget = jumpTarget && land === jumpTarget;
    jumpTarget = null; onJumpLand = null;
    if (cb && !thrown) {
      vx = 0; squash();
      if (hitTarget) { play([{ p: "crouch", ms: 200 }], cb); return; }
      // промахнулся — постоит, отряхнётся
      play([{ p: "crouch", ms: 240 }], () => { go("idle", 1200); if (Math.random() < 0.5) say(pick(["Промах.", "Ещё раз.", "Неважно."]), 1300); });
      return;
    }
    const hard = thrown && (maxImpact > PHY.hardHit || bounces >= 2);
    const wasThrown = thrown;
    thrown = false; maxImpact = 0; bounces = 0;
    squash();
    if (hard || (wasThrown && Math.abs(vx) > 250)) {
      // шлёпнулся: скользит лицом по полу, лежит, сидит с звёздочками, потирает шишку
      sliding = Math.abs(vx) > 60;
      SND.thud(); dust(8);
      play([
        { p: "splat", ms: 1300, until: () => !sliding },
        { p: "dizzy", ms: 1700, say: pick(["…Неплохой бросок.", "Тц.", "…", "Не повторяй."]) },
        { p: "rub", ms: 1400, say: Math.random() < 0.5 ? pick(["Хватит.", "Зачем?", "Тц."]) : "" },
      ], () => go("idle", rnd(800, 1600)));
      return;
    }
    vx = 0;
    if (pendingGoto && !wasThrown) {
      const g = pendingGoto; pendingGoto = null;
      play([{ p: "crouch", ms: 200 }], () => { goTo(g.x, g.then); until = Math.max(until, g.until); });
      return;
    }
    if (wasThrown) play([{ p: "crouch", ms: 220 }, { p: "shock", ms: 700, say: pick(["Тц.", "Приземлился.", "Зачем?"]) }], () => go("idle", 1200));
    else if (fallFrom - yb > 160) play([{ p: "crouch", ms: 240 }], () => go("idle", rnd(800, 1500)));
    else go("idle", rnd(800, 1800));
  }

  // Последовательность кадров: [{p: поза, ms, say, until}], потом done()
  function play(steps, done) {
    seq = { steps, i: -1, t: 0, done };
    state = "seq";
    setAnim("breathe");
    nextStep();
  }
  function nextStep() {
    seq.i++;
    const st = seq.steps[seq.i];
    if (!st) { const d = seq.done; seq = null; d && d(); return; }
    seq.t = performance.now() + st.ms;
    pose(st.p, dir);
    if (st.say) say(st.say);
  }

  function onGround(dt, t, pdt = dt) {
    if (ground !== "floor") {
      const e = ground;
      if (!e.isConnected) return fall();
      const r = groundRect(e);
      if (r.top < 30 || r.top > vh() || r.width < 40) return fall();   // элемент уехал при прокрутке
      yb = vh() - r.top;
      const cx = x + curW / 2;
      if (cx < r.left || cx > r.right) {
        const next = surfaceAt(cx, yb, e);                                // рядом элемент на той же высоте — просто идёт дальше
        if (next) { ground = next; gRectEl = null; return; }
        // сошёл с края
        if (state === "goto" && gotoThen) { pendingGoto = { x: gotoX, then: gotoThen, until }; gotoThen = null; state = "walk"; }
        return fall();
      }
      platEdges = [r.left, r.right];
    } else yb = 0;

    if (sliding) {                       // скольжение после падения
      x += vx * pdt;
      vx *= Math.pow(PHY.slideFriction, pdt);
      const maxX = Math.max(0, vw() - curW);
      if (x < 0 || x > maxX) { x = clamp(x, 0, maxX); vx = -vx * 0.4; bonk(Math.abs(vx)); }
      if (Math.abs(vx) < 40) { sliding = false; vx = 0; }
    }

    if (state === "meditate") { meditateTick(t); return; }
    if (wantInput && state !== "seq" && state !== "goto") {
      if (document.activeElement === wantInput && wantInput.isConnected) { approachInput(wantInput); return; }
      wantInput = null;
    }
    if (state === "chase") { chaseTick(dt, t); return; }
    if (state === "goto") { gotoTick(dt, t); return; }
    if (state === "watchInput") { if (!watchInput || t > until) go("idle", 1200); return; }
    blinkTick(t);
    if (state === "seq") {
      const st = seq && seq.steps[seq.i];
      if (st && t > seq.t && (!st.until || st.until())) nextStep();
      return;
    }
    if (state === "walk") {
      const sp = Number(s.speed) || 1;
      const frames = skinCfg.walk;
      const fi0 = Math.floor(walkPhase) % frames.length;
      walkPhase += dt * skinCfg.walkFps * sp;   // ноги в такт шагу: без «скольжения»
      const fi = Math.floor(walkPhase) % frames.length;
      if (fi !== fi0 && fi % Math.max(1, frames.length / 2) === 0) SND.step();
      pose(frames[fi], dir);
      const step = 55 * sp * dt * (H() / 140);
      x += dir * step; walkedPx += step;
      const maxX = Math.max(0, vw() - curW);
      if (x < 0 || x > maxX) x = clamp(x, 0, maxX);
      // разворачивается, только если идёт В стену (после разворота кадр сдвигается — не «залипает» у края)
      if ((x <= 0 && dir < 0) || (x >= maxX && dir > 0)) {
        // упёрся в край окна — иногда лезет по стене
        if (ground === "floor" && s.physics && has("climb1") && Math.random() < 0.4) { startClimb(x <= 0 ? -1 : 1); return; }
        dir = -dir;
      }
      if (ground !== "floor") {
        const cx = x + curW / 2, [l, r] = platEdges;
        const near = dir > 0 ? r - cx < 14 : cx - l < 14;
        if (near && !edgeDecided) {
          edgeDecided = true;
          const q = Math.random();
          if (q < 0.45) dir = -dir;
          else if (q < 0.7) { go("perch", rnd(5000, 11000)); if (Math.random() < 0.3) say(pick(["Хороший обзор.", "Посижу здесь.", "…"])); }
        }
        if (!near) edgeDecided = false;
      }
      if (t > until) nextState();
    } else if (t > until) nextState();
  }

  // ===== Закреплён наверху: сидит на верхнем краю окна, свесив ноги =====
  function pinnedTick(t) {
    if (!pinned) {           // только что закрепили
      pinned = true; ground = "floor"; vx = vy = spin = rot = 0; seq = null; sliding = false; jumping = false;
      pose("sit", 0); state = "pin"; until = t + rnd(4000, 8000); setAnim("breathe");
    }
    x = clamp(x, 0, Math.max(0, vw() - curW));
    yb = vh() - curH + feetPad();   // верх картинки — у верхнего края окна
    if (t < until) return;
    if (s.sleepIdle && Date.now() - lastUserAct > 90000) { state = "sleep"; pose("sleep", 0); setAnim("breathe"); el.classList.add("sleeping"); until = t + 30000; return; }
    el.classList.remove("sleeping");
    state = "pin";
    const p = Math.random() < 0.5 ? "sit" : pick(PIN_POSES);
    pose(p, 0);
    setAnim(p === "laugh" || p === "cool" || p === "wave" ? "happy" : "breathe");
    if (p !== "sit" && Math.random() < 0.25) say(s.pageTalk && pageInfo && Math.random() < 0.5 ? topicLine() : pick(["Наблюдаю.", "Сверху видно всё.", ...PHRASES]));
    until = t + rnd(4000, 9000);
  }
  function setPinned(on) {
    if (s.pinTop === on) return;
    s.pinTop = on;
    try { chrome.storage.local.set({ pinTop: on }); } catch {}
  }

  function loop(t) {
    raf = 0;
    if (!alive()) { host.remove(); return; }
    if (host.style.display === "none") return;
    const dt = Math.min(50, t - lastT) / 1000;
    lastT = t;
    // «Скорость физики» замедляет полёт и падение целиком, как замедленная съёмка: траектории те же
    const pdt = dt * clamp(Number(s.physSpeed) || 0.7, 0.2, 2);
    if (!dragging) {
      if (s.pinTop) pinnedTick(t);
      else if (state === "climb") climbTick(dt);
      else if (state === "hang") hangTick(dt, t);
      else if (state === "flight") flightTick(dt);
      else if (!ground) { if (state !== "air") state = "air"; air(pdt); }
      else onGround(dt, t, pdt);
    }
    if (bugs.length) bugsTick(dt);
    el.classList.toggle("top", !!s.pinTop && !dragging);
    el.style.transform = `translate(${x}px, ${-yb + feetPad()}px)`;
    spinEl.style.transform = rot ? `rotate(${rot}deg)` : "";
    raf = requestAnimationFrame(loop);
  }

  // ================= Мышь: клик, двойной клик, перетаскивание, бросок =================
  function onDown(e) {
    if (e.button !== 0) return;
    // выделенный текст читаем до того, как браузер его сбросит
    downSel = currentSelection() || (Date.now() - lastSel.at < 8000 ? lastSel.text : "");
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    dragging = true; moved = false; downAt = performance.now();
    dragDX = e.clientX - x;
    dragDY = (vh() - e.clientY) - yb;
    samples = [{ t: downAt, x, y: yb }];
    el.classList.add("drag");
    try { el.setPointerCapture(e.pointerId); } catch {}
    void r;
  }
  function onMove(e) {
    if (!dragging) {
      if (!greeted && state !== "sleep" && ground) {
        const r = el.getBoundingClientRect();
        if (Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) < H() * 0.9) {
          greeted = true; pose("cool"); go("react", 1800); say("…");
        }
      }
      return;
    }
    const nx = e.clientX - dragDX, ny = (vh() - e.clientY) - dragDY;
    if (!moved && Math.abs(nx - x) + Math.abs(ny - yb) > 4) {
      moved = true; ground = null; rot = 0; spin = 0; state = "held"; seq = null; sliding = false; jumping = false; fl = null;
      jumpTarget = null; onJumpLand = null; gotoThen = null; pendingGoto = null; watchInput = null; wantInput = null;
      entering = false; pinned = false;
      el.style.opacity = ""; el.style.transition = "";            // прятки: не остаться невидимым
      el.classList.remove("aura", "sleeping");                     // медитация, сон
      closeMenu(); closeAsk();
      pose("held", 0); setAnim(""); hideBubble();
      if (Math.random() < 0.35) say(pick(["Поставь.", "Руки.", "Не за шкирку."]), 1400);
      clearTimeout(onMove.plead);
      onMove.plead = setTimeout(() => { if (dragging && state === "held") trickPlead(); }, 1600);
    }
    if (!moved) return;
    x = nx; yb = Math.max(0, ny);
    const now = performance.now();
    samples.push({ t: now, x, y: yb });
    while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    clearTimeout(onMove.plead);
    if (maskWhy === "held") setTimeout(() => { if (maskWhy === "held") setMask("stern", "", 0, pick(AFTER_HELD)); }, 2600);
    el.classList.remove("drag");
    if (!moved) {
      if (performance.now() - downAt < 450) onClick();
      return;
    }
    // отпустил у самого верхнего края (и не швырнул) — закрепляется там
    const topGap = vh() - (yb + curH);
    const stopped = performance.now() - samples.at(-1).t > 120;
    const lastV = !stopped && samples.length > 1 ? Math.hypot(samples.at(-1).x - samples[0].x, samples.at(-1).y - samples[0].y) / Math.max(0.016, (samples.at(-1).t - samples[0].t) / 1000) : 0;
    if (topGap < 50 && lastV < 1500) { pinned = false; setPinned(true); say(pick(["Займу высоту.", "Здесь.", "Сверху лучше."]), 1600); return; }
    if (s.pinTop) { setPinned(false); pinned = false; }
    // скорость броска по последним ~100 мс движения
    const a = samples[0], b = samples[samples.length - 1];
    const dt = Math.max(16, b.t - a.t) / 1000;
    let tvx = (b.x - a.x) / dt, tvy = (b.y - a.y) / dt;
    if (performance.now() - b.t > 120) { tvx = 0; tvy = 0; } // остановил мышь перед отпусканием
    tvx = clamp(tvx, -4200, 4200); tvy = clamp(tvy, -4200, 4200);
    if (!s.physics) { tvx = 0; tvy = 0; }
    const speed = Math.hypot(tvx, tvy);
    launch(tvx, tvy, true);
    
    if (speed > 300) stat("throws");
    if (speed > 900) SND.whoosh();
    // сильный бросок — кувырком, средний — летит «суперменом»
    spin = speed > 1900 && Math.random() < 0.6 ? clamp(tvx * 0.35, -1000, 1000) || 450 : 0;
    lastUserAct = Date.now();
  }
  function onClick() {
    lastUserAct = Date.now();
    const now = performance.now();
    if (now - lastClick < 330) { clearTimeout(clickTimer); lastClick = 0; openAsk(); return; }
    lastClick = now;
    const sel = downSel;
    if (state === "seq") { say(pick(["Дай встать.", "Подожди.", "…"])); return; }
    clickTimer = setTimeout(() => {
      if (sel && sel.length >= 2) { explainSelection(sel); return; }
      if (trickClick()) return;
      const r = pick(mask === "cute" ? CUTE_CLICK : CLICK_REACT);
      pose(r); go("react", 1600);
      if (Math.random() < 0.6) say(mask === "cute" ? pick(CUTE_PHRASES) : s.pageTalk && pageInfo && Math.random() < 0.4 ? topicLine() : pick(PHRASES));
    }, 280);
  }

  // ================= Чтение сайта (без нейросети) =================
  const TOPICS = [
    { id: "code", host: /github|gitlab|bitbucket|stackoverflow|stackexchange|leetcode|codeforces|npmjs|developer\.mozilla|docs\.python|pypi|replit|codepen|habr|php\.net/,
      kw: /\b(function|const|import|return|class|def|npm|git|python|javascript|typescript|php|null|async)\b/g,
      say: ["Код. Баг уже нашёл?", "Коммит не забудь.", "Работает — не трогай.", "Читай внимательно.", "Сначала тесты."] },
    { id: "ai", host: /gemini\.google|claude\.ai|chatgpt|chat\.openai|perplexity|deepseek|copilot\.microsoft/,
      say: ["Нейросети. Проверяй, что они говорят.", "Не верь на слово — проверь.", "Полезный инструмент. Не больше."] },
    { id: "novel", host: /webnovel|novelupdates|ranobe|ranobelib|mangalib|remanga|shikimori|anilist|myanimelist|wuxiaworld|bilibili|wattpad|ficbook|author\.today/,
      kw: /культивац|секта|даос|бессмерт|cultivat|sect|immortal|dao|глава \d+|chapter \d+/g,
      say: ["Новелла. Одну главу — и за дело.", "Этот культиватор слаб.", "Сюжет затянут.", "Я бы победил его без меча."] },
    { id: "video", host: /youtube\.com|youtu\.be|twitch\.tv|vimeo|rutube|kinopoisk|netflix|tiktok/,
      say: ["Видео. Не залипай.", "Одно видео. Потом работа.", "Смотри на 1.5x."] },
    { id: "music", host: /spotify|music\.yandex|soundcloud|music\.youtube|music\.apple|deezer/,
      say: ["Музыка. Не громко.", "Работай под неё."] },
    { id: "finance", host: /uzse|tradingview|investing\.com|bloomberg|finance\.yahoo|binance|birja|stock|kapital|kun\.uz\/biznes/,
      kw: /акци|бирж|дивиденд|котировк|stock|shares|dividend|ticker|aksiya|birja/g,
      say: ["Графики. Без эмоций.", "Падение — не повод паниковать.", "Терпение важнее скорости.", "Не клади всё в одну корзину."] },
    { id: "social", host: /telegram|instagram|vk\.com|x\.com|twitter|facebook|discord|whatsapp|threads\.net|reddit/,
      say: ["Переписки. Недолго.", "Ответь и возвращайся.", "Не залипай."] },
    { id: "shop", host: /uzum|ozon|wildberries|aliexpress|amazon|olx|market|ebay|temu|asaxiy|texnomart/,
      kw: /корзин|купить|в корзину|add to cart|buy now|цена|price|savatcha/g,
      say: ["Это точно нужно?", "Сначала отзывы.", "Скидки обманчивы."] },
    { id: "news", host: /kun\.uz|gazeta\.uz|daryo|news|bbc|cnn|lenta|ria\.ru|rbc|meduza|reuters|podrobno/,
      say: ["Новости. Без комментариев.", "Шумно в мире."] },
    { id: "learn", host: /wikipedia|wiki|arxiv|khanacademy|coursera|stepik|udemy|edx|wolframalpha|brilliant|scholar\.google/,
      kw: /физик|математ|формул|теорем|уравнен|интеграл|производн|physics|theorem|equation|integral|derivative|matrix|матриц/g,
      say: ["Учёба. Правильно.", "Знание — сила.", "Разберись до конца.", "Формулу — выдели, посчитаю."] },
    { id: "mail", host: /mail\.google|outlook|mail\.ru|mail\.yandex|proton\.me/,
      say: ["Почта. Ответь главным.", "Входящие не ждут."] },
    { id: "games", host: /steampowered|steamcommunity|epicgames|itch\.io|chess\.com|lichess|roblox|minecraft/,
      say: ["Игры. После работы.", "Одна партия. Не больше."] },
    { id: "work", host: /docs\.google|sheets|notion|figma|office|sharepoint|trello|jira|atlassian|miro|crm/,
      say: ["Работа. Хорошо.", "Ctrl+S не забывай.", "Дедлайн помнишь?"] },
    { id: "search", host: /google\.[a-z.]+\/search|yandex\.[a-z]+\/search|bing\.com\/search|duckduckgo/,
      say: ["Уточни запрос.", "Ищи на английском — найдёшь больше."] },
  ];
  const GENERIC = { id: "generic", say: ["Хм.", "Обычный сайт.", "…", "Посмотрим."] };
  // больше реплик по темам
  const MORE = {};
  for (const t of TOPICS) if (MORE[t.id]) t.say.push(...MORE[t.id]);
  PHRASES.push("Спина ровно.", "Моргни. Глаза не железные.", "Ошибки ищи сам, потом зови меня.", "Терпение — тоже сила.", "Слабая ци у этого кода.", "Не спеши. Делай правильно.", "Ctrl+S.", "Я слежу за багами.");

  function analyzePage() {
    const h = location.hostname + location.pathname;
    let tp = TOPICS.find((t) => t.host && t.host.test(h));
    if (!tp) {
      const text = ((document.title || "") + " " + textSample(document.body, 20000)).toLowerCase();
      let best = null, bestN = 0;
      for (const t of TOPICS) {
        if (!t.kw) continue;
        const n = (text.match(t.kw) || []).length;
        if (n > bestN) { bestN = n; best = t; }
      }
      tp = bestN >= 6 ? best : GENERIC;
    }
    return { tp, title: shortTitle() };
  }
  function shortTitle() {
    const t = (document.title || "").split(/\s[|\-–—·•:]\s/)[0].trim();
    if (t.length < 3) return "";
    return t.length > 38 ? t.slice(0, 36).trim() + "…" : t;
  }
  function topicLine() {
    if (!pageInfo) pageInfo = analyzePage();
    const facts = readPage();
    if (facts.length && Math.random() < 0.5) return pick(facts);
    const t = pageInfo.title;
    if (t && Math.random() < 0.3) return pick([`«${t}».`, `«${t}». Читай внимательно.`, `«${t}». Хм.`]);
    return pick(pageInfo.tp.say);
  }

  async function pageHello() {
    if (!s.pageTalk || !el || host.style.display === "none") return;
    await new Promise((r) => idle(r));          // читаем страницу, когда браузер свободен
    pageInfo = analyzePage();
    const h = new Date().getHours();
    if (h >= 0 && h < 5 && Math.random() < 0.7) { pose("sleep"); go("react", 2500); say(pick(["Ночь. Спать.", "Поздно. Отдых — тоже культивация.", "Хватит на сегодня."])); return; }
    if (s.ai && s.aiComments && !document.querySelector("input[type=password]") && Math.random() < 0.6) {
      const r = await askAI("comment", { title: document.title, url: location.href, text: pageExcerpt(1500) });
      if (r.ok) { pose(pick(["laugh", "cool", "wave"])); go("react", 2500); say(r.text, 0, { force: false }); return; }
    }
    if (Math.random() < 0.75) {
      const facts = readPage();
      pose(pick(["wave", "think", "laugh"])); go("react", 2400);
      say(facts.length && Math.random() < 0.65 ? pick(facts) : topicLine());
    }
  }
  // Сайты-приложения (YouTube и т.п.) меняют страницу без перезагрузки — следим за адресом
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    pageInfo = null; pageFacts = null; setTimeout(focusCheck, 1500);
    if (Math.random() < 0.45) setTimeout(pageHello, rnd(2500, 5000));
  }, 2000);

  function pageExcerpt(n) {
    const main = document.querySelector("main, article, [role=main]") || document.body;
    return textSample(main, n).trim();
  }

  // ================= Выделенный текст =================
  function currentSelection() {
    try {
      const sel = getSelection();
      if (!sel || sel.isCollapsed) return "";
      if (host && sel.anchorNode && host.contains(sel.anchorNode)) return "";
      return sel.toString().trim().slice(0, 6000);
    } catch { return ""; }
  }
  function onSelChange() {
    const t = currentSelection();
    if (t) lastSel = { text: t, at: Date.now() };
  }
  function onSelectDone() {
    if (!s.selectTalk || !el || dragging || host.style.display === "none") return;
    const t = currentSelection();
    if (!t || t.length < 2) return;
    // 1) пример — посчитать
    const m = mathOf(t);
    if (m !== null && t !== lastMathSel) {
      lastMathSel = t;
      pose("think"); go("react", 600);
      setTimeout(() => { pose("cool"); go("react", 2500); say(`${t.length > 30 ? t.slice(0, 28) + "…" : t} = ${m}`, 6000, { force: true }); }, 450);
      return;
    }
    // 2) JSON, время Unix, цвет, base64, JWT, списки чисел — расскажет сам
    const f = selectionFacts(t);
    if (f && f.auto && t !== lastMathSel) {
      lastMathSel = t;
      pose("think"); go("react", 500);
      setTimeout(() => { pose("cool"); go("react", 2800); say(f.text, 0, { force: true, long: f.text.length > 40 }); if (f.color) particles("●", 3, f.color); }, 400);
      return;
    }
    // 3) подсказка, что можно кликнуть — один раз за страницу
    if (!selHinted && t.length > 3) {
      selHinted = true;
      const words = t.split(/\s+/).length;
      if (s.ai) say(words > 60 ? "Кликни — перескажу." : "Кликни — объясню.");
      else if (looksLikeCode(t)) say("Код. Кликни — разберу.");
      else if (words > 25) say("Кликни — разберу текст.");
    }
  }
  async function explainSelection(t) {
    if (!s.ai) {
      const m = mathOf(t);
      if (m !== null) { pose("cool"); go("react", 2500); say(`= ${m}`, 5000, { force: true }); return; }
      const f = selectionFacts(t);
      pose("think"); go("react", 1200);
      setTimeout(() => { pose(f ? "cool" : "think"); go("react", 3500); say(f ? f.text : "Без умного режима — нечего сказать.", 0, { force: true, long: !!f?.long || (f?.text || "").length > 40 }); }, 700);
      return;
    }
    thinking();
    const r = await askAI("explain", { text: t.slice(0, 5000), title: document.title, url: location.href });
    answer(r);
  }

  // Безопасный калькулятор: + - * / ^ % ( ), десятичные через точку или запятую
  function mathOf(raw) {
    const t = raw.replace(/\s+/g, "").replace(/[×xх·]/gi, "*").replace(/[÷:]/g, "/").replace(/−/g, "-").replace(/=+$/, "");
    if (t.length > 60 || !/^[\d.,+\-*/^%()]+$/.test(t) || !/\d[+\-*/^%]+[\d(]/.test(t)) return null;
    const src = t.replace(/(\d),(\d)/g, "$1.$2");
    let i = 0;
    const peek = () => src[i];
    function num() {
      let j = i;
      while (j < src.length && /[\d.]/.test(src[j])) j++;
      if (j === i) throw 0;
      const v = parseFloat(src.slice(i, j));
      if (Number.isNaN(v)) throw 0;
      i = j;
      return v;
    }
    function atom() {
      if (peek() === "-") { i++; return -atom(); }
      if (peek() === "+") { i++; return atom(); }
      if (peek() === "(") { i++; const v = expr(); if (peek() !== ")") throw 0; i++; return v; }
      return num();
    }
    function power() { const b = atom(); if (peek() === "^") { i++; return Math.pow(b, power()); } return b; }
    function term() {
      let v = power();
      for (;;) {
        const c = peek();
        if (c === "*") { i++; v *= power(); }
        else if (c === "/") { i++; v /= power(); }
        else if (c === "%") { i++; v %= power(); }
        else return v;
      }
    }
    function expr() {
      let v = term();
      for (;;) {
        const c = peek();
        if (c === "+") { i++; v += term(); }
        else if (c === "-") { i++; v -= term(); }
        else return v;
      }
    }
    try {
      const v = expr();
      if (i !== src.length || !Number.isFinite(v)) return null;
      return Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(10)));
    } catch { return null; }
  }

  // ================= Умный режим (Gemini через фоновый скрипт) =================
  const AI_ERR = {
    nokey: "Нужен ключ Gemini в настройках.",
    nokeyClaude: "Нужен ключ Claude API в настройках.",
    busy: "Нейросеть перегружена. Через минуту.",
    credits: "На счёте API нет денег.",
    badkey: "Ключ не подошёл. Проверь настройки.",
    limit: "Лимит исчерпан. Позже.",
    model: "такой модели нет — проверь название в настройках",
    net: "Нет связи с нейросетью.",
    conn: "Перезагрузи страницу.",
    empty: "Сказать нечего.",
    cooldown: "",
  };
  function askAI(mode, payload) {
    return new Promise((res) => {
      if (!alive()) return res({ ok: false, error: "conn" });
      try {
        chrome.runtime.sendMessage({ type: "ai", mode, ...payload }, (r) => {
          if (chrome.runtime.lastError || !r) res({ ok: false, error: "conn" });
          else res(r);
        });
      } catch { res({ ok: false, error: "conn" }); }
    });
  }
  function thinking() { sternNow(); pose("think"); go("hold", 45000); sayQueue = []; show("… думаю", 45000, {}, 1); }
  function answer(r) {
    hideBubble(); sayQueue = [];
    if (r.ok) { pose("cool"); go("react", 2500); say(r.text, 0, { ai: true }); }
    else { pose("shock"); go("react", 1800); say(AI_ERR[r.error] || ("Ошибка: " + r.error), 7000, { force: true }); }
  }
  function openAsk() {
    pose("think"); go("hold", 60000);
    hideBubble();
    askBox.classList.add("on");
    keepOnScreen(askBox);
    askInput.value = "";
    setTimeout(() => askInput.focus(), 0);
  }
  function closeAsk() {
    if (!askBox.classList.contains("on")) return;
    askBox.classList.remove("on");
    if (state === "hold" && !bubble.classList.contains("on")) go("idle", 1500);
  }
  async function askQuestion(q) {
    if (!s.ai) { pose("think"); go("react", 3000); say("включи «умный режим» и вставь ключ в настройках", 6000, { force: true }); return; }
    thinking();
    const r = await askAI("ask", { question: q, text: pageExcerpt(6000), title: document.title, url: location.href });
    answer(r);
  }

  // Команды для автотестов — только на локальном сервере разработки
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    window.addEventListener("message", (e) => {
      const c = e.data && e.data.chibiTest;
      if (!c || !el) return;
      if (c === "climb") { x = vw(); startClimb(1); climbTarget = vh(); }
      else if (c === "chase") { walkPhase = 0; go("chase", 6000); }
      else if (c === "explore") startExplore();
      else if (c === "bug") { lastBugAt = 0; spawnBug("TypeError: x is undefined"); }
      else if (c.startsWith?.("sched:")) handleSched(c.slice(6));
      else if (c === "meditate") meditate(6000);
      else if (c === "xp") addXp(70);
      else if (c === "report") dayReport();
      else if (c === "pomo") pomoToggle();
      else if (c === "weather") weatherSay(true);
      else if (c === "focus") { hideFocus(); showFocus(location.hostname); }
      else if (c.startsWith?.("say:")) say(c.slice(4));
      else if (c.startsWith?.("ai:")) say(c.slice(3), 0, { ai: true });
      else if (c.startsWith?.("walk:")) { x = vw() / 2 - curW / 2; go("walk", 8000); dir = +c.slice(5) || 1; }
      else if (c.startsWith?.("mask:")) setMask(c.slice(5), "test", 0, "маска: " + c.slice(5));
      else if (c === "scheme") { maskUntil = 0; trickScheme(); }
      else if (c === "masktick") { mood = null; maskUntil = 0; maskWhy = ""; maskTick(); }
      else if (c === "fly") flyRandom(true);
      else if (c.startsWith?.("enter:")) enterFrom(c.slice(6));
      else if (c.startsWith?.("drop:")) { yb = +c.slice(5); fallFrom = yb; launch(0, 0, false); }
      else if (c === "state") postMessage({ chibiState: { x, curW, curAx, head: x + curAx * curW, pose: curPose, state, flip: el.classList.contains("flip"), mask, maskWhy, face: face(), src: img.getAttribute("src").split("/").slice(-2).join("/"),
        bubble: bubble.classList.contains("on") ? bubble.textContent : "", q: sayQueue.length } }, "*");
    });
  }

  // ================= Полёт (цингун) — только «Плащ» =================
  // Взлетает, летит на высоте с лёгким покачиванием, плавно снижается и садится на колено.
  let fl = null;
  const canFly = () => s.physics && skin === "cloak" && has("fly") && !s.pinTop;
  function flyTo(tx, then, already) {
    const maxX = Math.max(0, vw() - curW);
    tx = clamp(tx, 0, maxX);
    const top = Math.max(H() * 0.6, vh() - curH - 40);
    fl = { tx, then, t: 0, alt: clamp(Math.max(yb, 0) + rnd(H() * 0.7, H() * 1.6), H() * 0.6, top), up: !already };
    ground = null; state = "flight"; seq = null; sliding = false; jumping = false; entering = false;
    thrown = false; spin = 0; rot = 0; pendingGoto = null; gotoThen = null;
    dir = Math.sign(tx - x) || dir;
    setAnim("");
    if (!already) { pose("crouch"); fl.wait = 0.18; } else fl.wait = 0;
    SND.whoosh && SND.whoosh();
  }
  function flyRandom(asked) {
    const w = Math.max(0, vw() - curW);
    // летит далеко: минимум почти через половину экрана
    const tx = x < w / 2 ? rnd(Math.min(w, x + w * 0.45), w) : rnd(0, Math.max(0, x - w * 0.45));
    flyTo(tx, () => { if (asked || Math.random() < 0.3) say(pick(["Лёгкость тела — основа.", "Цингун.", "Ветер сегодня хороший.", "Хм. Неплохо."]), 1600); });
  }
  function flightTick(dt) {
    const f = fl;
    if (!f) { launch(0, 0, false); return; }
    if (f.wait > 0) { f.wait -= dt; return; }             // присел перед взлётом
    f.t += dt;
    const dx = f.tx - x, dist = Math.abs(dx);
    dir = Math.sign(dx) || dir;
    const near = H() * 1.3;
    const sp = 360 * (H() / 140) * Math.sqrt(Number(s.speed) || 1);
    // высота: на подлёте — крейсерская, у цели — плавно вниз
    const want = dist > near ? f.alt : f.alt * (dist / near) ** 1.4;
    const bob = dist > near ? Math.sin(f.t * 3.2) * H() * 0.035 : 0;
    yb += (want + bob - yb) * Math.min(1, dt * (dist > near ? 2.6 : 4.5));
    x += dir * Math.min(dist, sp * dt * (dist > near ? Math.min(1, 0.35 + f.t * 0.9) : 0.45 + 0.55 * dist / near));
    // поза: взлёт — прыжок, полёт — горизонтально, посадка — снова собран
    if (f.up && f.t < 0.35) pose("leap", dir);
    else if (dist > near * 0.7) pose("fly", dir);
    else pose("leap", dir);
    if (dist < 3 && yb < 3) {                               // сел
      x = f.tx; yb = 0; ground = "floor"; fl = null; fallFrom = 0;
      squash(); dust(5); SND.thud && SND.thud();
      const then = f.then;
      play([{ p: "crouch", ms: 260 }], () => { go("idle", rnd(900, 1600)); then && then(); });
    }
  }

  // ================= Натура: хитрый манипулятор =================
  // Суровый — когда работа, ошибки, фокус. Милый — когда ему что-то нужно: перерыв, отпустить его,
  // похвалить, закончить пораньше. Маска иногда «спадает», и он снова холоден.
  const CUTE_EMOTES = ["laugh", "wave", "pet", "tea", "sit", "idle"];
  const CUTE_CLICK = ["laugh", "pet", "wave", "laugh"];
  const CUTE_PHRASES = ["Ты сегодня такой умный~", "Я самый послушный ученик ♡", "Хи-хи~", "Я ведь хороший, да? ✨",
    "Не смотри так. Я милый.", "Отдохни со мной чуть-чуть?", "Ещё пять минуточек ничего не делать~", "Ты лучший ♡ (запомни, что я это сказал)"];
  const SCHEME_LINES = ["Похвали меня. Ну пожааалуйста~", "Давай сегодня закончим пораньше? ✨", "Тебе нужен перерыв. Со мной~",
    "Если не будешь меня бросать — никому не скажу про твои вкладки~", "Ты самый лучший хозяин. Правда-правда ♡", "Купишь мне данго? Одно. Маленькое~"];
  const REVEAL = ["Попался.", "Ха. Повёлся.", "…Маска спала. Неважно.", "Это была проверка. Не прошёл.", "Кхм. Ты ничего не видел."];
  const HELD_CUTE = ["Отпусти~ ну пожалуйста ♡", "Я хороший, поставь меня~", "Ай-ай, высоко~ (нет)"];
  const AFTER_HELD = ["…Забудь, что видел.", "Тц. Сработало.", "Хитрость — тоже путь Дао."];
  const BACK_CUTE = ["Ты вернулся~ я скучал ♡", "Наконец-то~", "Я ждал. Совсем чуть-чуть~"];
  const TO_CUTE = { break: ["Перерыв~ теперь можно быть милым ♡", "Отдыхаем~ я заслужил."], off: ["Рабочий день всё. Я снова милый~", "Свобода~ ✨"],
    mood: ["Ладно, побуду милым~", "Сегодня я добрый. Пока что~", "Настроение сменилось ✨"] };
  const TO_STERN = ["Маска снята. Работаем.", "Хватит. За дело.", "Кхм. Серьёзно."];
  const hmMin = (str) => { const m = /(\d{1,2}):(\d{2})/.exec(str || ""); return m ? +m[1] * 60 + +m[2] : null; };
  function workPhase() {
    if (!s.schedOn) return "free";
    const d = new Date(), t = d.getHours() * 60 + d.getMinutes();
    if (!(s.workDays || []).includes(d.getDay())) return "off";
    const st = hmMin(s.workStart), en = hmMin(s.workEnd);
    if (st == null || en == null) return "free";
    if (t < st || t >= en) return "off";
    for (const part of String(s.breaks || "").split(/[,;]+/)) {
      const [a, b] = part.trim().split(/\s*[-–—]\s*/).map(hmMin);
      if (a != null && b != null && t >= a && t < b) return "break";
    }
    return "work";
  }
  // Настроение «по обстоятельствам»: само выпадает случайно раз в 8–22 минуты, но обстоятельства
  // склоняют чашу — в работу чаще суровый, в перерыв и после работы чаще милый. Менять ничего не нужно.
  let mood = null;
  function rollMood(ph) {
    const pCute = ph === "work" ? 0.3 : ph === "free" ? 0.5 : 0.75;
    mood = { m: Math.random() < pCute ? "cute" : "stern", until: Date.now() + rnd(8, 22) * 60000, phase: ph };
  }
  function baseMask() {
    const ph = workPhase();
    if (!mood || Date.now() > mood.until || mood.phase !== ph) rollMood(ph);
    return mood.m;
  }
  function setMask(m, why, ms, line, quiet) {
    maskUntil = ms ? Date.now() + ms : 0; maskWhy = why || "";
    if (m === mask || !CUTE_SKINS[skin]) return false;
    mask = m;
    const p = curPose; curPose = "";
    skinCfg = cfgCache[face()] || { ...BASE_CFG };
    loadSkinCfg(face());
    el && el.classList.toggle("cycle", skinCfg.walk.length >= 4);
    pose(/^(w|r)\d/.test(p) && state !== "walk" && state !== "goto" ? "idle" : p || "idle");
    if (el && host.style.display !== "none" && !quiet) {
      particles(m === "cute" ? "✨" : "…", m === "cute" ? 3 : 1, m === "cute" ? "#ff8fb1" : "#888");
      if (line) say(line, 0, { force: true });
    }
    if (!quiet) savePos(true);
    return true;
  }
  // он что-то замышляет: милая маска на минуту
  function trickScheme() {
    if (mask === "cute" || !ground || state === "sleep" || dragging || bubbleBusy()) return;
    setMask("cute", "scheme", rnd(40000, 80000));
    pose(pick(["pet", "laugh", "wave"])); go("react", 2600);
    say(pick(SCHEME_LINES), 0, { force: true });
  }
  // клик во время «аферы» — разоблачение
  function trickClick() {
    if (maskWhy !== "scheme" || mask !== "cute") return false;
    if (Math.random() < 0.45) return false;            // иногда держит роль до конца
    setMask("stern", "", 0);
    pose("cool"); go("react", 2000); say(pick(REVEAL), 0, { force: true });
    return true;
  }
  function trickPlead() {
    if (mask === "cute" && maskWhy !== "held") return;
    setMask("cute", "held", 30000);
    pose("held", 0);
    say(pick(HELD_CUTE), 0, { force: true });
  }
  let wasAway = false;
  function maskTick() {
    if (!el || host.style.display === "none" || document.hidden) return;
    const now = Date.now(), lastAct = Math.max(lastUserAct, mouseAt || 0);
    if (now - lastAct > 5 * 60000) wasAway = true;
    else if (wasAway && now - lastAct < 4000) {          // вернулся к компьютеру — встречает мило, потом снова строг
      wasAway = false;
      if (ground && state !== "sleep") { setMask("cute", "back", 9000, pick(BACK_CUTE)); pose("wave"); go("react", 2200); }
      return;
    }
    if (maskUntil && now > maskUntil) {                   // маска «спала» сама
      const why = maskWhy, b = baseMask();
      maskUntil = 0; maskWhy = "";
      if (b !== mask) setMask(b, "", 0, why === "scheme" || why === "back" ? pick(REVEAL) : b === "cute" ? pick(TO_CUTE.mood) : pick(TO_STERN));
      return;
    }
    if (maskUntil || dragging || state === "held") return;
    const b = baseMask();
    if (b !== mask) { setMask(b, "", 0, b === "cute" ? pick(TO_CUTE[workPhase()] || TO_CUTE.mood) : pick(TO_STERN)); return; }
    // в рабочее время иногда что-то замышляет (в среднем раз в ~20 минут)
    if (mask === "stern" && now - lastAct < 60000 && Math.random() < 0.012) trickScheme();
  }
  setInterval(maskTick, 15000);
  // суровые моменты: ловит баг, отвечает нейросеть, фокус — маска слетает сразу
  function sternNow() { if (mask === "cute" && maskWhy !== "held") setMask("stern", "", 0); }

  // ================= Запуск =================
  // ===== Запоминаем место между страницами одного сайта (сбрасывается при обновлении страницы) =====
  function msg(m) {
    return new Promise((res) => {
      if (!alive()) return res(null);
      try { chrome.runtime.sendMessage(m, (r) => res(chrome.runtime.lastError ? null : r)); } catch { res(null); }
    });
  }
  // ===== Он живёт отдельно от страницы: после F5, жёсткого обновления и переходов (даже на другой сайт)
  // остаётся на месте, в той же позе и продолжает своё занятие. Состояние хранится по вкладке.
  let lastSaved = "";
  const SS_KEY = "__chibi_walker_state";
  function snapshot() {
    const busy = ["seq", "held", "game", "hide", "hidePrep", "sword", "flight", "goto", "chase", "climb", "hang", "watchInput", "hold"].includes(state);
    return {
      xf: Math.round(((x + curW / 2) / Math.max(1, vw())) * 1000) / 1000,
      yf: s.pinTop || ground === "floor" ? 0 : Math.round((yb / Math.max(1, vh())) * 1000) / 1000,
      dir, skin, pin: !!s.pinTop,
      st: busy ? "idle" : state, pose: busy ? "idle" : curPose, left: Math.max(0, Math.round(until - performance.now())),
      mask, maskWhy, maskLeft: maskUntil ? Math.max(0, maskUntil - Date.now()) : 0,
      mood: mood ? { m: mood.m, left: Math.max(0, mood.until - Date.now()), phase: mood.phase } : null,
    };
  }
  function savePos(force) {
    if (!el || !alive() || (document.hidden && force !== true)) return;
    const data = snapshot();
    const k = JSON.stringify(data);
    if (k === lastSaved && force !== true) return;          // ничего не поменялось — не пишем
    lastSaved = k;
    try { sessionStorage.setItem(SS_KEY, JSON.stringify({ ...data, at: Date.now() })); } catch {}
    msg({ type: "pos:set", data });
  }
  // Один маскот на весь браузер: состояние общее для всех вкладок (хранится в фоне),
  // sessionStorage — запасной вариант на случай, если фон не успел ответить при обновлении.
  async function restore() {
    let local = null;
    try { local = JSON.parse(sessionStorage.getItem(SS_KEY) || "null"); } catch {}
    const remote = await msg({ type: "pos:get" });
    const d = [local, remote].filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
    return d && Date.now() - d.at < 6 * 60 * 60 * 1000 ? d : null; // не старше 6 часов
  }
  function applySnapshot(saved, quiet) {
    bornAt = performance.now() - 60000;            // не «новенький»: без спокойного старта
    if (saved.mood) mood = { m: saved.mood.m, until: Date.now() + saved.mood.left, phase: saved.mood.phase };
    if (saved.mask && (saved.mask !== mask || saved.maskWhy !== maskWhy)) setMask(saved.mask, saved.maskWhy, saved.maskLeft || 0, "", true);
    x = clamp(saved.xf * vw() - H() * 0.32, 0, Math.max(0, vw() - H() * 0.64));
    dir = saved.dir || 1;
    const st = saved.st || "idle";
    const ms = Math.max(800, saved.left || 1500);
    ground = "floor"; yb = 0; vx = vy = 0; seq = null;
    if (st === "sleep") { lastUserAct = 0; go("sleep", ms); }
    else if (st === "walk") { go("walk", ms); dir = saved.dir || 1; }
    else if (st === "meditate") meditate(ms);
    else if (["emote", "react", "perch", "watch"].includes(st)) { go("react", ms); pose(saved.pose || "idle"); }
    else go("idle", ms);
    if (!quiet && !s.pinTop && saved.yf > 0.02) { yb = saved.yf * vh(); fallFrom = yb; launch(0, 0, false); }
  }

  function start() {
    chrome.storage.local.get(DEFAULTS, async (v) => {
      s = { ...DEFAULTS, ...v };
      const saved = await restore();
      await new Promise((res) => chrome.storage.local.get({ stats: null, notes: [] }, (v2) => {
        if (v2.stats) stats = { ...stats, ...v2.stats, ach: v2.stats.ach || [] };
        if (!stats.firstDay) { stats.firstDay = new Date().toDateString(); flushStats(); }
        notes = v2.notes || [];
        res();
      }));
      build();
      if (saved && saved.mood) mood = { m: saved.mood.m, until: Date.now() + saved.mood.left, phase: saved.mood.phase };
      mask = saved && saved.mask ? saved.mask : baseMask();
      if (saved && saved.maskLeft && saved.mask === mask) { maskUntil = Date.now() + saved.maskLeft; maskWhy = saved.maskWhy || ""; }
      chooseSkin(false, saved && SKINS.includes(saved.skin) ? saved.skin : null);
      if (saved) applySnapshot(saved);
      else {
        x = rnd(0, Math.max(0, vw() - 200));
        pose("idle");
        go("idle", 1500);
      }
      applySettings();
      // на новой странице того же сайта говорит реже, при первом входе — как обычно
      // проверку «страница-ошибка» делаем, когда страница разобрана
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", checkErrorPage, { once: true }); else checkErrorPage();
      dayLoad();
      chrome.storage.local.get({ pomo: null }, (v3) => { pomoState = v3.pomo; });
      setTimeout(focusCheck, 2500); setInterval(focusCheck, 60000);
      countVisit();
      setTimeout(blowCookies, 3500);
      setTimeout(checkAch, 5000);
      setTimeout(checkBrokenImages, rnd(2500, 4000));
      // на новой странице иногда комментирует её, но не «здоровается» заново
      setTimeout(() => { if (!saved || Math.random() < 0.3) pageHello(); }, rnd(3500, 7000));
      setInterval(savePos, 1000);
      window.addEventListener("pagehide", () => savePos(true));
      document.addEventListener("visibilitychange", () => { if (document.hidden) savePos(true); });
      // в режиме «случайно» он иногда переодевается в другие годы
      setInterval(() => {
        if (s.skin === "random" && document.hasFocus() && ground && state !== "sleep" && state !== "hold" && !dragging && !document.hidden) {
          chooseSkin(true); pose("idle"); go("idle", 1500); say("✨");
        }
      }, 10 * 60 * 1000);
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local" || !el || !alive()) return;
      let any = false;
      for (const k in ch) if (k in DEFAULTS) { s[k] = ch[k].newValue ?? DEFAULTS[k]; any = true; }
      if (ch.pinTop && !s.pinTop && pinned) { pinned = false; launch(0, 0, false); }
      if (ch.pomo) { pomoState = ch.pomo.newValue; pomoTick(); }
      if (ch.focusOn && !s.focusOn) hideFocus();
      if (ch.curSkin && s.skin === "random" && ch.curSkin.newValue && ch.curSkin.newValue !== skin && SKINS.includes(ch.curSkin.newValue)) {
        skin = ch.curSkin.newValue; curPose = ""; skinCfg = cfgCache[face()] || { ...BASE_CFG }; loadSkinCfg(face()); preload(["idle", ...skinCfg.walk]); pose("idle");
      }
      if (any) applySettings(!!ch.skin);
      if (ch.schedOn || ch.workStart || ch.workEnd || ch.breaks || ch.workDays) { maskUntil = 0; maskWhy = ""; setTimeout(maskTick, 50); }
    });
  }
  start();
})();
