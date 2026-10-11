/* CS Link 页面转场：斜切遮罩。
 * 跳转：window.CSWipe.go(url, side)，side = t | ct | ink
 * 落地：页面地址带 ?from=t|ct|ink 时，首帧铺满同色遮罩，再斜切擦开 */
(function () {
  if (window.CSWipe) return;
  var COLORS = { t: "#f5a623", ct: "#23348f", ink: "#0d0f14", home: "transparent" };
  var SLANT = 7; /* 和首页分割线一样的倾斜量(%) */
  var reduce = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

  var css = document.createElement("style");
  css.textContent =
    ".cswipe{position:fixed;inset:0;z-index:2147483000;pointer-events:all;display:grid;place-items:center}" +
    ".cswipe i{width:86px;height:86px;display:grid;place-items:center;background:#0d0f14;" +
    "box-shadow:0 0 0 3px #f2efe8,0 18px 40px rgba(0,0,0,.45);transform:rotate(45deg) scale(.6);opacity:0;" +
    "transition:transform .3s cubic-bezier(.2,.9,.3,1.2),opacity .2s}" +
    ".cswipe.mark i{transform:rotate(45deg) scale(1);opacity:1}" +
    ".cswipe b{transform:rotate(-45deg);font:700 28px/1 'Chakra Petch',system-ui,sans-serif;letter-spacing:.02em;color:#6f8cff}" +
    ".cswipe b em{font-style:normal;color:#f5a623}" +
    ".cswipe .h{position:absolute;inset:0}.cswipe .h.l{background:linear-gradient(160deg,#f7b445,#d9860b)}" +
    ".cswipe .h.r{background:linear-gradient(160deg,#2f45b5,#18246b)}" +
    ".cswipe .h.s{background:#fbfaf6;opacity:0;transition:opacity .12s}.cswipe.seam .h.s{opacity:1}" +
    ".cswipe i{position:relative;z-index:2}";
  (document.head || document.documentElement).appendChild(css);

  function mask(side) {
    var m = document.createElement("div");
    m.className = "cswipe";
    m.setAttribute("aria-hidden", "true");
    m.style.background = COLORS[side] || COLORS.ink;
    m.innerHTML = (side === "home" ? '<div class="h l"></div><div class="h r"></div><div class="h s"></div>' : "") + "<i><b><em>C</em>S</b></i>";
    /* head 里引入时 body 还没有，挂到 documentElement 上也能首帧盖住 */
    (document.body || document.documentElement).appendChild(m);
    return m;
  }
  /* e：分割线中点位置(%)；keepLeft=true 时遮罩占分割线左侧，否则占右侧 */
  function clip(m, e, keepLeft) {
    var a = (e + SLANT) + "%", b = (e - SLANT) + "%";
    m.style.clipPath = keepLeft
      ? "polygon(0 0," + a + " 0," + b + " 100%,0 100%)"
      : "polygon(" + a + " 0,100% 0,100% 100%," + b + " 100%)";
  }
  function tween(ms, ease, f, done) {
    var t0 = performance.now();
    function tick(now) {
      var k = Math.min(1, (now - t0) / ms);
      f(ease(k));
      if (k < 1) requestAnimationFrame(tick); else if (done) done();
    }
    requestAnimationFrame(tick);
  }
  var inOut = function (k) { return k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
  var out = function (k) { return 1 - Math.pow(1 - k, 3); };
  var LO = -SLANT * 2, HI = 100 + SLANT * 2; /* 分割线移出屏幕两侧的位置 */

  /* 回首页：橙从左、蓝从右合拢，接缝和首页分屏一样斜；落地时两块向两侧拉开 */
  function halves(m, eL, eR) {
    var l = m.querySelector(".h.l"), r = m.querySelector(".h.r"), sm = m.querySelector(".h.s");
    clip(l, eL, true); clip(r, eR, false);
    var a = (50 + SLANT - .35) + "%", b = (50 + SLANT + .35) + "%", c = (50 - SLANT + .35) + "%", d = (50 - SLANT - .35) + "%";
    sm.style.clipPath = "polygon(" + a + " 0," + b + " 0," + c + " 100%," + d + " 100%)";
  }
  function homeIn(m) {
    var r = m.querySelector(".h.r"); r.style.boxShadow = "0 0 40px rgba(0,0,0,.5)";
    m.classList.remove("mark", "seam");
    tween(480, out, function (k) { halves(m, 50 + (LO - 50) * k, 50 + (HI - 50) * k); }, function () { m.remove(); });
  }

  /* 落地：铺满后擦开。橙和 ink 从左往右擦，蓝从右往左擦 */
  var Q = new URLSearchParams(location.search), from = Q.get("from");
  if (from && COLORS[from]) {
    var m = mask(from);
    m.classList.add("mark");
    if (from === "home") { m.classList.add("seam"); halves(m, 50, 50); }
    Q.delete("from");
    var qs = Q.toString();
    history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    var reveal = function () {
      setTimeout(function () {
        m.classList.remove("mark");
        if (reduce) {
          m.style.transition = "opacity .15s";
          m.style.opacity = "0";
          setTimeout(function () { m.remove(); }, 170);
          return;
        }
        if (from === "home") return homeIn(m);
        var ltr = from !== "ct";
        tween(550, out, function (k) {
          if (ltr) clip(m, LO + (HI - LO) * k, false); else clip(m, HI - (HI - LO) * k, true);
        }, function () { m.remove(); });
      }, 120);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reveal); else reveal();
  }

  var busy = false;
  function go(url, side) {
    if (busy) return;
    busy = true;
    side = COLORS[side] ? side : "ink";
    var u = new URL(url, location.href);
    /* 目的地是首页样板时统一用橙蓝合拢 */
    if (u.port === "5199" || /home-split/.test(u.pathname) || /^\/cslink\/(?:index\.html)?$/.test(u.pathname)) side = "home";
    u.searchParams.set("from", side);
    var dest = u.toString(), m = mask(side);
    if (reduce) {
      if (side === "home") halves(m, 50, 50);
      m.style.opacity = "0";
      m.style.transition = "opacity .15s";
      requestAnimationFrame(function () { m.style.opacity = "1"; });
      setTimeout(function () { location.href = dest; }, 160);
      return;
    }
    /* 和落地方向一致：橙/ink 从左盖向右，蓝从右盖向左 */
    if (side === "home") {
      halves(m, LO, HI);
      tween(380, inOut, function (k) { halves(m, LO + (50 - LO) * k, HI - (HI - 50) * k); }, function () {
        m.classList.add("seam", "mark");
        setTimeout(function () { location.href = dest; }, 170);
      });
      return;
    }
    var ltr = side !== "ct";
    if (ltr) clip(m, LO, true); else clip(m, HI, false);
    tween(450, inOut, function (k) {
      if (ltr) clip(m, LO + (HI - LO) * k, true); else clip(m, HI - (HI - LO) * k, false);
    }, function () {
      m.style.clipPath = "none";
      m.classList.add("mark");
      setTimeout(function () { location.href = dest; }, 180);
    });
  }
  /* 浏览器后退命中缓存页时清掉残留遮罩 */
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    busy = false;
    document.querySelectorAll(".cswipe").forEach(function (x) { x.remove(); });
  });
  window.CSWipe = { go: go };
})();
