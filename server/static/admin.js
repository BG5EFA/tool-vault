(function () {
  "use strict";

  var CATS = { SYS: "系统", NET: "网络", DEV: "开发", MED: "媒体", SEC: "安全", UTL: "效率" };
  var PLATS = { WIN: "Windows", MAC: "macOS", LINUX: "Linux" };
  var LICS = ["开源", "免费", "商业"];

  var state = {
    tools: [],
    q: "",
    cat: "all",
    lic: "all",
    csrf: "",
    editingId: null,
    deleteId: null
  };

  var lastFocus = null;

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[ch];
    });
  }

  function ApiFail(message, status, data) {
    this.name = "ApiFail";
    this.message = message;
    this.status = status;
    this.data = data || {};
  }
  ApiFail.prototype = Object.create(Error.prototype);

  function api(path, options) {
    options = options || {};
    var headers = Object.assign(
      { Accept: "application/json" },
      options.body ? { "Content-Type": "application/json" } : {},
      state.csrf ? { "X-CSRF-Token": state.csrf } : {},
      options.headers || {}
    );

    return fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      method: options.method || "GET",
      body: options.body,
      headers: headers
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (res.status === 401 && path !== "/api/login") {
            state.csrf = "";
            showLogin("会话已过期，请重新登录");
          }
          if (!res.ok) {
            throw new ApiFail(data.error || "请求失败（" + res.status + "）", res.status, data);
          }
          return data;
        });
    });
  }

  /* ---------- view switching ---------- */

  function showLogin(message) {
    var boot = $("#bootView");
    if (boot) boot.hidden = true;
    state.csrf = "";
    closeAllModals();
    document.body.classList.remove("modal-open");
    $("#appView").hidden = true;
    $("#loginView").hidden = false;

    var error = $("#loginError");
    if (message) {
      error.textContent = message;
      error.hidden = false;
    } else {
      error.textContent = "";
      error.hidden = true;
    }

    var field = $("#password");
    if (field) {
      field.value = "";
      window.setTimeout(function () {
        field.focus();
      }, 40);
    }
  }

  function showApp() {
    $("#bootView").hidden = true;
    $("#loginView").hidden = true;
    $("#appView").hidden = false;
  }

  function showLoginError(message) {
    var error = $("#loginError");
    error.textContent = message;
    error.hidden = false;
  }

  /* ---------- stats / table ---------- */

  function updateStats(stats) {
    var total = stats && typeof stats.total === "number" ? stats.total : state.tools.length;
    var oss =
      stats && typeof stats.oss === "number"
        ? stats.oss
        : state.tools.filter(function (t) {
            return t.license === "开源";
          }).length;
    var cats =
      stats && typeof stats.cats === "number"
        ? stats.cats
        : new Set(
            state.tools.map(function (t) {
              return t.cat;
            })
          ).size;

    $("#statTotal").textContent = String(total);
    $("#statOss").textContent = String(oss);
    $("#statCats").textContent = String(cats);
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (err) {
      return url;
    }
  }

  function filteredTools() {
    var q = state.q.trim().toLowerCase();
    var words = q ? q.split(/\s+/) : [];

    return state.tools.filter(function (tool) {
      if (state.cat !== "all" && tool.cat !== state.cat) return false;
      if (state.lic !== "all" && tool.license !== state.lic) return false;
      if (!words.length) return true;

      var haystack = [
        tool.name,
        tool.vendor,
        tool.desc,
        tool.id,
        tool.license,
        CATS[tool.cat] || "",
        (tool.tags || []).join(" ")
      ]
        .join(" ")
        .toLowerCase();

      return words.every(function (word) {
        return haystack.indexOf(word) !== -1;
      });
    });
  }

  function rowHTML(tool, index) {
    var cat = esc(tool.cat || "");
    var catName = esc(CATS[tool.cat] || tool.cat || "");
    var plats = (tool.platforms || [])
      .map(function (code) {
        return '<span class="plat">' + esc(PLATS[code] || code) + "</span>";
      })
      .join("");
    var licClass =
      tool.license === "开源" ? "lic-oss" : tool.license === "免费" ? "lic-free" : "lic-comm";
    var name = esc(tool.name);
    var id = esc(tool.id);

    return (
      '<tr>' +
      '<td class="cell-idx" data-label="#">' +
      (index + 1 < 10 ? "0" + (index + 1) : String(index + 1)) +
      "</td>" +
      '<td class="cell-name" data-label="名称">' +
      '<div class="tool-name">' +
      name +
      "</div>" +
      (tool.vendor ? '<div class="tool-vendor">' + esc(tool.vendor) + "</div>" : "") +
      '<a class="tool-url" href="' +
      esc(tool.url) +
      '" target="_blank" rel="noopener noreferrer">' +
      esc(hostOf(tool.url)) +
      "</a>" +
      "</td>" +
      '<td data-label="分类"><span class="cat-tag cat-' +
      cat +
      '">' +
      catName +
      "</span></td>" +
      '<td data-label="平台"><div class="plats">' +
      plats +
      "</div></td>" +
      '<td data-label="授权"><span class="lic ' +
      licClass +
      '">' +
      esc(tool.license) +
      "</span></td>" +
      '<td class="cell-actions row-actions" data-label="操作">' +
      '<button type="button" class="row-btn" data-edit="' +
      id +
      '" aria-label="编辑 ' +
      name +
      '">编辑</button>' +
      '<button type="button" class="row-btn danger" data-del="' +
      id +
      '" aria-label="删除 ' +
      name +
      '">删除</button>' +
      "</td>" +
      "</tr>"
    );
  }

  function render() {
    var list = filteredTools();
    $("#toolRows").innerHTML = list
      .map(function (tool, index) {
        return rowHTML(tool, index);
      })
      .join("");
    $("#listEmpty").hidden = list.length !== 0;
    $("#listCount").textContent = "显示 " + list.length + " / " + state.tools.length;
  }

  function loadTools() {
    return api("/api/tools").then(function (data) {
      state.tools = Array.isArray(data.tools) ? data.tools : [];
      updateStats(data.stats);
      render();
    });
  }

  /* ---------- modals ---------- */

  function openModal(id, focusSelector) {
    lastFocus = document.activeElement;
    var modal = document.getElementById(id);
    modal.hidden = false;
    document.body.classList.add("modal-open");
    if (focusSelector) {
      window.setTimeout(function () {
        var el = $(focusSelector, modal) || $("button, input, select, textarea", modal);
        if (el) el.focus();
      }, 30);
    }
  }

  function closeModal(id) {
    var modal = document.getElementById(id);
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    if (!$$(".modal").some(function (item) { return !item.hidden; })) {
      document.body.classList.remove("modal-open");
    }
    if (lastFocus && typeof lastFocus.focus === "function") {
      try {
        lastFocus.focus();
      } catch (err) {
        /* noop */
      }
    }
  }

  function closeAllModals() {
    $$(".modal").forEach(function (modal) {
      modal.hidden = true;
    });
    document.body.classList.remove("modal-open");
  }

  function visibleModals() {
    return $$(".modal").filter(function (modal) {
      return !modal.hidden;
    });
  }

  /* ---------- toasts ---------- */

  function toast(message, kind) {
    var wrap = $("#toasts");
    while (wrap.children.length >= 4) {
      wrap.removeChild(wrap.firstElementChild);
    }
    var el = document.createElement("div");
    el.className = "toast" + (kind === "error" ? " toast--error" : "");
    el.textContent = message;
    wrap.appendChild(el);
    window.setTimeout(function () {
      el.classList.add("is-out");
      window.setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 220);
    }, 3400);
  }

  /* ---------- tool form ---------- */

  function clearFormErrors() {
    $$(".tool-form .is-invalid").forEach(function (el) {
      el.classList.remove("is-invalid");
    });
    var error = $("#formError");
    error.textContent = "";
    error.hidden = true;
  }

  function showFormError(message) {
    var error = $("#formError");
    error.textContent = message;
    error.hidden = false;
  }

  function fieldFor(key) {
    return {
      name: "#fName",
      id: "#fId",
      vendor: "#fVendor",
      url: "#fUrl",
      cat: "#fCat",
      license: "#fLic",
      tags: "#fTags",
      desc: "#fDesc"
    }[key];
  }

  function showApiErrors(err) {
    var errors = err && err.data && err.data.errors;
    if (errors && typeof errors === "object") {
      var messages = [];
      Object.keys(errors).forEach(function (key) {
        messages.push(errors[key]);
        var selector = fieldFor(key);
        if (selector) {
          var el = $(selector);
          if (el) el.classList.add("is-invalid");
        }
      });
      if (messages.length) {
        showFormError(messages.join("；"));
        return;
      }
    }
    showFormError((err && err.message) || "保存失败");
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = label || "处理中…";
      button.disabled = true;
    } else {
      button.textContent = button.dataset.label || button.textContent;
      button.disabled = false;
    }
  }

  function resetToolForm() {
    $("#toolForm").reset();
    clearFormErrors();
    state.editingId = null;
    $("#fMode").value = "add";
    $("#toolModalTitle").textContent = "新增资源";
    $("#saveBtn").textContent = "保存";
    var idField = $("#fId");
    idField.readOnly = false;
    idField.value = "";
    $("#descCount").textContent = "0 / 200";
    $$('input[name="platform"]').forEach(function (input) {
      input.checked = false;
    });
  }

  function openAdd() {
    resetToolForm();
    openModal("toolModal", "#fName");
  }

  function openEdit(id) {
    var tool = state.tools.filter(function (item) {
      return item.id === id;
    })[0];
    if (!tool) {
      toast("资源不存在，请刷新列表", "error");
      return;
    }

    resetToolForm();
    state.editingId = tool.id;
    $("#fMode").value = "edit";
    $("#toolModalTitle").textContent = "编辑资源";
    $("#saveBtn").textContent = "保存修改";

    $("#fName").value = tool.name || "";
    var idField = $("#fId");
    idField.value = tool.id || "";
    idField.readOnly = true;
    $("#fVendor").value = tool.vendor || "";
    $("#fUrl").value = tool.url || "";
    $("#fCat").value = tool.cat || "SYS";
    $("#fLic").value = tool.license || "开源";
    $("#fTags").value = (tool.tags || []).join(", ");
    $("#fDesc").value = tool.desc || "";
    $("#descCount").textContent = String((tool.desc || "").length) + " / 200";

    $$('input[name="platform"]').forEach(function (input) {
      input.checked = (tool.platforms || []).indexOf(input.value) !== -1;
    });

    openModal("toolModal", "#fName");
  }

  function collectTool() {
    var platforms = $$('input[name="platform"]:checked').map(function (input) {
      return input.value;
    });
    var tags = $("#fTags")
      .value.split(/[,，]/)
      .map(function (part) {
        return part.trim();
      })
      .filter(Boolean);

    return {
      id: $("#fId").value.trim(),
      name: $("#fName").value.trim(),
      vendor: $("#fVendor").value.trim(),
      url: $("#fUrl").value.trim(),
      cat: $("#fCat").value,
      license: $("#fLic").value,
      platforms: platforms,
      tags: tags,
      desc: $("#fDesc").value.trim()
    };
  }

  function submitTool(event) {
    event.preventDefault();
    clearFormErrors();
    var payload = collectTool();

    if (!payload.name) {
      $("#fName").classList.add("is-invalid");
      showFormError("请填写名称");
      $("#fName").focus();
      return;
    }
    if (!payload.url) {
      $("#fUrl").classList.add("is-invalid");
      showFormError("请填写官方链接");
      $("#fUrl").focus();
      return;
    }
    if (!payload.platforms.length) {
      showFormError("至少选择一个平台");
      return;
    }
    if (!payload.desc) {
      $("#fDesc").classList.add("is-invalid");
      showFormError("请填写一句话说明");
      $("#fDesc").focus();
      return;
    }

    var isEdit = Boolean(state.editingId);
    var saveBtn = $("#saveBtn");
    setBusy(saveBtn, true, "保存中…");

    var request = isEdit
      ? api("/api/tools/" + encodeURIComponent(state.editingId), {
          method: "PUT",
          body: JSON.stringify(payload)
        })
      : api("/api/tools", {
          method: "POST",
          body: JSON.stringify(payload)
        });

    request
      .then(function () {
        closeModal("toolModal");
        toast(isEdit ? "资源已更新" : "资源已新增");
        return loadTools();
      })
      .catch(function (err) {
        if (err.status !== 401) showApiErrors(err);
      })
      .finally(function () {
        setBusy(saveBtn, false);
      });
  }

  /* ---------- delete ---------- */

  function openDelete(id) {
    var tool = state.tools.filter(function (item) {
      return item.id === id;
    })[0];
    if (!tool) {
      toast("资源不存在，请刷新列表", "error");
      return;
    }
    state.deleteId = id;
    $("#deleteName").textContent = tool.name;
    openModal("deleteModal", ".modal-actions .btn-ghost");
  }

  function confirmDelete() {
    if (!state.deleteId) return;
    var button = $("#confirmDelete");
    var id = state.deleteId;
    setBusy(button, true, "删除中…");

    api("/api/tools/" + encodeURIComponent(id), { method: "DELETE" })
      .then(function () {
        closeModal("deleteModal");
        state.deleteId = null;
        toast("资源已删除");
        return loadTools();
      })
      .catch(function (err) {
        if (err.status === 404) {
          closeModal("deleteModal");
          state.deleteId = null;
          toast("资源已不存在，列表已刷新", "error");
          return loadTools();
        }
        if (err.status !== 401) toast(err.message || "删除失败", "error");
      })
      .finally(function () {
        setBusy(button, false);
      });
  }

  /* ---------- password ---------- */

  function openPassword() {
    $("#pwForm").reset();
    $("#pwError").hidden = true;
    $("#pwError").textContent = "";
    openModal("pwModal", "#pwCurrent");
  }

  function submitPassword(event) {
    event.preventDefault();
    var current = $("#pwCurrent").value;
    var next = $("#pwNext").value;
    var confirm = $("#pwConfirm").value;
    var error = $("#pwError");

    function fail(message) {
      error.textContent = message;
      error.hidden = false;
    }

    error.hidden = true;
    if (!current) return fail("请输入当前口令");
    if (next.length < 10) return fail("新口令至少 10 位");
    if (next !== confirm) return fail("两次输入的新口令不一致");
    if (next === current) return fail("新口令不能与当前口令相同");

    var button = $("#pwSaveBtn");
    setBusy(button, true, "更新中…");

    api("/api/password", {
      method: "POST",
      body: JSON.stringify({ current: current, next: next })
    })
      .then(function (data) {
        state.csrf = data.csrf;
        closeModal("pwModal");
        toast("口令已更新，其他会话已下线");
      })
      .catch(function (err) {
        if (err.status === 401) return;
        var errors = err.data && err.data.errors;
        fail((errors && errors.next) || (errors && errors.current) || err.message || "更新失败");
      })
      .finally(function () {
        setBusy(button, false);
      });
  }

  /* ---------- login / logout ---------- */

  function submitLogin(event) {
    event.preventDefault();
    var password = $("#password").value;
    if (!password) return showLoginError("请输入口令");

    var button = $("#loginBtn");
    setBusy(button, true, "验证中…");

    api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: password })
    })
      .then(function (data) {
        state.csrf = data.csrf;
        $("#password").value = "";
        showApp();
        return loadTools();
      })
      .catch(function (err) {
        showLoginError(err.message || "登录失败");
      })
      .finally(function () {
        setBusy(button, false);
      });
  }

  function logout() {
    api("/api/logout", { method: "POST" })
      .then(function () {
        showLogin("已退出登录");
      })
      .catch(function (err) {
        if (err.status === 401) return;
        showLogin("已退出登录");
      });
  }

  /* ---------- wiring ---------- */

  function wire() {
    $("#loginForm").addEventListener("submit", submitLogin);
    $("#togglePw").addEventListener("click", function () {
      var input = $("#password");
      var showing = input.type === "text";
      input.type = showing ? "password" : "text";
      this.textContent = showing ? "显示" : "隐藏";
      this.setAttribute("aria-label", showing ? "显示口令" : "隐藏口令");
      input.focus();
    });

    $("#addBtn").addEventListener("click", openAdd);
    $("#pwBtn").addEventListener("click", openPassword);
    $("#logoutBtn").addEventListener("click", logout);
    $("#toolForm").addEventListener("submit", submitTool);
    $("#pwForm").addEventListener("submit", submitPassword);
    $("#confirmDelete").addEventListener("click", confirmDelete);
    $("#clearFilters").addEventListener("click", function () {
      state.q = "";
      state.cat = "all";
      state.lic = "all";
      $("#adminQ").value = "";
      $("#filterCat").value = "all";
      $("#filterLic").value = "all";
      render();
    });

    $("#adminQ").addEventListener("input", function () {
      state.q = this.value;
      render();
    });
    $("#filterCat").addEventListener("change", function () {
      state.cat = this.value;
      render();
    });
    $("#filterLic").addEventListener("change", function () {
      state.lic = this.value;
      render();
    });

    $("#toolRows").addEventListener("click", function (event) {
      var edit = event.target.closest("[data-edit]");
      if (edit) {
        openEdit(edit.getAttribute("data-edit"));
        return;
      }
      var remove = event.target.closest("[data-del]");
      if (remove) openDelete(remove.getAttribute("data-del"));
    });

    $("#fDesc").addEventListener("input", function () {
      $("#descCount").textContent = this.value.length + " / 200";
    });

    $$(".tool-form input, .tool-form select, .tool-form textarea").forEach(function (el) {
      el.addEventListener("input", function () {
        el.classList.remove("is-invalid");
      });
    });

    document.addEventListener("click", function (event) {
      var closer = event.target.closest("[data-close]");
      if (closer) closeModal(closer.getAttribute("data-close"));
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        var open = visibleModals();
        if (open.length) {
          event.preventDefault();
          closeModal(open[open.length - 1].id);
        }
        return;
      }

      if (event.key !== "Tab") return;
      var modal = visibleModals()[0];
      if (!modal) return;
      var focusable = $$(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        modal
      ).filter(function (el) {
        return el.offsetParent !== null;
      });
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function boot() {
    wire();
    api("/api/me")
      .then(function (data) {
        state.csrf = data.csrf;
        showApp();
        return loadTools();
      })
      .catch(function (err) {
        if (err.status === 401) {
          showLogin();
        } else {
          showLogin(err.message || "无法连接后台");
        }
      })
      .finally(function () {
        $("#bootView").hidden = true;
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
