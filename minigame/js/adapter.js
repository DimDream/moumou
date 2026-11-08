/* =====================================================================
 * 哞哞庇护所 · 微信小游戏运行时适配层 (wx adapter)
 * ---------------------------------------------------------------------
 * 微信小游戏没有 DOM / BOM，只有一个「上屏 canvas」。本层把 Web 版用到的
 * 浏览器能力映射到 wx API，使游戏主体（core.js）几乎零改动即可运行：
 *
 *   ┌─ 上屏 canvas（第 1 个 wx.createCanvas，2D）── 合成 + 自绘 UI
 *   ├─ 离屏 WebGL canvas（每次建 renderer 新建）── Three.js 渲染 3D
 *   ├─ 伪 DOM 元素：textContent / innerHTML / style.display / click
 *   ├─ wx.onTouchStart|Move|End → UI 命中 / 场景 pointerdown / 双指缩放
 *   ├─ wx.setStorageSync → localStorage
 *   └─ Web Audio 空实现（小游戏需改用 wx.createInnerAudioContext）
 *
 * 关键约定：core.js 每关会 dispose + forceContextLoss 旧 renderer，
 * 由于每关的 WebGL canvas 都是新建的离屏 canvas，不会破坏上屏 2D canvas。
 * ===================================================================== */
