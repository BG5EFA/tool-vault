(function () {
  "use strict";

  var CATS = {
    SYS: "系统",
    NET: "网络",
    DEV: "开发",
    MED: "媒体",
    SEC: "安全",
    UTL: "效率"
  };

  var PLATS = {
    WIN: "Windows",
    MAC: "macOS",
    LINUX: "Linux"
  };

  var LICS = ["开源", "免费", "商业"];

  var tools = Array.isArray(window.TOOLS) ? window.TOOLS : [];

  var state = {
    q: "",
    cat: "all",
    plat: "all",
    lic: "all",
    sort: "default"
  };

  var els = {
    q: document.getElementById("q"),
    grid: document.getElementById("grid"),
    empty: document.getElementById("empty"),
    count: document.getElementById("resultCount"),
    sort: document.getElementById("sort"),
    reset: document.getElementById("resetBtn"),
    emptyReset: document.getElementById("emptyReset"),
    catChips: document.getElementById("catChips"),
    platChips: document.getElementById("platChips"),
    licChips: document.getElementById("licChips"),
    statTotal: document.getElementById("statTotal"),
    statCats: document.getElementById("statCats"),
    statOss: document.getElementById("statOss"),
    year: document.getElementById("year")
  };

  var firstRender = true;

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[ch];
    });
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /* ---------- 筛选控件 ---------- */

  function countBy(key, value) {
    return tools.filter(function (t) {
      if (key === "cat") return t.cat === value;
      if (key === "plat") return t.platforms.indexOf(value) !== -1;
      if (key === "lic") return t.license === value;
      return false;
    }).length;
  }

  function chipHTML(key, value, label, count) {
    var active = state[key] === value;
    return (
      '<button type="button" class="chip' +
      (active ? " is-active" : "") +
      '" data-key="' +
      key +
      '" data-value="' +
      esc(value) +
      '" aria-pressed="' +
      active +
      '">' +
      esc(label) +
      '<span class="chip-n">' +
      count +
      "</span></button>"
    );
  }

  function renderChips() {
    var catHTML = chipHTML("cat", "all", "全部", tools.length);
    Object.keys(CATS).forEach(function (code) {
      catHTML += chipHTML("cat", code, CATS[code], countBy("cat", code));
    });
    els.catChips.innerHTML = catHTML;

    var platHTML = chipHTML("plat", "all", "全部", tools.length);
    Object.keys(PLATS).forEach(function (code) {
      platHTML += chipHTML("plat", code, PLATS[code], countBy("plat", code));
    });
    els.platChips.innerHTML = platHTML;

    var licHTML = chipHTML("lic", "all", "全部", tools.length);
    LICS.forEach(function (value) {
      licHTML += chipHTML("lic", value, value, countBy("lic", value));
    });
    els.licChips.innerHTML = licHTML;
  }

  /* ---------- 过滤与排序 ---------- */

  function matches(tool) {
    if (state.cat !== "all" && tool.cat !== state.cat) return false;
    if (state.plat !== "all" && tool.platforms.indexOf(state.plat) === -1) return false;
    if (state.lic !== "all" && tool.license !== state.lic) return false;

    var terms = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;

    var haystack = [
      tool.name,
      tool.vendor,
      tool.desc,
      CATS[tool.cat] || "",
      tool.license,
      tool.tags.join(" ")
    ]
      .join(" ")
      .toLowerCase();

    return terms.every(function (term) {
      return haystack.indexOf(term) !== -1;
    });
  }

  function sortList(list) {
    if (state.sort === "name") {
      return list.slice().sort(function (a, b) {
        return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
      });
    }
    if (state.sort === "cat") {
      var order = Object.keys(CATS);
      return list.slice().sort(function (a, b) {
        var diff = order.indexOf(a.cat) - order.indexOf(b.cat);
        if (diff !== 0) return diff;
        return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
      });
    }
    return list;
  }

  /* ---------- 渲染 ---------- */

  function badgeClass(license) {
    if (license === "开源") return "badge--oss";
    if (license === "免费") return "badge--free";
    return "badge--comm";
  }

  function cardHTML(tool, index) {
    var plats = tool.platforms
      .map(function (code) {
        return '<span class="plat">' + esc(PLATS[code] || code) + "</span>";
      })
      .join("");

    return (
      '<article class="card" data-component="tool-card" data-cat="' +
      esc(tool.cat) +
      '" data-augmented-ui="tl-clip br-clip border" style="--i:' +
      Math.min(index, 20) +
      '">' +
      '<div class="card-top">' +
      '<span class="card-index">' +
      pad(index + 1) +
      "</span>" +
      '<span class="card-cat">' +
      esc(tool.cat) +
      " / " +
      esc(CATS[tool.cat] || "") +
      "</span>" +
      "</div>" +
      '<h2 class="card-name"><a href="' +
      esc(tool.url) +
      '" target="_blank" rel="noopener noreferrer">' +
      esc(tool.name) +
      '<span class="card-arrow" aria-hidden="true">↗</span></a></h2>' +
      '<p class="card-vendor">' +
      esc(tool.vendor) +
      "</p>" +
      '<p class="card-desc">' +
      esc(tool.desc) +
      "</p>" +
      '<div class="card-foot">' +
      '<div class="card-plats">' +
      plats +
      "</div>" +
      '<span class="badge ' +
      badgeClass(tool.license) +
      '">' +
      esc(tool.license) +
      "</span>" +
      "</div>" +
      "</article>"
    );
  }

  function render() {
    var list = sortList(tools.filter(matches));
    var filtered =
      state.q.trim() !== "" ||
      state.cat !== "all" ||
      state.plat !== "all" ||
      state.lic !== "all";

    els.grid.innerHTML = list
      .map(function (tool, index) {
        return cardHTML(tool, index);
      })
      .join("");

    if (firstRender) {
      els.grid.classList.add("is-fresh");
      window.setTimeout(function () {
        els.grid.classList.remove("is-fresh");
      }, 900);
      firstRender = false;
    }

    els.empty.hidden = list.length !== 0;

    els.count.textContent = filtered
      ? "命中 " + list.length + " / " + tools.length + " 项"
      : "共 " + tools.length + " 项 · 全部收录";

    renderChips();
  }

  function resetAll() {
    state.q = "";
    state.cat = "all";
    state.plat = "all";
    state.lic = "all";
    state.sort = "default";
    els.q.value = "";
    els.sort.value = "default";
    render();
    els.q.focus();
  }

  /* ---------- 事件 ---------- */

  els.q.addEventListener("input", function () {
    state.q = els.q.value;
    render();
  });

  els.sort.addEventListener("change", function () {
    state.sort = els.sort.value;
    render();
  });

  document.addEventListener("click", function (event) {
    var chip = event.target.closest(".chip");
    if (!chip) return;
    var key = chip.getAttribute("data-key");
    var value = chip.getAttribute("data-value");
    if (!key || !value) return;
    state[key] = value;
    render();
  });

  els.reset.addEventListener("click", resetAll);
  els.emptyReset.addEventListener("click", resetAll);

  document.addEventListener("keydown", function (event) {
    var tag = (event.target.tagName || "").toLowerCase();
    var typing =
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      event.target.isContentEditable;

    if (event.key === "/" && !typing) {
      event.preventDefault();
      els.q.focus();
      els.q.select();
      return;
    }

    if (event.key === "Escape" && document.activeElement === els.q) {
      if (els.q.value) {
        els.q.value = "";
        state.q = "";
        render();
      } else {
        els.q.blur();
      }
    }
  });

  /* ---------- 初始化 ---------- */

  if (els.year) els.year.textContent = String(new Date().getFullYear());
  if (els.statTotal) els.statTotal.textContent = String(tools.length);
  if (els.statCats) els.statCats.textContent = String(Object.keys(CATS).length);
  if (els.statOss) els.statOss.textContent = String(countBy("lic", "开源"));

  render();
})();
