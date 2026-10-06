/* Veriforge 内容后台逻辑 */
(function () {
  "use strict";
  var FILES = [
    { name: "news.json", label: "新闻动态" },
    { name: "cases.json", label: "用户案例" },
    { name: "faq.json", label: "常见问题" },
  ];
  var state = { active: FILES[0].name, drafts: {} };

  function $(s) { return document.querySelector(s); }
  function status(msg, ok) {
    var el = $("#op-status");
    el.className = "form-status " + (ok ? "ok" : "fail");
    el.textContent = msg;
  }

  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: "same-origin" }, opts))
      .then(function (r) {
        return r.text().then(function (t) {
          var data = {};
          try { data = JSON.parse(t); } catch (e) { data = { raw: t }; }
          return { status: r.status, data: data };
        });
      });
  }

  /* ---------- 登录 ---------- */
  $("#login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var token = $("#login-token").value;
    api("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token }),
    }).then(function (r) {
      if (r.status === 200) { boot(); }
      else {
        var el = $("#login-status");
        el.className = "form-status fail";
        el.textContent = r.data.error || "登录失败";
      }
    });
  });

  $("#logout-btn").addEventListener("click", function () {
    api("/admin/api/logout", { method: "POST" }).then(function () { location.reload(); });
  });

  /* ---------- 编辑器 ---------- */
  function buildTabs() {
    var tabs = $("#content-tabs");
    tabs.innerHTML = "";
    FILES.forEach(function (f) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.textContent = f.label;
      b.setAttribute("aria-selected", String(f.name === state.active));
      b.addEventListener("click", function () {
        saveDraft();
        state.active = f.name;
        Array.prototype.forEach.call(tabs.children, function (c) { c.setAttribute("aria-selected", "false"); });
        b.setAttribute("aria-selected", "true");
        loadEditor();
      });
      tabs.appendChild(b);
    });
  }

  function saveDraft() {
    var ta = $("#editor-textarea");
    if (ta) state.drafts[state.active] = ta.value;
  }

  function loadEditor() {
    var panel = $("#content-panels");
    panel.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.setAttribute("role", "tabpanel");
    var label = FILES.filter(function (f) { return f.name === state.active; })[0].label;
    var meta = document.createElement("p");
    meta.className = "lead-note";
    meta.textContent = "正在编辑：" + state.active;
    var ta = document.createElement("textarea");
    ta.className = "admin-editor";
    ta.id = "editor-textarea";
    ta.setAttribute("aria-label", label + " 内容 JSON");
    ta.setAttribute("spellcheck", "false");
    ta.value = state.drafts[state.active] || "加载中…";
    ta.addEventListener("input", function () { state.drafts[state.active] = ta.value; });
    var actions = document.createElement("div");
    actions.className = "admin-actions";
    var save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn-primary";
    save.textContent = "校验并保存（自动重建）";
    save.addEventListener("click", function () { saveFile(ta.value); });
    var reload = document.createElement("button");
    reload.type = "button";
    reload.className = "btn";
    reload.textContent = "放弃修改，重新加载";
    reload.addEventListener("click", function () {
      delete state.drafts[state.active];
      loadFile();
    });
    actions.appendChild(save);
    actions.appendChild(reload);
    wrap.appendChild(meta);
    wrap.appendChild(ta);
    wrap.appendChild(actions);
    panel.appendChild(wrap);
    if (!state.drafts[state.active]) loadFile();
  }

  function loadFile() {
    api("/admin/api/content/" + state.active).then(function (r) {
      if (r.status !== 200) { status("加载失败", false); return; }
      state.drafts[state.active] = JSON.stringify(r.data, null, 2);
      var ta = $("#editor-textarea");
      if (ta) ta.value = state.drafts[state.active];
    });
  }

  function saveFile(text) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      status("JSON 解析失败：" + e.message, false);
      return;
    }
    if (!Array.isArray(parsed)) { status("根节点必须是数组", false); return; }
    api("/admin/api/content/" + state.active, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: text,
    }).then(function (r) {
      if (r.status === 200) {
        status("已保存并重建站点：" + (r.data.build || "ok"), true);
        delete state.drafts[state.active];
      } else {
        status("保存失败：" + (r.data.error || r.data.build || ""), false);
      }
    });
  }

  $("#rebuild-btn").addEventListener("click", function () {
    api("/admin/api/rebuild", { method: "POST" }).then(function (r) {
      status(r.data.ok ? "重建完成：" + r.data.build : "重建失败：" + r.data.build, r.data.ok);
    });
  });

  /* ---------- 启动 ---------- */
  function boot() {
    $("#login-view").classList.add("is-hidden");
    $("#editor-view").classList.remove("is-hidden");
    $("#logout-btn").classList.remove("is-hidden");
    buildTabs();
    loadEditor();
    api("/admin/api/status").then(function (r) {
      if (r.status === 200 && r.data.files) {
        var t = r.data.files.map(function (f) {
          return f.name + " @ " + f.updatedAt.slice(0, 16).replace("T", " ");
        }).join(" · ");
        $("#editor-h").insertAdjacentHTML("afterend",
          '<p class="hero-caption mt-10">' + t + "</p>");
      }
    });
  }

  /* 若已有会话则直接进入 */
  api("/admin/api/status").then(function (r) { if (r.status === 200) boot(); });
})();
