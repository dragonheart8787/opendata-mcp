// opendata-mcp landing page — interactive behavior.
//
// Reimplements, in plain DOM/JS, what the original design (Claude Design's
// "Landing Page v3 3D.dc.html") expressed as a small reactive component:
// scroll-driven progress bar, reveal-on-scroll, hover tilt, animated stat
// counters, a typing/tab-switching Q&A demo board, a copy-to-clipboard
// button, and a Three.js "data gateway" scene tied to scroll position.
// No framework/runtime dependency — every effect here is done by hand
// against real element ids in index.html.
(function () {
  "use strict";

  var PROPS = { scene3d: true, accent: "#7FE3B0", autoPlay: true, holdSeconds: 4 };
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var samples = [
    { label: "天氣", q: "臺北市明天天氣如何？", a: "臺北市　多雲時陰　22–27°C　降雨機率 40%　舒適度 舒適", src: "資料來源：中央氣象署 F-C0032-001（36 小時天氣預報）" },
    { label: "空品", q: "新北市現在空氣品質好嗎？", a: "板橋測站　AQI 58 普通　PM2.5 17 μg/m³　O3 32 ppb", src: "資料來源：環境部 aqx_p_432（空氣品質指標）" },
    { label: "地震", q: "最近台灣有地震嗎？規模多大？", a: "花蓮縣近海　規模 5.1　深度 22.4 km　最大震度 花蓮 4 級", src: "資料來源：中央氣象署 E-A0015-001（顯著有感地震報告）" },
    { label: "國道", q: "國道三號現在有沒有事故？", a: "國道3號 南下 268K　事故處理中　內側車道封閉　預計 30 分鐘排除", src: "資料來源：交通部高速公路局『交通資料庫』" },
    { label: "台鐵", q: "板橋車站台鐵現在有沒有誤點？", a: "板橋　自強 152 次 往樹林 誤點 6 分　區間 2178 次 準點", src: "資料來源：交通部運輸資料流通服務（TDX）" }
  ];

  var targets = { n9: 9, n2: 2, n4: 4, n19: 19, n333: 333 };

  var state = { i: 0, typed: "", progress: 0 };
  var typeTimer = null;
  var holdTimer = null;
  var copyTimer = null;

  var progressFillEl = document.getElementById("progress-fill");
  var boardQuestionEl = document.getElementById("board-question");
  var boardAnswerEl = document.getElementById("board-answer");
  var boardSourceEl = document.getElementById("board-source");
  var boardTabsEl = document.getElementById("board-tabs");
  var copyBtnEl = document.getElementById("copy-btn");

  function tabStyle(active) {
    return {
      font: "500 13px 'Noto Sans TC', sans-serif",
      letterSpacing: "0.08em",
      padding: "8px 16px",
      borderRadius: "2px",
      cursor: "pointer",
      background: "transparent",
      color: active ? "#07100C" : "#8FAE9E",
      backgroundColor: active ? PROPS.accent : "transparent",
      border: "1px solid " + (active ? PROPS.accent : "rgba(127,227,176,.24)")
    };
  }

  function applyStyle(el, styleObj) {
    Object.keys(styleObj).forEach(function (k) {
      el.style[k] = styleObj[k];
    });
  }

  // --- scroll progress bar (also drives the 3D scene's camera push-in) ---
  function onScroll() {
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    state.progress = max > 0 ? Math.min(1, h.scrollTop / max) : 0;
    progressFillEl.style.width = (state.progress * 100).toFixed(2) + "%";
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // --- reveal-on-scroll ---
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 }
    );
    document.querySelectorAll("[data-reveal]").forEach(function (el, n) {
      el.style.transitionDelay = Math.min(n % 5, 4) * 60 + "ms";
      io.observe(el);
    });
  } else {
    document.querySelectorAll("[data-reveal]").forEach(function (el) {
      el.classList.add("in");
    });
  }

  // --- hover tilt (pointer devices only) ---
  if (!reduced && window.matchMedia("(hover: hover)").matches) {
    document.querySelectorAll("[data-tilt]").forEach(function (el) {
      el.addEventListener("mousemove", function (ev) {
        var r = el.getBoundingClientRect();
        var px = (ev.clientX - r.left) / r.width - 0.5;
        var py = (ev.clientY - r.top) / r.height - 0.5;
        el.style.transform =
          "perspective(900px) rotateX(" + (-py * 4).toFixed(2) + "deg) rotateY(" + (px * 5).toFixed(2) + "deg) translateZ(6px)";
        el.style.borderColor = "rgba(127,227,176,.5)";
      });
      el.addEventListener("mouseleave", function () {
        el.style.transform = "";
        el.style.borderColor = "";
      });
    });
  }

  // --- animated stat counters ---
  function countUp() {
    var keys = Object.keys(targets);
    if (reduced) {
      keys.forEach(function (k) {
        document.getElementById("stat-" + k).textContent = String(targets[k]);
      });
      return;
    }
    var t0 = performance.now();
    var dur = 1100;
    function step(now) {
      var p = Math.min(1, (now - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      keys.forEach(function (k) {
        document.getElementById("stat-" + k).textContent = String(Math.round(targets[k] * e));
      });
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // --- Q&A demo board: typing effect + tab switching ---
  function renderBoardTabs() {
    boardTabsEl.innerHTML = "";
    samples.forEach(function (s, n) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(n === state.i));
      btn.textContent = s.label;
      applyStyle(btn, tabStyle(n === state.i));
      btn.addEventListener("click", function () {
        pick(n);
      });
      boardTabsEl.appendChild(btn);
    });
  }

  function renderBoardValues() {
    var cur = samples[state.i];
    var typing = state.typed.length < cur.q.length;
    boardQuestionEl.textContent = state.typed;
    boardAnswerEl.textContent = typing ? "…" : cur.a;
    boardSourceEl.textContent = typing ? "" : cur.src;
  }

  function startTyping() {
    clearInterval(typeTimer);
    clearTimeout(holdTimer);
    var full = samples[state.i].q;
    if (reduced || PROPS.autoPlay === false) {
      state.typed = full;
      renderBoardValues();
      return;
    }
    state.typed = "";
    renderBoardValues();
    var n = 0;
    typeTimer = setInterval(function () {
      n += 1;
      state.typed = full.slice(0, n);
      renderBoardValues();
      if (n >= full.length) {
        clearInterval(typeTimer);
        holdTimer = setTimeout(function () {
          state.i = (state.i + 1) % samples.length;
          renderBoardTabs();
          startTyping();
        }, (PROPS.holdSeconds || 4) * 1000);
      }
    }, 62);
  }

  function pick(n) {
    clearInterval(typeTimer);
    clearTimeout(holdTimer);
    state.i = n;
    state.typed = samples[n].q;
    renderBoardTabs();
    renderBoardValues();
  }

  // --- copy-to-clipboard button ---
  function copyUrl() {
    var url = "https://opendata-mcp.dragonheartliu1440.workers.dev/mcp";
    function done() {
      copyBtnEl.textContent = "已複製 ✓";
      copyBtnEl.style.background = PROPS.accent;
      copyBtnEl.style.color = "#07100C";
      clearTimeout(copyTimer);
      copyTimer = setTimeout(function () {
        copyBtnEl.textContent = "複製網址";
        copyBtnEl.style.background = "transparent";
        copyBtnEl.style.color = PROPS.accent;
      }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () {});
    } else {
      var ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        done();
      } catch (e) {}
      document.body.removeChild(ta);
    }
  }
  if (copyBtnEl) copyBtnEl.addEventListener("click", copyUrl);

  // --- Three.js "data gateway" background scene ---
  function initScene() {
    var canvas = document.getElementById("dc-scene");
    if (!canvas || PROPS.scene3d === false) return;

    var cdns = [
      "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      "https://esm.sh/three@0.160.0",
      "https://unpkg.com/three@0.160.0/build/three.module.js"
    ];

    (async function () {
      var THREE = null;
      for (var i = 0; i < cdns.length; i++) {
        try {
          THREE = await import(/* webpackIgnore: true */ cdns[i]);
          break;
        } catch (e) {}
      }
      if (!THREE) {
        canvas.style.display = "none";
        return;
      }

      // Everything below touches WebGL/the real GPU, which can fail for
      // reasons totally unrelated to the CDN import above (WebGL disabled,
      // driver/context-creation issues, etc.) — wrapped so any such failure
      // degrades to "no 3D background" instead of an unhandled rejection,
      // matching the !THREE fallback above. The rest of the page (stats,
      // demo board, tool cards, copy button) is already fully initialized
      // by the time initScene() even runs, so it's unaffected either way.
      try {
        var accent = new THREE.Color(PROPS.accent);
        var small = window.innerWidth < 720;

        var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: !small, alpha: true, powerPreference: "low-power" });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
        var scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x07100c, 0.055);
        var camera = new THREE.PerspectiveCamera(52, 1, 0.1, 120);
        camera.position.set(0, 0, 13);

        var world = new THREE.Group();
        scene.add(world);

        // 中心閘道：雙層線框多面體
        var core = new THREE.Group();
        core.add(
          new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.55, 1)),
            new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.75 })
          )
        );
        var shell = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.5, 0)),
          new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.18 })
        );
        core.add(shell);
        world.add(core);

        // 資料點雲（球殼）
        var N = small ? 420 : 1100;
        var pos = new Float32Array(N * 3);
        for (var i2 = 0; i2 < N; i2++) {
          var u = Math.random(),
            v = Math.random();
          var th = 2 * Math.PI * u,
            ph = Math.acos(2 * v - 1);
          var r0 = 6.4 + Math.random() * 2.2;
          pos[i2 * 3] = r0 * Math.sin(ph) * Math.cos(th);
          pos[i2 * 3 + 1] = r0 * Math.cos(ph) * 0.62;
          pos[i2 * 3 + 2] = r0 * Math.sin(ph) * Math.sin(th);
        }
        var cloudGeo = new THREE.BufferGeometry();
        cloudGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        var cloud = new THREE.Points(
          cloudGeo,
          new THREE.PointsMaterial({ color: accent, size: 0.03, transparent: true, opacity: 0.34, sizeAttenuation: true })
        );
        world.add(cloud);

        // 四個資料平台軌道環
        var rings = [];
        [
          [5.2, 0.3],
          [7.4, -0.75]
        ].forEach(function (pair, i) {
          var r = pair[0],
            tilt = pair[1];
          var g = new THREE.BufferGeometry();
          var p = [];
          for (var a = 0; a <= 160; a++) {
            var t = (a / 160) * Math.PI * 2;
            p.push(Math.cos(t) * r, 0, Math.sin(t) * r);
          }
          g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
          var ring = new THREE.Line(g, new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.13 + i * 0.02 }));
          ring.rotation.x = tilt;
          ring.rotation.z = tilt * 0.4;
          world.add(ring);

          // 環上的節點 + 連回中心的線
          var node = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.17, 0),
            new THREE.MeshBasicMaterial({ color: accent, wireframe: true, transparent: true, opacity: 0.9 })
          );
          ring.add(node);
          rings.push({ ring: ring, node: node, r: r, speed: 0.14 + i * 0.06 });
        });

        function resize() {
          var w = Math.max(canvas.clientWidth, window.innerWidth || 0, 320);
          var h = Math.max(canvas.clientHeight, window.innerHeight || 0, 320);
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        }
        resize();
        window.addEventListener("resize", resize);

        var ptr = { x: 0, y: 0, tx: 0, ty: 0 };
        function onMove(e) {
          ptr.tx = (e.clientX / window.innerWidth - 0.5) * 2;
          ptr.ty = (e.clientY / window.innerHeight - 0.5) * 2;
        }
        if (window.matchMedia("(hover: hover)").matches) window.addEventListener("mousemove", onMove, { passive: true });

        var clock = new THREE.Clock();
        function draw() {
          try {
            var t = clock.getElapsedTime();
            var p = state.progress;
            ptr.x += (ptr.tx - ptr.x) * 0.05;
            ptr.y += (ptr.ty - ptr.y) * 0.05;

            core.rotation.y = t * 0.18;
            core.rotation.x = Math.sin(t * 0.22) * 0.2;
            shell.rotation.y = -t * 0.3;
            cloud.rotation.y = t * 0.045;
            rings.forEach(function (o) {
              o.node.position.set(Math.cos(t * o.speed) * o.r, 0, Math.sin(t * o.speed) * o.r);
            });

            // 滾動推進鏡頭：由外部俯視推近到穿過閘道
            camera.position.z = 13 - p * 5.2;
            camera.position.y = 1.1 - p * 1.2 + ptr.y * -0.5;
            camera.position.x = ptr.x * 1.1;
            world.rotation.y = p * 0.7;
            world.rotation.x = 0.12 + p * 0.1;
            camera.lookAt(0, 0, 0);
            renderer.render(scene, camera);
            requestAnimationFrame(draw);
          } catch (err) {
            // A per-frame render failure (lost WebGL context, etc.) after a
            // successful start — stop looping and hide the canvas rather
            // than spamming the console every frame.
            canvas.style.display = "none";
          }
        }

        if (reduced) {
          world.rotation.set(0.12, 0.4, 0);
          camera.position.set(0, 1.2, 13);
          camera.lookAt(0, 0, 0);
          renderer.render(scene, camera);
        } else {
          draw();
        }
      } catch (err) {
        canvas.style.display = "none";
      }
    })();
  }

  countUp();
  renderBoardTabs();
  startTyping();
  initScene();
})();