(function (G) {
  'use strict';

  var wxApi = G.wx || (typeof wx !== 'undefined' ? wx : null);
  if (!wxApi || !wxApi.createCanvas) throw new Error('需要微信小游戏运行环境（wx.createCanvas 不存在）');

  /* ---------------- 屏幕信息 ---------------- */
  var sys = wxApi.getSystemInfoSync ? wxApi.getSystemInfoSync() : {};
  var W = sys.windowWidth || sys.screenWidth || 375;
  var H = sys.windowHeight || sys.screenHeight || 667;
  var DPR = Math.min(sys.pixelRatio || 1, 2);
  var LOW_END = (typeof sys.benchmarkLevel === 'number' && sys.benchmarkLevel > 0 && sys.benchmarkLevel < 10);

  /* 第 1 次 createCanvas = 唯一上屏 canvas，用 2D 上下文做最终合成 */
  var mainCanvas = wxApi.createCanvas();
  var ctx = mainCanvas.getContext('2d');
  // 上屏 canvas 的物理尺寸由运行时决定，用实际尺寸反推缩放，避免 DPR 错位
  var sx = (mainCanvas.width || Math.round(W * DPR)) / W;
  var sy = (mainCanvas.height || Math.round(H * DPR)) / H;
  // 统一用「逻辑像素」绘制：一次设置变换，之后每帧只需 clearRect(0,0,W,H)
  try { ctx.setTransform(sx, 0, 0, sy, 0, 0); } catch (e) { ctx.scale(sx, sy); }

  var lastRendererCanvas = null;
  var rendererCanvases = [];
  var dirty = true;
  var hitAreas = [];
  var selectScroll = 0;
  var selectMaxScroll = 0;

  function noop() {}

  /* ---------------- canvas 补丁 ----------------
   * Three.js 会对 canvas 调 addEventListener / style / getBoundingClientRect，
   * 小游戏 canvas 没有这些，需要补齐。 */
  function patchCanvas(c) {
    if (c.__wxPatched) return c;
    try { c.__wxPatched = true; } catch (e) { return c; }
    c.__listeners = {};
    try { if (!c.style) c.style = {}; } catch (e) { c.style = {}; }
    // 第三参可能是 { signal }：core.js 用它摘掉旧 canvas 的 webglcontextlost，
    // 否则切关 forceContextLoss() 会误触发错误页。
    c.addEventListener = function (t, fn, opts) {
      (this.__listeners[t] || (this.__listeners[t] = [])).push({ fn: fn, signal: opts && opts.signal });
    };
    c.removeEventListener = function (t, fn) {
      var a = this.__listeners[t] || [];
      for (var i = a.length - 1; i >= 0; i--) if (a[i].fn === fn) a.splice(i, 1);
    };
    c.getBoundingClientRect = function () {
      return { left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 };
    };
    try { c.clientWidth = W; c.clientHeight = H; } catch (e) {}
    c.setAttribute = noop;
    return c;
  }

  /* 第 2 次及以后 createCanvas = 离屏 canvas */
  function offscreen(w, h) {
    var c = wxApi.createCanvas();
    try { c.width = w || 1; c.height = h || 1; } catch (e) {}
    patchCanvas(c);
    return c;
  }

  function newRendererCanvas() {
    var c = offscreen(Math.round(W * DPR), Math.round(H * DPR));
    lastRendererCanvas = c;
    rendererCanvases.push(c);
    // 只保留最近 3 个引用，旧 canvas 交给 GC（core 已 forceContextLoss）
    if (rendererCanvases.length > 3) rendererCanvases.shift();
    return c;
  }

  /* ---------------- 伪 DOM ----------------
   * 只实现本项目用到的子集：属性读写触发 dirty，click 交给触摸层命中分发。 */
  var elements = {};
  var DEFAULT_DISPLAY = {
    app: 'block', hud: '', rainOverlay: 'none',
    menuOverlay: 'none', levelSelectOverlay: 'none', errOverlay: 'none', winOverlay: 'none',
    shelterArrow: 'none', foodArrow: 'none', windArrow: 'none',
    btnNext: '', btnStart: '', btnBack: '', btnRetry: '', btnMenu: '',
    btnChapPrev: '', btnChapNext: '', btnErrRetry: '', btnErrMenu: ''
  };

  function makeStyle() {
    var s = {};
    var names = ['display', 'opacity', 'transform'];
    for (var i = 0; i < names.length; i++) {
      (function (k) {
        var v = (k === 'display') ? '' : (k === 'opacity' ? '1' : '');
        Object.defineProperty(s, k, {
          get: function () { return v; },
          set: function (x) { if (v !== x) { v = x; dirty = true; } },
          enumerable: true, configurable: true
        });
      })(names[i]);
    }
    return s;
  }

  function stripTags(html) {
    return String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  function parseCard(html) {
    function pick(cls) {
      var m = new RegExp('class="' + cls + '"[^>]*>([^<]*)<').exec(html);
      return m ? m[1] : '';
    }
    return {
      no: pick('lvNo'), name: pick('lvName'), desc: pick('lvDesc'),
      stars: pick('lvStars'), state: pick('lvState')
    };
  }

  function makeEl(tag, id) {
    var el = {
      tagName: String(tag || 'div').toUpperCase(), id: id || '',
      children: [], _text: '', _html: '', _card: null, _listeners: {},
      className: '', disabled: false, style: makeStyle()
    };
    if (DEFAULT_DISPLAY[id] !== undefined) el.style.display = DEFAULT_DISPLAY[id];

    Object.defineProperty(el, 'textContent', {
      get: function () { return el._text; },
      set: function (v) { el._text = String(v == null ? '' : v); dirty = true; },
      enumerable: true, configurable: true
    });
    Object.defineProperty(el, 'innerHTML', {
      get: function () { return el._html; },
      set: function (v) {
        el._html = String(v == null ? '' : v);
        el._text = stripTags(el._html);
        el._card = /class="lvNo"/.test(el._html) ? parseCard(el._html) : null;
        if (el._html === '') el.children.length = 0;
        dirty = true;
      },
      enumerable: true, configurable: true
    });
    el.appendChild = function (c) { el.children.push(c); dirty = true; return c; };
    el.removeChild = function (c) {
      var i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1);
      dirty = true; return c;
    };
    el.addEventListener = function (t, fn) {
      (el._listeners[t] || (el._listeners[t] = [])).push(fn);
    };
    el.removeEventListener = function (t, fn) {
      var a = el._listeners[t] || [];
      for (var i = a.length - 1; i >= 0; i--) if (a[i] === fn) a.splice(i, 1);
    };
    el.setAttribute = noop;
    el.getBoundingClientRect = function () {
      return { left: 0, top: 0, width: W, height: H, right: W, bottom: H };
    };
    el.getContext = function () { return null; };
    return el;
  }

  function getEl(id) {
    if (elements[id]) return elements[id];
    // 小地图：直接用离屏 2D canvas，core 的 drawMinimap() 原样可跑
    if (id === 'minimap') {
      var c = offscreen(150, 150);
      elements[id] = c;
      return c;
    }
    return (elements[id] = makeEl('div', id));
  }

  var documentShim = {
    getElementById: getEl,
    createElement: function (tag) {
      return String(tag).toLowerCase() === 'canvas' ? offscreen(1, 1) : makeEl(tag);
    },
    // Three.js WebGLRenderer 通过 createElementNS 拿渲染用 canvas
    createElementNS: function (ns, tag) {
      return String(tag).toLowerCase() === 'canvas' ? newRendererCanvas() : makeEl(tag);
    },
    body: null,
    documentElement: null,
    addEventListener: noop,
    removeEventListener: noop
  };
  documentShim.body = makeEl('body');
  documentShim.documentElement = makeEl('html');

  /* ---------------- 全局事件总线（支持 AbortSignal 过滤） ---------------- */
  var globalListeners = {};
  function addEventListener(t, fn, opts) {
    var sig = opts && opts.signal;
    (globalListeners[t] || (globalListeners[t] = [])).push({ fn: fn, signal: sig });
  }
  function removeEventListener(t, fn) {
    var a = globalListeners[t] || [];
    for (var i = a.length - 1; i >= 0; i--) if (a[i].fn === fn) a.splice(i, 1);
  }
  function emitGlobal(t, ev) {
    var a = globalListeners[t]; if (!a) return;
    for (var i = a.length - 1; i >= 0; i--) {
      var it = a[i];
      if (it.signal && it.signal.aborted) { a.splice(i, 1); continue; }
      try { it.fn(ev); } catch (e) { console.warn('[wx-adapter] event ' + t + ':', e); }
    }
  }
  function dispatchCanvasEvent(c, type, ev) {
    var a = c && c.__listeners && c.__listeners[type];
    if (!a) return;
    for (var i = a.length - 1; i >= 0; i--) {
      var it = a[i];
      if (it.signal && it.signal.aborted) { a.splice(i, 1); continue; }
      try { it.fn(ev); } catch (e) { console.warn('[wx-adapter] canvas ' + type + ':', e); }
    }
  }

  /* ---------------- Web / BOM 垫片 ----------------
   * setGlobal：微信小游戏的 GameGlobal 是普通对象可直接赋值；浏览器 harness 里
   * 部分全局属性只读/不可配置，降级用 defineProperty，失败也不影响主流程。 */
  function setGlobal(k, v) {
    // 浏览器里 window.location 是导航属性：给它赋任何值（哪怕是对象）都会
    // 立即跳转到 "[object Object]"。原生存在时保持不动；小游戏 GameGlobal
    // 上没有 location，可以安全写入垫片。
    if (k === 'location' && G.location && typeof G.location.href === 'string') return;
    try { G[k] = v; if (G[k] === v) return; } catch (e) {}
    try { Object.defineProperty(G, k, { value: v, writable: true, configurable: true }); } catch (e) {}
  }
  setGlobal('window', G);
  setGlobal('self', G);
  setGlobal('document', documentShim);
  // 浏览器 harness 的 window.document 是只读 accessor（configurable=false），
  // 上面那句会被静默忽略；core.js / three.js 改从 __WX_DOC__ 取伪 DOM，
  // 保证真实小游戏与本地浏览器验证走同一套 DOM 垫片。
  setGlobal('__WX_DOC__', documentShim);
  setGlobal('innerWidth', W);
  setGlobal('innerHeight', H);
  setGlobal('devicePixelRatio', DPR);
  setGlobal('WX_LOW_END', LOW_END);
  setGlobal('addEventListener', addEventListener);
  setGlobal('removeEventListener', removeEventListener);
  setGlobal('matchMedia', function () { return { matches: true, addListener: noop, removeListener: noop }; });
  setGlobal('ontouchstart', null);       // 让 IS_TOUCH 判定为触屏（移动端降配置）
  setGlobal('location', {
    pathname: '', search: '', hash: '',
    reload: function () { if (G.__mmBridge) G.__mmBridge.restart(); }
  });
  setGlobal('history', { replaceState: noop, pushState: noop });
  setGlobal('localStorage', {
    getItem: function (k) { try { var v = wxApi.getStorageSync(k); return (v === '' || v == null) ? null : v; } catch (e) { return null; } },
    setItem: function (k, v) { try { wxApi.setStorageSync(k, v); } catch (e) {} },
    removeItem: function (k) { try { wxApi.removeStorageSync(k); } catch (e) {} }
  });
  if (!G.performance || !G.performance.now) setGlobal('performance', { now: function () { return Date.now(); } });
  if (typeof G.requestAnimationFrame !== 'function') {
    setGlobal('requestAnimationFrame', function (fn) { return setTimeout(function () { fn(Date.now()); }, 16); });
    setGlobal('cancelAnimationFrame', function (id) { clearTimeout(id); });
  }
  if (typeof G.cancelAnimationFrame !== 'function') setGlobal('cancelAnimationFrame', noop);

  /* Web Audio 空实现：小游戏无 AudioContext。
   * 后续接入音效时，用 wx.createInnerAudioContext() 播放预置音频资源替换本段。 */
  function fakeParam() {
    return {
      value: 0, setValueAtTime: noop, linearRampToValueAtTime: noop,
      exponentialRampToValueAtTime: noop, setTargetAtTime: noop
    };
  }
  function fakeNode() {
    return {
      gain: fakeParam(), frequency: fakeParam(), Q: fakeParam(), type: '', loop: false, buffer: null,
      connect: noop, disconnect: noop, start: noop, stop: noop
    };
  }
  function FakeAudioContext() {
    this.state = 'running'; this.currentTime = 0; this.sampleRate = 44100;
    this.destination = fakeNode();
    this.resume = noop; this.suspend = noop; this.close = noop;
    this.createOscillator = fakeNode; this.createGain = fakeNode;
    this.createBiquadFilter = fakeNode; this.createBufferSource = fakeNode;
    this.createBuffer = function () { return { getChannelData: function () { return new Float32Array(1); } }; };
  }
  setGlobal('AudioContext', FakeAudioContext);
  setGlobal('webkitAudioContext', FakeAudioContext);

  if (!G.AbortController) {
    setGlobal('AbortController', function () {
      var cbs = [], self = this;
      this.signal = { aborted: false, addEventListener: function (ev, fn) { if (ev === 'abort') cbs.push(fn); } };
      this.abort = function () {
        self.signal.aborted = true;
        for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
      };
    });
  }

  /* ---------------- 绘图工具 ---------------- */
  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function fillRR(x, y, w, h, r, color) { rr(x, y, w, h, r); ctx.fillStyle = color; ctx.fill(); }
  function text(str, x, y, font, color, align) {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle'; ctx.fillText(str, x, y);
  }
  function fitText(str, maxW, base, min, color, x, y, align) {
    var px = base;
    do {
      ctx.font = 'bold ' + px + 'px sans-serif';
      if (ctx.measureText(str).width <= maxW || px <= min) break;
      px -= 1;
    } while (true);
    text(str, x, y, 'bold ' + px + 'px sans-serif', color, align);
  }
  function gradient(x, y, w, h, c0, c1) {
    var g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    return g;
  }
  function skyBg() {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#8fd0f0'); g.addColorStop(0.45, '#a8ddf2'); g.addColorStop(1, '#cfe9c0');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  function shade(alpha) { ctx.fillStyle = 'rgba(28,48,26,' + alpha + ')'; ctx.fillRect(0, 0, W, H); }

  /* 注册可点击区域；优先 onClick，其次伪 DOM 的 click 监听 */
  function area(x, y, w, h, el, onClick) { hitAreas.push({ x: x, y: y, w: w, h: h, el: el, onClick: onClick }); }

  function button(id, label, x, y, w, h, opt) {
    opt = opt || {};
    var el = getEl(id), off = el.disabled;
    // 底部立体阴影
    fillRR(x, y + 4, w, h, opt.r || 14, off ? 'rgba(90,110,80,.25)' : '#4a8437');
    rr(x, y, w, h, opt.r || 14);
    ctx.fillStyle = off ? gradient(x, y, w, h, '#c3d3b8', '#adbfa2')
      : (opt.ghost ? '#ffffff' : gradient(x, y, w, h, '#8ed06b', '#5da344'));
    ctx.fill();
    if (opt.ghost) { ctx.strokeStyle = '#c4d8b6'; ctx.lineWidth = 2; ctx.stroke(); }
    text(label, x + w / 2, y + h / 2 + 1,
      'bold ' + (opt.fs || 19) + 'px sans-serif',
      off ? 'rgba(255,255,255,.7)' : (opt.ghost ? '#6b8a5f' : '#ffffff'), 'center');
    if (!off) area(x, y, w, h, el);
    return el;
  }
  function card(x, y, w, h) {
    fillRR(x - 3, y - 3, w + 6, h + 6, 26, 'rgba(255,233,168,.9)');
    fillRR(x, y, w, h, 24, '#fffdf4');
  }
  function panel(x, y, w, h, r) {
    fillRR(x, y, w, h, r || 14, 'rgba(255,255,255,.86)');
  }

  /* ---------------- HUD ---------------- */
  function drawHUD() {
    var g = ctx;
    var levelTxt = getEl('panelLevel')._text || '🐄 哞哞庇护所';
    var food = getEl('foodCount')._text || '0';
    var obj = getEl('objective')._text || '目标：收集 5 份草料';

    // 左上：关卡 / 草料
    panel(12, 12, Math.min(W - 190, 300), 38, 12);
    fitText(levelTxt, Math.min(W - 210, 280), 15, 10, '#3d5a34', 24, 31);
    panel(12, 56, 140, 40, 12);
    text('🌾 草料', 24, 76, 'bold 15px sans-serif', '#3d5a34');
    text(food + ' / 5', 138, 76, 'bold 20px sans-serif', '#e8930c', 'right');

    // 目标：宽屏放顶部中间；窄屏下移到小地图之下，避免与左上角信息重叠
    ctx.font = 'bold 14px sans-serif';
    var wide = W >= 560;
    var maxOw = wide ? W - 380 : W - 24;
    var ow = Math.max(120, Math.min(ctx.measureText(obj).width + 28, maxOw));
    var ox = Math.max(6, W / 2 - ow / 2);
    var oy = wide ? 12 : 186;
    panel(ox, oy, ow, 34, 12);
    fitText(obj, ow - 16, 14, 10, '#2f4d26', W / 2, oy + 17, 'center');

    // 右上：小地图（core 的 drawMinimap 已画到离屏 150×150）
    var mmx = W - 166, mmy = 12;
    fillRR(mmx - 8, mmy - 8, 166, 166, 18, 'rgba(255,255,255,.86)');
    var mc = elements.minimap;
    if (mc) {
      g.save();
      g.beginPath(); g.arc(mmx + 75, mmy + 75, 74, 0, Math.PI * 2); g.clip();
      try { g.drawImage(mc, mmx, mmy, 150, 150); } catch (e) {}
      g.restore();
      g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 3;
      g.beginPath(); g.arc(mmx + 75, mmy + 75, 74, 0, Math.PI * 2); g.stroke();
    }

    // 方向胶囊：庇护所 / 最近草料 / 龙卷风
    arrowPill('shelterArrow', W / 2 - 90, 56, 180, 'arrowIcon', 'shelterDist', '庇护所', '#8a5a10');
    arrowPill('foodArrow', 12, 104, 170, 'foodArrowIcon', 'foodDist', '最近草料', '#8a5a10');
    arrowPill('windArrow', 12, 150, 170, 'windArrowIcon', 'windDist', getEl('windLabel')._text || '龙卷风', '#2b6a80');

    // toast
    var tEl = getEl('toast');
    if (tEl.style.opacity !== '0' && tEl._text) {
      g.save(); g.shadowColor = 'rgba(30,60,25,.8)'; g.shadowBlur = 8;
      fitText(tEl._text, W - 30, 21, 12, '#ffffff', W / 2, 118, 'center');
      g.restore();
    }

    // 底部提示（长文案自动换行，最多两行）
    var hint = getEl('hint')._text || '';
    if (hint) {
      var lines = wrap(hint, W - 40, 12);
      var n = Math.min(2, lines.length);
      var boxH = 14 + 18 * n;
      var hy = H - 10 - boxH;
      panel(12, hy, W - 24, boxH, 12);
      for (var i = 0; i < n; i++)
        text(lines[i], W / 2, hy + 12 + i * 18, 'bold 12px sans-serif', '#3d5a34', 'center');
    }
    // 坐标
    var coords = getEl('coords')._text || '';
    if (coords) text(coords, W - 16, H - 88, 'bold 12px sans-serif', '#3d5a34', 'right');

    // 小游戏无键盘：补两个常驻按钮（重开 / 静音），替代 Web 版 R / M 快捷键
    miniBtn(W - 52, H - 140, '↻', function () { if (G.__mmBridge) G.__mmBridge.restart(); });
    miniBtn(W - 98, H - 140, (G.__mmBridge && G.__mmBridge.isMuted && G.__mmBridge.isMuted()) ? '🔇' : '♪',
      function () { if (G.__mmBridge) { G.__mmBridge.toggleMute(); dirty = true; } });
  }

  function wrap(str, maxW, fs) {
    ctx.font = 'bold ' + fs + 'px sans-serif';
    var out = [], line = '';
    for (var i = 0; i < str.length; i++) {
      var t = line + str[i];
      if (ctx.measureText(t).width > maxW && line) { out.push(line); line = str[i]; }
      else line = t;
    }
    if (line) out.push(line);
    return out;
  }

  function miniBtn(x, y, label, fn) {
    fillRR(x, y, 38, 38, 19, 'rgba(255,255,255,.86)');
    text(label, x + 19, y + 19, 'bold 20px sans-serif', '#5da344', 'center');
    area(x, y, 38, 38, null, fn);
  }

  function arrowPill(id, x, y, w, iconId, distId, label, color) {
    var el = getEl(id);
    if (el.style.display !== 'flex') return;
    var h = 34;
    fillRR(x, y, w, h, 17, 'rgba(255,255,255,.92)');
    ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 2; rr(x, y, w, h, 17); ctx.stroke();
    var deg = parseFloat(String(getEl(iconId).style.transform).replace(/[^-\d.]/g, '')) || 0;
    ctx.save();
    ctx.translate(x + 18, y + h / 2);
    ctx.rotate(deg * Math.PI / 180);
    text('▲', 0, 0, 'bold 17px sans-serif', '#e8930c', 'center');
    ctx.restore();
    text(label, x + 34, y + h / 2, 'bold 13px sans-serif', color);
    text(getEl(distId)._text || '', x + w - 10, y + h / 2, 'bold 13px sans-serif', color, 'right');
  }

  /* ---------------- 开始菜单 ---------------- */
  function drawMenu() {
    skyBg();
    text('🐄', W / 2, H * 0.25, 'bold 82px sans-serif', '#ffffff', 'center');
    ctx.save();
    ctx.shadowColor = 'rgba(40,70,30,.35)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 4;
    fitText('哞哞庇护所', W - 30, 52, 30, '#ffffff', W / 2, H * 0.38, 'center');
    ctx.restore();
    text('Moumou Shelter · 2.5D 收集小游戏', W / 2, H * 0.44, 'bold 14px sans-serif', '#4a6b3f', 'center');
    text('点击草地移动小牛，收集草料，回到庇护所过关。', W / 2, H * 0.50, '14px sans-serif', '#3d5a34', 'center');
    text('当心树林挡路、河流拦路，还有龙卷风！', W / 2, H * 0.50 + 24, '14px sans-serif', '#3d5a34', 'center');
    var bw = Math.min(260, W - 80), bh = 58;
    button('btnStart', '开始游戏', W / 2 - bw / 2, H * 0.62, bw, bh);
    text('微信小游戏版 · 15 关 · 3 大章节', W / 2, H * 0.62 + bh + 34, 'bold 12px sans-serif', 'rgba(61,90,52,.65)', 'center');
  }

  /* ---------------- 选关（支持章节翻页 + 竖向滚动） ---------------- */
  function drawLevelSelect() {
    shade(0.5);
    var cw = Math.min(W - 28, 560), ch = Math.min(H - 90, 620);
    var cx = W / 2 - cw / 2, cy = H / 2 - ch / 2;
    card(cx, cy, cw, ch);
    text('选择关卡', W / 2, cy + 38, 'bold 27px sans-serif', '#e8930c', 'center');

    // 章节栏
    var ay = cy + 66, ar = 40;
    button('btnChapPrev', '‹', cx + 18, ay, ar, ar, { r: 20, fs: 26 });
    button('btnChapNext', '›', cx + cw - 18 - ar, ay, ar, ar, { r: 20, fs: 26 });
    fitText(getEl('stageName')._text || '', cw - 2 * ar - 60, 14, 10, '#6b8a5f', W / 2, ay + ar / 2, 'center');

    // 关卡卡片：宽屏 5 列、竖屏 2 列
    var cols = W >= 560 ? 5 : 2, gap = 10;
    var gx = cx + 20, gw = cw - 40;
    var cardW = (gw - gap * (cols - 1)) / cols;
    var cardH = cols === 2 ? 96 : 118;
    var gridTop = ay + ar + 18;
    var gridBottom = cy + ch - 74;
    var items = getEl('levelGrid').children || [];
    var rows = Math.ceil(items.length / cols);
    var contentH = rows * (cardH + gap) - gap;
    selectMaxScroll = Math.max(0, contentH - (gridBottom - gridTop));
    if (selectScroll > selectMaxScroll) selectScroll = selectMaxScroll;

    ctx.save();
    ctx.beginPath(); ctx.rect(gx, gridTop, gw, gridBottom - gridTop); ctx.clip();
    for (var i = 0; i < items.length; i++) {
      var el = items[i], d = el._card || { no: String(i + 1), name: '', desc: '', stars: '', state: '' };
      var px = gx + (i % cols) * (cardW + gap);
      var py = gridTop + Math.floor(i / cols) * (cardH + gap) - selectScroll;
      if (py + cardH < gridTop || py > gridBottom) continue;
      var locked = /locked/.test(el.className), cleared = /cleared/.test(el.className);
      fillRR(px, py, cardW, cardH, 16, cleared ? '#eef7e2' : '#f4f9ec');
      ctx.strokeStyle = cleared ? '#a5d183' : '#d9e8c8'; ctx.lineWidth = 2;
      rr(px, py, cardW, cardH, 16); ctx.stroke();
      ctx.globalAlpha = locked ? 0.55 : 1;
      text(d.no, px + cardW / 2, py + 20, 'bold 24px sans-serif', '#5da344', 'center');
      fitText(d.name, cardW - 12, 14, 10, '#3d5a34', px + cardW / 2, py + 42, 'center');
      text(d.stars, px + cardW / 2, py + 61, 'bold 12px sans-serif', '#f0b429', 'center');
      fitText(d.state, cardW - 12, 11, 9, cleared ? '#5da344' : '#9ab08e', px + cardW / 2, py + cardH - 14, 'center');
      ctx.globalAlpha = 1;
      if (!locked && el._listeners.click && el._listeners.click.length) area(px, py, cardW, cardH, el);
    }
    ctx.restore();

    button('btnBack', '返回', W / 2 - 70, cy + ch - 58, 140, 40, { ghost: true, fs: 15 });
    if (selectMaxScroll > 0)
      text('上下滑动查看更多', W / 2, cy + ch - 12, '11px sans-serif', '#9ab08e', 'center');
  }

  /* ---------------- 过关结算 / 错误页 ---------------- */
  function drawWin() {
    shade(0.45);
    var cw = Math.min(W - 36, 460), ch = 300;
    var cx = W / 2 - cw / 2, cy = H / 2 - ch / 2;
    card(cx, cy, cw, ch);
    text('🎉 过关啦！', W / 2, cy + 44, 'bold 30px sans-serif', '#e8930c', 'center');
    var lines = String(getEl('winText')._text || '').split('\n');
    for (var i = 0; i < lines.length; i++)
      fitText(lines[i], cw - 40, 16, 11, '#3d5a34', W / 2, cy + 88 + i * 26, 'center');
    var by = cy + 166, bw = 120, bh = 42, gap = 8;
    var nextVisible = getEl('btnNext').style.display !== 'none';
    var ids = nextVisible ? ['btnNext', 'btnRetry', 'btnMenu'] : ['btnRetry', 'btnMenu'];
    var labels = nextVisible ? ['下一关 →', '再玩一次', '返回选关'] : ['再玩一次', '返回选关'];
    var totalW = ids.length * bw + (ids.length - 1) * gap;
    var startX = W / 2 - totalW / 2;
    if (totalW > cw - 20) { bw = (cw - 30 - gap * (ids.length - 1)) / ids.length; totalW = cw - 30; startX = cx + 15; }
    for (var k = 0; k < ids.length; k++)
      button(ids[k], labels[k], startX + k * (bw + gap), by, bw, bh, { fs: 14, ghost: ids[k] === 'btnMenu' });
  }

  function drawErr() {
    shade(0.55);
    var cw = Math.min(W - 36, 480), ch = 260;
    var cx = W / 2 - cw / 2, cy = H / 2 - ch / 2;
    card(cx, cy, cw, ch);
    text('😥', W / 2, cy + 52, 'bold 48px sans-serif', '#e8930c', 'center');
    text('出错了', W / 2, cy + 96, 'bold 25px sans-serif', '#e8930c', 'center');
    var msg = String(getEl('errMsg')._text || '');
    var lines = wrap(msg, cw - 56, 13);
    for (var i = 0; i < lines.length && i < 3; i++)
      text(lines[i], W / 2, cy + 128 + i * 20, '13px sans-serif', '#3d5a34', 'center');
    button('btnErrRetry', '重试', W / 2 - 130, cy + 196, 120, 42, { fs: 16 });
    button('btnErrMenu', '返回菜单', W / 2 + 10, cy + 196, 120, 42, { fs: 16, ghost: true });
  }

  /* ---------------- 每帧 UI ---------------- */
  function modalVisible() {
    return getEl('menuOverlay').style.display === 'flex' ||
      getEl('levelSelectOverlay').style.display === 'flex' ||
      getEl('winOverlay').style.display === 'flex' ||
      getEl('errOverlay').style.display === 'flex';
  }
  function selectVisible() { return getEl('levelSelectOverlay').style.display === 'flex'; }

  function drawUI() {
    hitAreas.length = 0;
    // 雨幕（Web 版 z-index 在 HUD 之下）
    if (getEl('rainOverlay').style.display === 'block') {
      ctx.fillStyle = 'rgba(70,105,145,.22)'; ctx.fillRect(0, 0, W, H);
    }
    if (getEl('errOverlay').style.display === 'flex') { drawErr(); return; }
    if (getEl('menuOverlay').style.display === 'flex') { drawMenu(); return; }
    if (getEl('levelSelectOverlay').style.display === 'flex') { drawLevelSelect(); return; }
    if (getEl('hud').style.display !== 'none') drawHUD();
    if (getEl('winOverlay').style.display === 'flex') drawWin();
  }

  function composite() {
    ctx.clearRect(0, 0, W, H);
    if (lastRendererCanvas && lastRendererCanvas.width > 2) {
      try { ctx.drawImage(lastRendererCanvas, 0, 0, W, H); }
      catch (e) { skyBg(); }
    } else skyBg();
    drawUI();
    dirty = false;
  }

  /* 合成循环：在 core 的 rAF 之后启动，保证每帧先渲染 3D 再合成，无额外延迟 */
  function startCompositor() {
    function tick() {
      try { composite(); } catch (e) { console.warn('[wx-adapter] composite:', e); }
      G.requestAnimationFrame(tick);
    }
    G.requestAnimationFrame(tick);
  }

  /* ---------------- 触摸分发 ---------------- */
  var tStart = null, tLastY = 0, pinching = false;
  function wxTouches(e) {
    var a = [], ts = e && e.touches ? e.touches : [];
    for (var i = 0; i < ts.length; i++)
      a.push({ clientX: ts[i].clientX, clientY: ts[i].clientY, identifier: ts[i].identifier });
    return a;
  }
  function touchEv(touches) { return { touches: touches, preventDefault: noop, stopPropagation: noop }; }
  function fire(a) {
    if (!a) return;
    if (a.onClick) { try { a.onClick(); } catch (e) { console.warn('[wx-adapter] onClick:', e); } return; }
    var el = a.el;
    var ls = el && el._listeners && el._listeners.click;
    if (!ls) return;
    for (var i = 0; i < ls.length; i++) {
      try { ls[i]({ type: 'click', preventDefault: noop, stopPropagation: noop }); }
      catch (e) { console.warn('[wx-adapter] click:', e); }
    }
  }
  function hit(x, y) {
    for (var i = hitAreas.length - 1; i >= 0; i--) {
      var a = hitAreas[i];
      if (x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) return a;
    }
    return null;
  }

  wxApi.onTouchStart(function (e) {
    var ts = wxTouches(e);
    if (ts.length >= 2) { pinching = true; tStart = null; emitGlobal('touchstart', touchEv(ts)); return; }
    var t = ts[0]; if (!t) return;
    tStart = { x: t.clientX, y: t.clientY, moved: false };
    tLastY = t.clientY;
  });
  wxApi.onTouchMove(function (e) {
    var ts = wxTouches(e);
    if (ts.length >= 2) { pinching = true; emitGlobal('touchmove', touchEv(ts)); return; }
    var t = ts[0]; if (!t) return;
    if (tStart) {
      var dx = t.clientX - tStart.x, dy = t.clientY - tStart.y;
      if (dx * dx + dy * dy > 100) tStart.moved = true;
    }
    if (selectVisible() && selectMaxScroll > 0) {
      selectScroll = Math.max(0, Math.min(selectMaxScroll, selectScroll - (t.clientY - tLastY)));
    }
    tLastY = t.clientY;
  });
  wxApi.onTouchEnd(function (e) {
    var ts = wxTouches(e);
    if (pinching) {
      emitGlobal('touchend', touchEv(ts));
      if (ts.length < 2) pinching = false;
      tStart = null;
      return;
    }
    if (!tStart) return;
    var s = tStart; tStart = null;
    if (s.moved) return;
    var a = hit(s.x, s.y);
    if (a) { fire(a); return; }
    if (modalVisible()) return;                 // 覆盖层不穿透到 3D 场景
    dispatchCanvasEvent(lastRendererCanvas, 'pointerdown', {
      type: 'pointerdown', clientX: s.x, clientY: s.y, preventDefault: noop, stopPropagation: noop
    });
  });
  if (wxApi.onTouchCancel) wxApi.onTouchCancel(function () { tStart = null; pinching = false; });

  if (wxApi.onWindowResize) wxApi.onWindowResize(function () { dirty = true; emitGlobal('resize', {}); });
  if (wxApi.onError) wxApi.onError(function (e) { emitGlobal('error', { message: (e && e.message) || '未知错误' }); });
  if (wxApi.onHide) wxApi.onHide(function () { /* 后台暂停由游戏 rAF 自然降频 */ });
  if (wxApi.onShow) wxApi.onShow(function () { dirty = true; });

  /* ---------------- 导出 ---------------- */
  var ADAPTER = {
    W: W, H: H, DPR: DPR, LOW_END: LOW_END,
    mainCanvas: mainCanvas, ctx: ctx,
    getEl: getEl, document: documentShim,
    get rendererCanvas() { return lastRendererCanvas; },
    startCompositor: startCompositor,
    composite: composite,
    markDirty: function () { dirty = true; },
    emit: emitGlobal
  };
  G.__WX_ADAPTER = ADAPTER;
  if (typeof module !== 'undefined' && module.exports) module.exports = ADAPTER;
})(typeof GameGlobal !== 'undefined' ? GameGlobal : (typeof globalThis !== 'undefined' ? globalThis : this));
