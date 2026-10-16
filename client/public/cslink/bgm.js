/* CS Link 背景音乐：Lobby Time 循环播放，跨页面续播；角落开关 + 关于弹层 */
(function () {
  if (window.CSBgm) return;
  var SRC = "/cslink/bgm/lobby-time.mp3", VOL = 0.34, KEY = "cslink.bgm", POS = "cslink.bgm.pos";
  var on = localStorage.getItem(KEY) !== "off";
  var a = new Audio(SRC); a.loop = true; a.preload = "auto"; a.volume = 0;
  var saved = parseFloat(sessionStorage.getItem(POS) || "0");
  if (saved > 0) a.addEventListener("loadedmetadata", function () { try { a.currentTime = saved % (a.duration || 1e9); } catch (e) {} }, { once: true });
  var fadeT = 0;
  function fade(to, ms, done) {
    clearInterval(fadeT); var from = a.volume, t0 = performance.now();
    fadeT = setInterval(function () {
      var k = Math.min(1, (performance.now() - t0) / ms); a.volume = from + (to - from) * k;
      if (k >= 1) { clearInterval(fadeT); done && done(); }
    }, 30);
  }
  function save() { if (!a.paused) sessionStorage.setItem(POS, String(a.currentTime)); }
  setInterval(save, 1000);
  addEventListener("pagehide", save);
  function start() {
    if (!on || !a.paused) return;
    var p = a.play(); if (p && p.then) p.then(function () { fade(VOL, 900); }, function () {});
  }
  function stop() { save(); fade(0, 300, function () { a.pause(); }); }
  ["pointerdown", "keydown", "touchstart"].forEach(function (ev) { addEventListener(ev, start, { capture: true, passive: true }); });

  var css = document.createElement("style");
  css.textContent =
    ".csbgm{position:fixed;left:16px;bottom:16px;z-index:60;display:flex;gap:6px;font-family:'Chakra Petch','Noto Sans SC',sans-serif}" +
    ".csbgm button{width:34px;height:34px;border-radius:50%;border:1px solid rgba(232,196,120,.45);background:rgba(10,14,12,.62);color:#e8c478;cursor:pointer;display:grid;place-items:center;padding:0;backdrop-filter:blur(6px);transition:transform .15s,background .15s,opacity .15s;opacity:.78}" +
    ".csbgm button:hover,.csbgm button:focus-visible{opacity:1;transform:scale(1.08);background:rgba(20,26,22,.85);outline:none}" +
    ".csbgm button[aria-pressed=false] svg .w{display:none}.csbgm button[aria-pressed=true] svg .x{display:none}" +
    ".csbgm .i{font-weight:700;font-size:15px;font-style:italic}" +
    ".csabout{position:fixed;inset:0;z-index:200;display:none;place-items:center;background:rgba(5,7,6,.6);backdrop-filter:blur(4px)}" +
    ".csabout.open{display:grid}" +
    ".csabout .box{width:min(440px,calc(100vw - 32px));background:#141a17;border:1px solid rgba(232,196,120,.35);border-top:3px solid #e8c478;border-radius:12px;padding:22px 24px 18px;color:#efe9da;font:14px/1.75 'Noto Sans SC',-apple-system,'PingFang SC',sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5)}" +
    ".csabout h3{margin:0 0 10px;font:700 20px 'Chakra Petch','Noto Sans SC',sans-serif;letter-spacing:.08em;color:#e8c478}" +
    ".csabout p{margin:0 0 10px}.csabout a{color:#e8c478}.csabout small{display:block;opacity:.6;font-size:12px}" +
    ".csabout .close{margin-top:8px;float:right;background:#e8c478;color:#141a17;border:0;border-radius:6px;padding:6px 16px;font-weight:700;cursor:pointer}";
  document.head.appendChild(css);

  var bar = document.createElement("div"); bar.className = "csbgm";
  bar.innerHTML =
    '<button type="button" class="m" aria-label="背景音乐" title="背景音乐"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6v4h2.5l3.5 3V3L5 6z" fill="currentColor"/><path class="w" d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.6a6 6 0 0 1 0 8.8"/><path class="x" d="M11 6l3.5 4M14.5 6L11 10"/></svg></button>' +
    '<button type="button" class="i" aria-label="关于" title="关于">i</button>';
  var dlg = document.createElement("div"); dlg.className = "csabout"; dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-labelledby", "csaboutT");
  dlg.innerHTML =
    '<div class="box"><h3 id="csaboutT">关于 CS Link</h3>' +
    '<p>给两名职业选手，用当过队友的人把他们连起来。比赛和阵容数据来自 HLTV，每条队友关系都能点回对应的比赛页。</p>' +
    '<p>背景音乐：<br>Music: "Lobby Time" Kevin MacLeod (<a href="https://incompetech.com" target="_blank" rel="noopener">incompetech.com</a>)<br>Licensed under <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a></p>' +
    '<small>非商业的同好小游戏。左下角喇叭可以关掉音乐。</small>' +
    '<button type="button" class="close">知道了</button></div>';
  var mBtn = bar.querySelector(".m");
  function sync() { mBtn.setAttribute("aria-pressed", on ? "true" : "false"); mBtn.title = on ? "关掉音乐" : "打开音乐"; }
  mBtn.addEventListener("click", function (e) {
    e.stopPropagation(); on = !on; localStorage.setItem(KEY, on ? "on" : "off"); sync();
    if (on) start(); else stop();
  });
  function openAbout() { dlg.classList.add("open"); dlg.querySelector(".close").focus(); }
  function closeAbout() { dlg.classList.remove("open"); }
  bar.querySelector(".i").addEventListener("click", function (e) { e.stopPropagation(); openAbout(); });
  dlg.addEventListener("click", function (e) { if (e.target === dlg || e.target.classList.contains("close")) closeAbout(); });
  addEventListener("keydown", function (e) { if (e.key === "Escape" && dlg.classList.contains("open")) { e.stopPropagation(); closeAbout(); } }, true);
  sync();
  function mount() { document.body.appendChild(bar); document.body.appendChild(dlg); }
  if (document.body) mount(); else addEventListener("DOMContentLoaded", mount);
  /* 同源跳转后浏览器一般允许直接续播；被拦就等第一次点击 */
  start();
  window.CSBgm = { about: openAbout, start: start, stop: stop, isOn: function () { return on; } };
})();

