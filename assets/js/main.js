/* Veriforge 官网交互 · 零依赖
   首页：一次连续的相机运动（滚动绑定 + 指数趋近 + 速率上限）
   规格要点：SETTLE=9 / MAX_RATE=0.40 / EPSILON=0.0004，帧率无关 */
(function () {
  "use strict";

  var docEl = document.documentElement;
  docEl.classList.add("js");

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ============================================================
     相机舞台（仅首页存在 .scene 时启用）
     ============================================================ */
  var scene = document.getElementById("scene");
  var clamp01 = function (t) { return t < 0 ? 0 : t > 1 ? 1 : t; };

  if (scene) {
    docEl.classList.add("intro-page");

    var CAM_FROM = { x: -47.957, y: -80.097 };
    var CAM_TO = { x: -50.0, y: -36.716 };
    var CAM_UNTIL = 0.86;
    var PUSH = 0.11;
    var SETTLE = 9;
    var MAX_RATE = 0.40;
    var EPSILON = 0.0004;

    var current = 0;
    var target = 0;
    var rafId = 0;
    var lastTick = 0;
    var sceneTop = 0;
    var sceneTravel = 1;

    var easeOutCubic = function (t) { return 1 - Math.pow(1 - t, 3); };
    var easeOutQuart = function (t) { return 1 - Math.pow(1 - t, 4); };
    var easeInOutCubic = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
    var track = function (p, from, to, ease) {
      return ease(clamp01((p - from) / (to - from)));
    };
    var lerp = function (a, b, t) { return a + (b - a) * t; };

    var setVar = function (name, value) {
      if (value === null) docEl.style.removeProperty(name);
      else docEl.style.setProperty(name, value);
    };

    /* 把时间线写到 :root 的自定义属性上 */
    var apply = function (p) {
      /* 相机：平移在 86% 处落定，推近在中途达到峰值后回 resolve 到 1 */
      var q = clamp01(p / CAM_UNTIL);
      setVar("--cam-x", lerp(CAM_FROM.x, CAM_TO.x, q).toFixed(4) + "%");
      setVar("--cam-y", lerp(CAM_FROM.y, CAM_TO.y, q).toFixed(4) + "%");
      setVar("--cam-z", reduceMotion ? "1" : (1 + PUSH * Math.sin(Math.PI * q)).toFixed(5));

      /* hero 退场：先升 + 失焦，透明度保持到 0.38 之后才衰减 */
      var exit = track(p, 0.297, 0.508, function (t) { return t; });
      setVar("--hero-out", Math.pow(exit, 1.75).toFixed(5));
      setVar("--hero-o", Math.pow(1 - clamp01((exit - 0.38) / 0.62), 1.25).toFixed(5));
      if (exit > 0) {
        setVar("--hero-filter", "blur(" + (exit * 18).toFixed(2) + " * var(--u-hero))");
        setVar("--badge-backdrop", "none");
      } else {
        setVar("--hero-filter", null);
        setVar("--badge-backdrop", null);
      }
      docEl.classList.toggle("hero-gone", exit >= 1);

      /* 辉光退场 + 产品框入场（药丸/标题与窗格不同曲线 = 纵深） */
      setVar("--glow-o", (1 - track(p, 0.55, 0.95, easeInOutCubic)).toFixed(5));
      setVar("--plat-o", track(p, 0.557, 0.623, easeOutCubic).toFixed(5));
      setVar("--plat-text-p", track(p, 0.563, 0.967, easeOutQuart).toFixed(5));
      setVar("--plat-shot-p", track(p, 0.557, 0.984, easeOutCubic).toFixed(5));
      setVar("--plat-vis", p > 0.54 ? "visible" : "hidden");

      /* will-change 只在运动中挂载 */
      docEl.classList.toggle("is-moving", p > 0.001 && p < 0.999);
    };

    var measure = function () {
      var rect = scene.getBoundingClientRect();
      sceneTop = rect.top + window.scrollY;
      sceneTravel = Math.max(1, scene.offsetHeight - window.innerHeight);
    };

    var progress = function () {
      return clamp01((window.scrollY - sceneTop) / sceneTravel);
    };

    var render = function () {
      apply(current);
      rafId = 0;
      lastTick = 0;
    };

    var step = function (now) {
      if (!lastTick) lastTick = now;
      var dt = Math.min(0.05, (now - lastTick) / 1000);
      lastTick = now;
      var diff = target - current;
      if (Math.abs(diff) < EPSILON) {
        current = target;
        render();
        return;
      }
      var delta = diff * (1 - Math.exp(-SETTLE * dt));
      var cap = MAX_RATE * dt;
      if (delta > cap) delta = cap;
      else if (delta < -cap) delta = -cap;
      current += delta;
      apply(current);
      rafId = requestAnimationFrame(step);
    };

    var kick = function () {
      if (reduceMotion) { current = target = progress(); render(); return; }
      if (!rafId) rafId = requestAnimationFrame(step);
    };

    var onScroll = function () {
      target = progress();
      if (target > 0.05) openIntro();
      if (document.hidden) { current = target; apply(current); return; }
      kick();
    };
    var onVisibility = function () {
      if (!document.hidden && Math.abs(target - current) >= EPSILON) kick();
    };
    var onResize = function () {
      measure();
      target = progress();
      kick();
    };

    /* ---------- 入场动画（播放一次） ---------- */
    var introOpen = false;
    var openIntro = function () {
      if (introOpen) return;
      introOpen = true;
      docEl.classList.add("is-open");
    };

    var startIntro = function () {
      var p0 = progress();
      if (reduceMotion) { docEl.classList.add("is-instant", "is-open"); introOpen = true; return; }
      if (p0 > 0.02) {
        if (p0 >= 0.297) { docEl.classList.add("is-open"); introOpen = true; }
        else { docEl.classList.add("is-instant"); }
        return;
      }
      docEl.classList.add("is-ready");
      var subtitle = document.querySelector(".hero__subtitle");
      if (subtitle) {
        subtitle.addEventListener("animationend", openIntro, { once: true });
      }
      window.setTimeout(openIntro, 1800);
    };

    measure();
    target = current = progress();
    apply(current);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);

    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    var backstop = new Promise(function (res) { window.setTimeout(res, 1200); });
    Promise.race([fontsReady, backstop]).then(startIntro);
  }

  /* ============================================================
     移动端菜单（900px 以下）
     ============================================================ */
  var toggle = document.querySelector(".menu-toggle");
  var menu = document.getElementById("mobile-menu");
  if (toggle && menu) {
    var setMenu = function (open) {
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "关闭菜单" : "菜单");
      if (open) {
        menu.hidden = false;
        var first = menu.querySelector("a");
        if (first) first.focus();
      } else {
        menu.hidden = true;
      }
    };
    toggle.addEventListener("click", function () {
      setMenu(toggle.getAttribute("aria-expanded") !== "true");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) setMenu(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) {
        setMenu(false);
        toggle.focus();
      }
    });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !e.target.closest(".mobile-menu") && !e.target.closest(".menu-toggle")) {
        setMenu(false);
      }
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 1024 && !menu.hidden) setMenu(false);
    });
  }

  /* ============================================================
     滚动显现（IntersectionObserver）
     ============================================================ */
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* FAQ 手风琴 */
  document.querySelectorAll(".acc-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var expanded = btn.getAttribute("aria-expanded") === "true";
      var panel = document.getElementById(btn.getAttribute("aria-controls"));
      btn.setAttribute("aria-expanded", expanded ? "false" : "true");
      if (panel) panel.classList.toggle("open", !expanded);
    });
  });

  /* 选项卡 */
  document.querySelectorAll("[role='tablist']").forEach(function (list) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll("[role='tab']"));
    function select(tab) {
      tabs.forEach(function (t) {
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        if (panel) panel.hidden = !on;
      });
      tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(t); });
      t.addEventListener("keydown", function (e) {
        var dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (dir) select(tabs[(i + dir + tabs.length) % tabs.length]);
      });
    });
  });

  /* 代码复制 */
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var targetEl = document.getElementById(btn.dataset.copy);
      if (!targetEl) return;
      var text = targetEl.innerText.replace(/^\$\s/gm, "");
      var done = function () {
        var label = btn.querySelector("span");
        if (label) { label.textContent = "已复制"; }
        setTimeout(function () { if (label) label.textContent = "复制"; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      }
    });
  });

  /* 联系表单（校验后经 mailto 打开邮件客户端） */
  var form = document.getElementById("contact-form");
  if (form) {
    form.setAttribute("novalidate", "novalidate");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var ok = true;
      form.querySelectorAll("[required]").forEach(function (input) {
        var field = input.closest(".field");
        var valid = input.type === "email"
          ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value)
          : input.value.trim().length > 0;
        field.classList.toggle("invalid", !valid);
        if (!valid) ok = false;
      });
      var status = document.getElementById("form-status");
      if (!ok) {
        status.className = "form-status fail";
        status.textContent = "请检查标红的字段后重新提交。";
        return;
      }
      var d = new FormData(form);
      var subject = encodeURIComponent("[官网] " + d.get("topic") + "：" + d.get("name"));
      var body = encodeURIComponent(
        "姓名：" + d.get("name") + "\n邮箱：" + d.get("email") +
        "\n团队规模：" + (d.get("size") || "未填写") +
        "\n\n需求描述：\n" + d.get("message")
      );
      status.className = "form-status ok";
      status.textContent = "校验通过，正在打开你的邮件客户端发送到 shiganghai@gmail.com。";
      window.location.href = "mailto:shiganghai@gmail.com?subject=" + subject + "&body=" + body;
    });
  }
})();
