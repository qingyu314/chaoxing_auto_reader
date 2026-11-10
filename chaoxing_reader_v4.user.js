// ==UserScript==
// @name         学习通专题文字自动滚动
// @namespace    local.chaoxing.reader
// @version      4.3.0
// @description  手动启动，滚动正文和嵌入式文档，按左侧目录逐节切换，支持后台。
// @match        *://*.chaoxing.com/*
// @match        *://*.sslibrary.com/*
// @match        *://*.duxiu.com/*
// @grant        GM_info
// @sandbox      DOM
// @run-at       document-end
// ==/UserScript==

(() => {
  'use strict';
  // 每个阅读器 frame 只操作自己的 DOM；跨域时由同一用户脚本的 frame 实例响应。
  // 前台按绘制帧推进；后台用定时器补充。位置使用浮点累积，低速也不会因取整停住。
  // 只检查当前可见区域，未到达的懒加载页不阻塞当前阅读。
  function loadGuard(win, getRoot, options = {}) {
    const cache = new Map();
    let lastCheck = -Infinity, last = { waiting: false, reason: '' };
    function check(force = false) {
      const now = win.performance.now();
      if (!force && now - lastCheck < 120) return last;
      lastCheck = now;
      const doc = win.document, root = getRoot();
      const wait = reason => (last = { waiting: true, reason });
      if (!root?.isConnected) return wait('正文尚未出现');
      const rect = root.getBoundingClientRect();
      const viewportRoot = root === doc.body || root === doc.documentElement || root === doc.scrollingElement;
      const clip = { left: Math.max(0, viewportRoot ? 0 : rect.left), top: Math.max(0, viewportRoot ? 0 : rect.top),
        right: Math.min(win.innerWidth, viewportRoot ? win.innerWidth : rect.right), bottom: Math.min(win.innerHeight, viewportRoot ? win.innerHeight : rect.bottom) };
      const onScreen = el => {
        const box = el.getBoundingClientRect(), style = win.getComputedStyle(el);
        return box.width > 0 && box.height > 0 && box.right > clip.left && box.left < clip.right && box.bottom > clip.top && box.top < clip.bottom
          && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      };
      const inspected = new Set([root]);
      // 加载遮罩常放在滚动容器外的 body 上；只要覆盖当前视口，也必须停住。
      for (const el of doc.querySelectorAll('[aria-busy="true"],[role="progressbar"],.loading,.loader,.loadingIcon,.loading-icon')) if (onScreen(el)) inspected.add(el);
      for (const el of root.querySelectorAll('img,input[type="image"],canvas,[aria-busy="true"],[role="progressbar"],.loading,.loader,.loadingIcon,.loading-icon,[data-page-number],.pdf-page,.book-page,.page-container')) if (onScreen(el)) inspected.add(el);
      if (clip.right <= clip.left || clip.bottom <= clip.top) return (last = { waiting: false, reason: '' });
      for (let row = 0; row < 6; row++) for (let col = 0; col < 3; col++) {
        const x = clip.left + (clip.right - clip.left) * (col + 0.5) / 3;
        const y = clip.top + (clip.bottom - clip.top) * (row + 0.5) / 6;
        for (const hit of doc.elementsFromPoint(x, y)) {
          if (hit !== root && !root.contains(hit)) continue;
          for (let el = hit, depth = 0; el && depth < 5; el = el.parentElement, depth++) {
            if (el !== root && !root.contains(el)) break;
            inspected.add(el); if (el === root) break;
          }
        }
      }
      let rendered = false, text = false;
      for (const el of inspected) {
        if (!onScreen(el) || /^(SCRIPT|STYLE|LINK|NOSCRIPT)$/.test(el.tagName)) continue;
        if (el.getAttribute('aria-busy') === 'true' || el.getAttribute('role') === 'progressbar'
            || /(^|\s)(loading|loader|loadingIcon|loading-icon)(\s|$)/.test(el.className || '')) return wait('页面正在加载');
        if (el.closest('button,select,nav,header,footer,[role="toolbar"],.toolbar,#toolbar')) continue;
        // 此阅读器用 input[type=image].Jimg 显示扫描页，并非普通 img。
        // 两份现场报告的区别是：白屏仍用 /images/dot.gif，正常时已替换为页图 URL。
        if (el.tagName === 'INPUT' && el.type === 'image') {
          const source = el.getAttribute('src') || '';
          let pathname = '';
          try { pathname = new URL(source, doc.baseURI).pathname; } catch {}
          if (el.classList.contains('Jimg') && (!source || /\/images\/dot\.gif$/i.test(pathname))) return wait('当前扫描页仍是 dot.gif 占位图，等待真实页图加载');
          if (!source) return wait('扫描页图片地址尚未就绪');
          const url = el.src;
          let entry = cache.get(url);
          if (!entry || (entry.error && now - entry.at > 10000)) {
            const image = new win.Image(); entry = { image, loaded: false, error: false, at: now }; cache.set(url, entry);
            image.onload = () => { entry.loaded = image.naturalWidth > 0; };
            image.onerror = () => { entry.error = true; };
            image.src = url;
            if (image.complete && image.naturalWidth > 0) entry.loaded = true;
          }
          // input[type=image] 没有 img 的 complete/naturalWidth，使用同 URL 的图像探针验证。
          if (!entry.loaded) return wait(entry.error ? '扫描页真实图片加载失败，稍后检查' : '真实页图地址已出现，等待图片加载完成');
          rendered = true;
        }
        if (el.tagName === 'IMG') {
          if (el.width < 60 && el.height < 60) continue;
          if (!el.getAttribute('src') && (el.dataset.src || el.dataset.original)) return wait('扫描页正在懒加载');
          if (el.naturalWidth <= 2 && el.naturalHeight <= 2 && (el.dataset.src || el.dataset.original)) return wait('扫描页仍是占位图');
          if (!el.complete || (el.getAttribute('src') && el.naturalWidth === 0)) return wait('扫描页图片尚未加载成功');
          if (el.naturalWidth > 0) rendered = true;
        }
        if (el.tagName === 'CANVAS' && el.width > 0 && el.height > 0) rendered = true;
        if (el.matches('[data-page-number]') && el.getAttribute('data-loaded') === 'false') return wait('PDF 页面尚未渲染');
        const style = win.getComputedStyle(el), background = style.backgroundImage;
        if (/gradient\(/.test(background)) rendered = true;
        for (const match of background.matchAll(/url\(["']?(.*?)["']?\)/g)) {
          const url = match[1];
          let entry = cache.get(url);
          if (!entry || (entry.error && now - entry.at > 10000)) {
            const image = new win.Image(); entry = { image, loaded: false, error: false, at: now }; cache.set(url, entry);
            image.onload = () => { entry.loaded = true; };
            image.onerror = () => { entry.error = true; };
            image.src = url;
            if (image.complete && image.naturalWidth > 0) entry.loaded = true;
          }
          if (!entry.loaded) return wait(entry.error ? '扫描页背景图加载失败，稍后重试' : '扫描页背景图正在加载');
          rendered = true;
        }
        for (const node of el.childNodes) {
          if (node.nodeType !== 3 || !node.textContent.trim()) continue;
          const range = doc.createRange(); range.selectNodeContents(node);
          if ([...range.getClientRects()].some(r => r.width > 1 && r.height > 1 && r.bottom > clip.top && r.top < clip.bottom && r.right > clip.left && r.left < clip.right)) text = true;
        }
      }
      const visibleText = (root.innerText || '').trim();
      if (/^(加载中|正在加载|加载失败|请稍候|请稍等|loading|please wait)[\s.…!！]*$/i.test(visibleText)) return wait('正文正在加载');
      // 内嵌扫描件可能由伪元素、切片、自定义元素或不可读的渲染层绘制。
      // 没识别到 DOM 内容只是未知，不是空白；明确加载信号已在上面单独处理。
      if (options.opaqueDocument && !rendered && !text) return (last = { waiting: false, reason: '', detection: 'unknown-renderer' });
      return (last = rendered || text || (options.textContentReady && visibleText)
        ? { waiting: false, reason: '' } : { waiting: true, reason: '当前可见区域仍为空白' });
    }
    return { check };
  }

  function continuousMotion(win) {
    let element = null, end = null, speed = 0, position = 0, previousTime = 0, expires = 0;
    let raf = null, fallback = null, active = false, oldBehavior = '', canAdvance = null;
    function stop() {
      active = false;
      if (raf !== null) win.cancelAnimationFrame(raf);
      if (fallback !== null) win.clearTimeout(fallback);
      raf = null; fallback = null;
      if (element) element.style.scrollBehavior = oldBehavior;
      element = null;
    }
    function advance(now) {
      if (!active) return;
      if (!element?.isConnected || now > expires) { stop(); return; }
      if (canAdvance && !canAdvance()) { stop(); return; }
      const delta = Math.min(Math.max(0, (now - previousTime) / 1000), win.document.hidden ? 1 : 0.1);
      previousTime = now;
      if (Math.abs(element.scrollTop - position) > 3) position = element.scrollTop;
      const target = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, end()));
      if (element.scrollTop >= target - 0.5) { stop(); return; }
      position = Math.min(target, position + speed * delta);
      element.scrollTop = position;
    }
    function frame(now) {
      raf = null; advance(now);
      if (active) raf = win.requestAnimationFrame(frame);
    }
    function background() {
      fallback = null; advance(win.performance.now());
      if (active) fallback = win.setTimeout(background, 100);
    }
    function run(target, pixelsPerSecond, getEnd, guard = null) {
      const now = win.performance.now();
      expires = now + (win.document.hidden ? 120000 : 5000);
      speed = pixelsPerSecond; end = getEnd; canAdvance = guard;
      if (active && element === target) return;
      stop();
      element = target; position = target.scrollTop; previousTime = now;
      oldBehavior = target.style.scrollBehavior; target.style.scrollBehavior = 'auto';
      active = true;
      raf = win.requestAnimationFrame(frame);
      fallback = win.setTimeout(background, 100);
    }
    win.addEventListener('pagehide', stop);
    return { run, stop, isRunning: target => active && element === target };
  }

  const CHANNEL = 'cx-local-document-reader-v3';
  const localReaderWorkers = new WeakMap();
  function frameTree(root) {
    const list = [];
    function visit(win, depth) {
      if (depth > 8 || list.length > 120) return;
      list.push({ win, depth });
      try { for (let i = 0; i < win.frames.length; i++) visit(win.frames[i], depth + 1); } catch {}
    }
    visit(root, 0);
    return list;
  }
  function installReaderWorker(win) {
    let doc;
    try {
      doc = win.document;
      if (localReaderWorkers.get(win)?.doc === doc) return localReaderWorkers.get(win);
      if (!doc.documentElement || doc.documentElement.dataset.cxReaderWorker === '3') return;
      doc.documentElement.dataset.cxReaderWorker = '3';
    } catch { return; }
    let nonce = null, controllerOrigin = null;
    const motion = continuousMotion(win);
    const style = el => win.getComputedStyle(el);
    const visible = el => {
      if (!el || !el.getClientRects().length) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style(el).visibility !== 'hidden' && style(el).display !== 'none';
    };
    const isDisabled = el => !el || el.disabled || el.getAttribute('aria-disabled') === 'true'
      || /(^|\s)(disabled|disable|is-disabled)(\s|$)/i.test(el.className || '');
    function nextButton() {
      const explicit = [...doc.querySelectorAll('#next, #nextPage, #next_page, .nextPage, .next-page, [title="下一页"], [aria-label="下一页"], [title="Next page"], [aria-label="Next page"]')];
      const named = [...doc.querySelectorAll('a,button,[role="button"],input[type="button"]')]
        .filter(el => /^(下一页|下页|后一页|next(?:\s+page)?)\s*[›»>]?$/.test((el.textContent || el.value || '').trim().toLowerCase()));
      return [...explicit, ...named].find(visible) || null;
    }
    function scrollBoxes() {
      const root = doc.scrollingElement || doc.documentElement;
      const candidates = [root, doc.body, ...doc.querySelectorAll('div,main,section,article')];
      return [...new Set(candidates)].filter(el => {
        if (!el || el.scrollHeight - el.clientHeight < 3 || el.clientHeight < 90 || el.clientWidth < 120 || !visible(el)) return false;
        return el === root || el === doc.body || /auto|scroll/.test(style(el).overflowY);
      }).sort((a, b) => {
        const score = el => Math.min(el.clientHeight, win.innerHeight) * Math.min(el.clientWidth, win.innerWidth)
          * Math.log2(el.scrollHeight - el.clientHeight + 2);
        return score(b) - score(a);
      });
    }
    const loading = loadGuard(win, () => scrollBoxes()[0] || doc.body, { opaqueDocument: true });
    const pageNumber = selector => {
      const el = doc.querySelector(selector);
      const raw = el?.value || el?.textContent || '';
      return /^\s*\d+\s*$/.test(raw) ? Number(raw) : null;
    };
    function snapshot() {
      const boxes = scrollBoxes(), box = boxes[0], next = nextButton();
      const images = [...doc.images].filter(img => visible(img) && (img.width > 150 || img.naturalWidth > 150));
      const activeImages = images.filter(img => { const rect = img.getBoundingClientRect(); return rect.bottom > 0 && rect.top < win.innerHeight; });
      let imageHash = 2166136261;
      for (const char of images.map(img => img.currentSrc || img.src).join('|')) imageHash = Math.imul(imageHash ^ char.charCodeAt(0), 16777619) >>> 0;
      const current = pageNumber('#pageNumber, #pageInput, input[name="page"], input[name="pageNum"]');
      const total = pageNumber('#numPages, #totalPages, .numPages');
      // 有些图书用背景图、自定义标签或切片渲染，doc.images/canvas/文字都可能为空。
      // 已存在显著滚动范围时也允许实际滚动，不再把这种阅读器误判为尚未加载。
      const readyFromScroll = !!box && box.scrollHeight - box.clientHeight >= Math.max(800, win.innerHeight);
      const ready = readyFromScroll || images.length || doc.querySelector('canvas,.page,#viewer,.pdfViewer') || (doc.body?.innerText.trim().length || 0) > 80;
      const nativeDocument = !!doc.querySelector('embed[type="application/pdf"],object[type="application/pdf"]');
      const load = loading.check();
      return {
        kind: nativeDocument ? 'unsupported' : box ? 'scroll' : next ? 'paged' : 'waiting',
        position: box ? Math.round(box.scrollTop) : 0,
        range: box ? Math.max(0, box.scrollHeight - box.clientHeight) : 0,
        viewport: box ? Math.min(box.clientHeight, win.innerHeight) : win.innerHeight,
        area: box ? Math.min(box.clientHeight, win.innerHeight) * Math.min(box.clientWidth, win.innerWidth) : 0,
        next: !!next, nextDisabled: !!next && isDisabled(next), current, total,
        images: images.length, pendingImages: activeImages.filter(img => !img.complete).length,
        brokenImages: activeImages.filter(img => img.complete && img.naturalWidth === 0 && img.getAttribute('src')).length,
        ready: !!ready, readyFromScroll, loadWaiting: load.waiting, loadReason: load.reason, loadDetection: load.detection || 'known',
        hasChildFrames: !!doc.querySelector('iframe'), host: win.location.hostname,
        signature: [box?.scrollHeight || 0, images.length, current, total, imageHash].join(':')
      };
    }
    function action(type, speed) {
      if (type === 'halt') { motion.stop(); return { ...snapshot(), stopped: true }; }
      const before = snapshot();
      if (type === 'flow') {
        if (before.loadWaiting) { motion.stop(); return { ...before, flowing: false }; }
        const boxes = scrollBoxes();
        for (const box of boxes) {
          if (motion.isRunning(box)) {
            motion.run(box, speed, () => box.scrollHeight - box.clientHeight, () => !loading.check().waiting);
            return { ...before, flowing: true };
          }
          const y = box.scrollTop;
          const oldBehavior = box.style.scrollBehavior;
          box.style.scrollBehavior = 'auto';
          box.scrollTop = Math.min(box.scrollHeight - box.clientHeight, y + 1);
          const works = box.scrollTop > y + 0.1;
          box.scrollTop = y;
          box.style.scrollBehavior = oldBehavior;
          if (works) {
            motion.run(box, speed, () => box.scrollHeight - box.clientHeight, () => !loading.check().waiting);
            return { ...before, flowing: true };
          }
        }
        return { ...before, flowing: false };
      }
      if (type === 'next') {
        motion.stop();
        const next = nextButton();
        if (next && !isDisabled(next)) { next.click(); return { ...snapshot(), clicked: true }; }
        return { ...before, clicked: false };
      }
      return before;
    }
    function hello() {
      if (win.top !== win) win.top.postMessage({ channel: CHANNEL, type: 'hello' }, '*');
    }
    const localApi = { doc, snapshot, action };
    localReaderWorkers.set(win, localApi);
    // 同域直接调用函数，不把父窗口 realm 中的 postMessage 误认为子 frame 的消息。
    if (win !== window) return localApi;
    win.addEventListener('message', event => {
      const message = event.data;
      if (event.source !== win.top || message?.channel !== CHANNEL) return;
      // 仅接受课程平台顶层窗口发出的命令。
      const controllerHost = (() => { try { return new URL(event.origin).hostname; } catch { return ''; } })();
      if (!/(^|\.)chaoxing\.com$/.test(controllerHost)) return;
      if (message.type === 'init' && typeof message.nonce === 'string') {
        nonce = message.nonce; controllerOrigin = event.origin;
      }
      if (!nonce || message.nonce !== nonce || event.origin !== controllerOrigin) return;
      if (!['init', 'probe', 'flow', 'halt', 'next'].includes(message.type)) return;
      try {
        const state = action(message.type, message.speed);
        event.source.postMessage({ channel: CHANNEL, type: 'state', nonce, requestId: message.requestId, state }, controllerOrigin);
      } catch (error) {
        event.source.postMessage({ channel: CHANNEL, type: 'state', nonce, requestId: message.requestId,
          state: { kind: 'error', error: String(error.message).slice(0, 160) } }, controllerOrigin);
      }
    });
    hello();
    win.setInterval(hello, 2000);
    return localApi;
  }

  if (window.top !== window.self) { installReaderWorker(window); return; }
  if (!/\/mooc-ans\/(zt\/|ztnodedetailcontroller\/visitnodedetail)/.test(location.pathname)) return;
  const ID = 'cx-local-reader';
  const VERSION = '4.3.0';
  const STORE = 'cx-reader-v4-settings';
  const SESSION = 'cx-reader-v4-navigation';
  const CONTROL_INTERVAL = 0.5;
  const previous = document.getElementById(ID);
  if (previous?.dataset.version === VERSION) return;
  // 兼容手动替换代码段：先停止旧面板，避免两份循环同时运行。
  if (previous) {
    previous.shadowRoot?.getElementById('close')?.click();
    if (document.getElementById(ID)) return;
  }
  const installed = typeof GM_info !== 'undefined';
  const ranges = { speed: [5, 1000], rest: [1, 60], dwell: [2, 600], limit: [1, 1000] };
  const labels = { speed: '滚动速度', rest: '加载休眠', dwell: '节末停留', limit: '切换上限' };
  const defaults = { speed: 80, rest: 5, dwell: 8, limit: 100 };
  let settings = { ...defaults };
  try { settings = { ...settings, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch {}
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isFinite(settings[key]) || settings[key] < min || settings[key] > max) settings[key] = defaults[key];
  }
  const host = document.createElement('div');
  host.id = ID;
  host.dataset.version = VERSION;
  host.style.cssText = 'position:fixed;right:18px;top:65px;z-index:2147483647;';
  const ui = host.attachShadow({ mode: 'open' });
  ui.innerHTML = `<style>
    :host{all:initial}*{box-sizing:border-box}.box{width:300px;padding:16px;background:#fff;color:#172b4d;border:1px solid #cad4e0;border-radius:12px;box-shadow:0 4px 24px #0003;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}
    strong{font-size:16px}label{display:flex;align-items:center;justify-content:space-between;margin:9px 0}input{width:78px;padding:4px;border:1px solid #b7c5d6;border-radius:5px;font:inherit}button{cursor:pointer;border:1px solid #aabbd0;border-radius:6px;background:#f3f6fa;color:#172b4d;padding:6px 10px;font:inherit}button:disabled{opacity:.5;cursor:default}#start{background:#1d64d8;color:white;border-color:#1d64d8}.buttons{display:flex;gap:7px;margin-top:12px}#status{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:12px;padding:9px;background:#edf3fb;border-radius:6px;max-height:170px;overflow:auto}small{display:block;color:#526478;margin-top:8px}#close{float:right;border:0;background:transparent;padding:0 4px;font-size:20px}#diagnostic{margin-top:8px}
  </style><div class="box"><button id="close" title="停止并关闭">×</button><strong>连续滚动阅读 · v4.3</strong>
    <label>滚动速度（像素/秒）<input id="speed" type="number" min="5" max="1000" step="5"></label>
    <label>加载休眠（秒）<input id="rest" type="number" min="1" max="60"></label>
    <label>节末停留（秒）<input id="dwell" type="number" min="2" max="600"></label>
    <label>本次最多切换（节）<input id="limit" type="number" min="1" max="1000"></label>
    <div class="buttons"><button id="start">开始</button><button id="pause" disabled>暂停</button><button id="stop">停止</button></div>
    <button id="diagnostic">显示诊断</button><div id="status" role="status">脚本已加载，正在识别目录…</div>
    <small>按左侧目录顺序切换。可后台运行；页面休眠、冻结时无法执行。Esc 暂停。</small></div>`;
  (document.body || document.documentElement).appendChild(host);
  const $ = id => ui.getElementById(id);
  const say = text => { $('status').textContent = text; };
  for (const key of Object.keys(ranges)) $(key).value = settings[key];
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const isDetail = () => location.pathname.includes('/ztnodedetailcontroller/visitnodedetail');
  const courseId = () => {
    const current = new URL(location.href);
    return current.searchParams.get('courseId') || current.pathname.match(/\/zt\/(\d+)/)?.[1]
      || document.querySelector('#courseUnit a[href*="/zt/"]')?.getAttribute('href')?.match(/\/zt\/(\d+)/)?.[1];
  };
  function directory() {
    const entries = [], seen = new Set();
    const course = courseId();
    for (const link of document.querySelectorAll('.course_section a[href*="knowledgeId="]')) {
      const url = new URL(link.getAttribute('href'), location.href);
      const id = url.searchParams.get('knowledgeId');
      if (url.origin !== location.origin || url.pathname !== '/mooc-ans/ztnodedetailcontroller/visitnodedetail'
          || !id || seen.has(id) || (course && url.searchParams.get('courseId') !== course)) continue;
      seen.add(id);
      entries.push({ id, url, link, title: link.textContent.replace(/\s+/g, ' ').trim() });
    }
    return entries;
  }
  function currentId() {
    return new URL(location.href).searchParams.get('knowledgeId')
      || document.querySelector('.course_section.liCur a[href*="knowledgeId="]')?.getAttribute('href')?.match(/knowledgeId=(\d+)/)?.[1]
      || document.getElementById('nodeIdInput')?.value;
  }
  function currentEntry() { return directory().find(entry => entry.id === currentId()); }
  const main = () => document.getElementById('courseMainBox');
  const content = () => main()?.querySelector('#contentDescriptionBox') || document.getElementById('caContentBox') || main();
  const outerLoading = loadGuard(window, content, { textContentReady: true });
  let sleepUntil = 0;
  let running = false, token = 0, switches = 0, timer = null, setupTimer = null;
  const outerMotion = continuousMotion(window);
  let selectedScroller = null, endWait = 0, loadWait = 0, lastTime = 0, navigated = false, navigationWait = 0;
  const readerWorkers = new Map(), readerRequests = new Map();
  let readerSelected = null, readerSignature = '', readerEndWait = 0, readerNextPending = null;
  let readerRequestCounter = 0, readerMissingWait = 0, readerLoadWait = 0;
  const readerNonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('');
  const readerFrame = () => content()?.querySelector('iframe.ans-book,iframe.ans-book-simple,iframe[module="insertbook"],iframe[src*="/innerbook/"],iframe');
  function readerWindows() {
    const frame = readerFrame();
    return frame?.contentWindow ? frameTree(frame.contentWindow) : [];
  }
  function registerWorker(source, origin) {
    if (!readerWindows().some(item => item.win === source)) return false;
    let hostname;
    try { hostname = new URL(origin).hostname; } catch { return false; }
    if (origin !== location.origin && !/(^|\.)(chaoxing\.com|sslibrary\.com|duxiu\.com)$/.test(hostname)) return false;
    if (!readerWorkers.has(source)) readerWorkers.set(source, { origin, state: null });
    return true;
  }
  function onReaderMessage(event) {
    const message = event.data;
    if (message?.channel !== CHANNEL) return;
    if (message.type === 'hello') {
      if (registerWorker(event.source, event.origin)) event.source.postMessage({ channel: CHANNEL, type: 'init', nonce: readerNonce }, event.origin);
      return;
    }
    const worker = readerWorkers.get(event.source);
    if (!worker || worker.origin !== event.origin || message.nonce !== readerNonce || message.type !== 'state') return;
    worker.state = message.state;
    const request = readerRequests.get(message.requestId);
    if (request && request.source === event.source) {
      readerRequests.delete(message.requestId); clearTimeout(request.timer); request.resolve(message.state);
    }
  }
  window.addEventListener('message', onReaderMessage);
  function askWorker(source, type) {
    const worker = readerWorkers.get(source);
    if (!worker) return Promise.resolve(null);
    if (worker.localApi) {
      try { const state = worker.localApi.action(type, settings.speed); worker.state = state; return Promise.resolve(state); }
      catch (error) { return Promise.resolve({ kind: 'error', error: error.message }); }
    }
    const requestId = ++readerRequestCounter;
    return new Promise(resolve => {
      const timer = setTimeout(() => { readerRequests.delete(requestId); resolve(null); }, 10000);
      readerRequests.set(requestId, { source, resolve, timer });
      source.postMessage({ channel: CHANNEL, type, requestId, nonce: readerNonce, speed: settings.speed }, worker.origin);
    });
  }
  function haltReader(source) {
    const worker = readerWorkers.get(source);
    if (!worker) return;
    try {
      if (worker.localApi) worker.localApi.action('halt');
      else source.postMessage({ channel: CHANNEL, type: 'halt', nonce: readerNonce }, worker.origin);
    } catch {}
  }
  function haltMotions() {
    outerMotion.stop();
    for (const source of readerWorkers.keys()) haltReader(source);
  }
  function nap(reason) {
    haltMotions();
    endWait = 0; readerEndWait = 0;
    sleepUntil = Date.now() + settings.rest * 1000;
    say(`${reason}\n已暂停滚动，休眠 ${settings.rest} 秒后自动检查；加载完成后继续。`);
  }
  function discoverReaders() {
    const windows = readerWindows();
    for (const { win } of windows) {
      // 同域 frame 可直接安装；跨域 frame 由 Tampermonkey 在其自身页面内运行。
      try {
        const localApi = installReaderWorker(win);
        if (localApi) readerWorkers.set(win, { origin: location.origin, localApi, state: localApi.snapshot() });
      } catch {}
    }
    for (const win of readerWorkers.keys()) if (!windows.some(item => item.win === win)) readerWorkers.delete(win);
    return windows;
  }
  async function readDocument(elapsed, runToken) {
    const windows = discoverReaders();
    const available = windows.filter(({ win }) => {
      const state = readerWorkers.get(win)?.state;
      // 图书阅读器可能另带回调、统计 iframe；有子 frame 不等于只是包裹层。
      // 保留它自己的滚动能力，再从可用区域中选择实际阅读层。
      return ['scroll', 'paged'].includes(state?.kind) && (state.ready || state.loadWaiting);
    });
    available.sort((a, b) => b.depth - a.depth || (readerWorkers.get(b.win).state.area || 0) - (readerWorkers.get(a.win).state.area || 0));
    if (!available.length) {
      readerMissingWait += elapsed;
      if (readerMissingWait > 30) pause(readerWorkers.size
        ? '阅读器已连接，但没有识别到可用的文档滚动区域。请点击“显示诊断”。'
        : '文档内层未连接。请确认 Tampermonkey 允许阅读器域名运行脚本，然后点“显示诊断”。');
      else say('正在连接文档内层…\n请等待图书页面和内层滚动条加载。');
      return false;
    }
    readerMissingWait = 0;
    const selected = available[0].win;
    if (selected !== readerSelected) {
      if (readerSelected) haltReader(readerSelected);
      readerSelected = selected; readerEndWait = 0; readerSignature = ''; readerNextPending = null;
    }
    const state = await askWorker(selected, 'probe');
    if (!running || token !== runToken) return false;
    if (!state) { say('等待文档内层响应…'); return false; }
    if (state.kind === 'error') { pause('文档内层异常：' + state.error); return false; }
    if (!state.ready || state.loadWaiting) {
      nap(state.loadReason || '文档图片或页面尚未加载成功');
      return false;
    }
    readerLoadWait = 0;
    const title = currentEntry()?.title || '文档';
    if (readerNextPending) {
      if (state.signature !== readerNextPending.signature || state.position < readerNextPending.position - 3) {
        readerNextPending = null; readerEndWait = 0;
      } else {
        readerNextPending.waited += elapsed;
        if (readerNextPending.waited > 30) pause('点击文档“下一页”后，页码和内容没有变化，已暂停。');
        else say('等待文档下一页加载…');
        return false;
      }
    }
    if (state.kind === 'scroll' && state.position < state.range - 3) {
      readerEndWait = 0;
      const result = await askWorker(selected, 'flow');
      if (!running || token !== runToken) return false;
      if (result?.loadWaiting) { nap(result.loadReason); return false; }
      if (result?.flowing === false) pause('文档内层滚动未生效，请点“显示诊断”。');
      else say(`${title}\n正在连续滚动文档 · ${settings.speed} 像素/秒\n已切换 ${switches} 节`);
      return false;
    }
    haltReader(selected);
    if (state.signature !== readerSignature) { readerSignature = state.signature; readerEndWait = 0; }
    readerEndWait += elapsed;
    if (readerEndWait < settings.dwell) { say(`${title}\n文档当前末尾，等待 ${Math.ceil(settings.dwell - readerEndWait)} 秒确认加载。`); return false; }
    if (state.next && !state.nextDisabled) {
      readerNextPending = { signature: state.signature, position: state.position, waited: 0 };
      const result = await askWorker(selected, 'next');
      if (!running || token !== runToken) return false;
      if (!result?.clicked) { readerNextPending = null; pause('文档下一页按钮未能点击，已暂停。'); }
      else { readerEndWait = 0; say('已点击文档内的“下一页”…'); }
      return false;
    }
    if (state.current && state.total && state.current < state.total) {
      pause('尚未到文档最后一页，但未找到可用的文档翻页按钮，请点“显示诊断”。'); return false;
    }
    // 连续滚动型：滚动范围稳定且无图片待加载后，才认定到达当前文档末尾。
    return true;
  }
  function candidates() {
    const items = [];
    for (let el = content(); el; el = el.parentElement) {
      if (el !== document.body && el !== document.documentElement && /auto|scroll/.test(getComputedStyle(el).overflowY)
          && el.scrollHeight > el.clientHeight + 2) items.push(el);
    }
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > root.clientHeight + 2) items.push(root);
    if (document.body.scrollHeight > document.body.clientHeight + 2) items.push(document.body);
    return [...new Set([...items, root])];
  }
  function scroller() {
    if (selectedScroller?.isConnected) return selectedScroller;
    return candidates()[0];
  }
  function bounds(el) {
    const root = document.scrollingElement || document.documentElement;
    const y = el === root ? 0 : el.getBoundingClientRect().top + el.clientTop;
    const height = el === root ? innerHeight : Math.min(el.clientHeight || innerHeight, innerHeight);
    return { y, height };
  }
  // 只写原生 scrollTop，兼容该站点覆写了 scrollTo 的 MooTools。
  function move(el, target) {
    const before = el.scrollTop;
    el.scrollTop = target;
    if (Math.abs(el.scrollTop - before) > 0.5) { selectedScroller = el; return true; }
    for (const alternate of candidates()) {
      if (alternate === el) continue;
      const previousTop = alternate.scrollTop;
      alternate.scrollTop = previousTop + Math.max(1, target - before);
      if (Math.abs(alternate.scrollTop - previousTop) > 0.5) { selectedScroller = alternate; return true; }
    }
    return false;
  }
  const clearSession = () => { try { sessionStorage.removeItem(SESSION); } catch {} };
  function pause(text = '已暂停。点击开始继续。') {
    running = false; token++; clearTimeout(timer); clearSession();
    sleepUntil = 0;
    haltMotions();
    $('start').disabled = false; $('pause').disabled = true;
    for (const key of Object.keys(ranges)) $(key).disabled = false;
    for (const request of readerRequests.values()) { clearTimeout(request.timer); request.resolve(null); }
    readerRequests.clear();
    say(text);
  }
  function normalized(entry) {
    const url = new URL(entry.url.href), here = new URL(location.href);
    for (const key of ['_from_', '_fromV2_', 'rtag']) {
      if (here.searchParams.has(key)) url.searchParams.set(key, here.searchParams.get(key));
      else if (/\$\{/.test(url.searchParams.get(key) || '')) url.searchParams.delete(key);
    }
    return url;
  }
  function navigate(entry, count) {
    haltMotions();
    if (!installed) { pause('跨章节需安装为 Tampermonkey 用户脚本。代码段在整页切换后不会自动加载。'); return; }
    const url = normalized(entry);
    try {
      sessionStorage.setItem(SESSION, JSON.stringify({ course: courseId(), id: entry.id, switches: count,
        expires: Date.now() + 24 * 3600 * 1000, settings }));
    } catch { pause('无法保存本标签页的续跑状态，已停止。'); return; }
    // 点击左侧目录中实际存在的链接，不调用“加载更多”或内容接口。
    entry.link.href = url.href;
    entry.link.target = '_self';
    navigated = true; navigationWait = 0;
    say('正在点击左侧目录：\n' + entry.title);
    entry.link.click();
  }
  function start() {
    if (running) return;
    clearTimeout(timer);
    for (const [key, [min, max]] of Object.entries(ranges)) {
      const value = Number($(key).value);
      if (!Number.isFinite(value) || value < min || value > max || (key === 'limit' && !Number.isInteger(value))) {
        say(`${labels[key]}须为 ${min}–${max}${key === 'limit' ? ' 的整数' : ''}。`); return;
      }
      settings[key] = value;
    }
    try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch {}
    running = true; token++; endWait = 0; loadWait = 0; navigated = false; selectedScroller = null; sleepUntil = 0;
    readerSelected = null; readerSignature = ''; readerEndWait = 0; readerNextPending = null; readerMissingWait = 0; readerLoadWait = 0;
    lastTime = performance.now(); $('start').disabled = true; $('pause').disabled = false;
    for (const key of Object.keys(ranges)) $(key).disabled = true;
    say('正在识别当前章节…');
    schedule(token, 0);
  }
  function schedule(id, delay) {
    timer = setTimeout(async () => {
      if (!running || id !== token) return;
      try { await tick(id); } catch (error) { console.error('[文档阅读 v3]', error); pause('脚本异常：' + error.message); }
      if (running && id === token) schedule(id, Math.max(CONTROL_INTERVAL * 1000, sleepUntil - Date.now()));
    }, delay);
  }
  async function tick(runToken) {
    if (Date.now() < sleepUntil) return;
    sleepUntil = 0;
    const now = performance.now();
    const elapsed = Math.max(0, Math.min((now - lastTime) / 1000, CONTROL_INTERVAL + 1));
    lastTime = now;
    if (navigated) {
      navigationWait += elapsed;
      if (navigationWait > 15) pause('目录点击后未成功切换页面。请手动打开该章节并重新开始。');
      return;
    }
    const entries = directory(), entry = currentEntry();
    if (!main() || !entries.length || !entry) {
      loadWait += elapsed;
      if (loadWait > 30) pause('未能识别正文或当前目录项。点击“显示诊断”查看详情。');
      else say('等待正文和左侧目录加载…');
      return;
    }
    if (!isDetail()) { navigate(entry, switches); return; }
    const article = content();
    if (!article || !visible(article) || (!article.textContent.trim() && !article.querySelector('iframe,canvas,img,embed,object'))) {
      nap('当前章节正文尚未加载');
      return;
    }
    const documentFrame = readerFrame();
    if (documentFrame) {
      outerMotion.stop();
      if (!await readDocument(elapsed, runToken) || !running || token !== runToken) return;
      advanceDirectory(entries, entry);
      return;
    }
    if (article.querySelector('video, embed, object')) {
      pause('当前内容为视频或浏览器原生文档插件，尚不支持。请手动处理后继续。'); return;
    }
    const load = outerLoading.check(true);
    if (load.waiting) { nap(load.reason); return; }
    loadWait = 0;
    const el = scroller(), viewport = bounds(el);
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const target = Math.min(max, Math.max(0, el.scrollTop + article.getBoundingClientRect().bottom - viewport.y - viewport.height + 24));
    if (el.scrollTop > target + viewport.height) {
      // 长目录可能让浏览器恢复到正文下方，先回到当前正文上沿。
      el.scrollTop = Math.max(0, el.scrollTop + article.getBoundingClientRect().top - viewport.y - 24);
      endWait = 0; return;
    }
    if (el.scrollTop < target - 3) {
      endWait = 0;
      outerMotion.run(el, settings.speed, () => {
        const box = bounds(el);
        return el.scrollTop + article.getBoundingClientRect().bottom - box.y - box.height + 24;
      }, () => !outerLoading.check().waiting);
      say(`${entry.title}\n正在连续滚动正文 · ${settings.speed} 像素/秒\n已切换 ${switches} 节`);
      return;
    }
    outerMotion.stop();
    endWait += elapsed;
    if (endWait < settings.dwell) { say(`${entry.title}\n正文末尾，${Math.ceil(settings.dwell - endWait)} 秒后点击下一项目录。`); return; }
    advanceDirectory(entries, entry);
  }
  function advanceDirectory(entries, entry) {
    const index = entries.findIndex(item => item.id === entry.id);
    if (index === entries.length - 1) { pause(`已到目录最后一节。共切换 ${switches} 节；请核对平台阅读记录。`); return; }
    if (switches >= settings.limit) { pause(`已达到本次切换上限 ${settings.limit}。点击停止可重置计数。`); return; }
    navigate(entries[index + 1], switches + 1);
  }
  function diagnostic() {
    const el = scroller();
    const windows = discoverReaders();
    const workers = [...readerWorkers.values()].map(worker => `${worker.state?.host || new URL(worker.origin).hostname}：${worker.state?.kind || '连接中'} ${worker.state?.position || 0}/${worker.state?.range || 0}；内容${worker.state?.ready ? '就绪' : '未就绪'}${worker.state?.readyFromScroll ? '（滚动区域）' : ''}；子frame${worker.state?.hasChildFrames ? '有' : '无'}；图片${worker.state?.images || 0}（待载${worker.state?.pendingImages || 0}）`).join('\n');
    const framePaths = [];
    for (const { win } of windows) {
      try { for (const frame of win.document.querySelectorAll('iframe')) { const url = new URL(frame.src, win.document.baseURI); framePaths.push(url.origin + url.pathname); } } catch {}
    }
    say(`版本：${VERSION}\n脚本环境：${installed ? '用户脚本' : '页面代码段'}\n正文：${main() ? '已找到' : '未找到'}\n目录：${directory().length} 项\n当前章节：${currentId() || '未识别'}\n外层位置：${Math.round(el.scrollTop)} / ${Math.max(0, el.scrollHeight - el.clientHeight)}\n文档 frame：${windows.length} 个；已连接 ${readerWorkers.size} 个\n${workers}\n${[...new Set(framePaths)].slice(0, 5).join('\n')}\n状态：${running ? '运行中' : '已暂停'}；${document.hidden ? '后台' : '前台'}`);
  }
  $('start').addEventListener('click', start);
  $('pause').addEventListener('click', () => pause());
  $('stop').addEventListener('click', () => { switches = 0; pause('已停止，计数已重置。'); });
  $('diagnostic').addEventListener('click', () => { pause(); diagnostic(); });
  const onKey = event => { if (event.key === 'Escape') pause('已通过 Esc 暂停。'); };
  document.addEventListener('keydown', onKey);
  $('close').addEventListener('click', () => { pause(); clearTimeout(setupTimer); document.removeEventListener('keydown', onKey); window.removeEventListener('message', onReaderMessage); host.remove(); });
  // 等待延迟渲染；面板先出现，不再因 document-end 时正文未就绪而静默退出。
  let attempts = 0;
  function setup() {
    attempts++;
    if (!main() || !directory().length) {
      if (attempts > 60) { say('脚本已加载，但未找到课程目录。请点“显示诊断”。'); return; }
      setupTimer = setTimeout(setup, 500); return;
    }
    let resume = null;
    try { resume = JSON.parse(sessionStorage.getItem(SESSION) || 'null'); } catch {}
    clearSession();
    if (resume && resume.expires > Date.now() && resume.course === courseId() && resume.id === currentId()) {
      switches = Number.isInteger(resume.switches) ? resume.switches : 0;
      for (const [key, [min, max]] of Object.entries(ranges)) {
        if (Number.isFinite(resume.settings?.[key]) && resume.settings[key] >= min && resume.settings[key] <= max) $(key).value = resume.settings[key];
      }
      say('已进入目录中的下一节，2 秒后继续。点击停止可取消。');
      timer = setTimeout(start, 2000);
    } else say(`脚本已加载 · 目录 ${directory().length} 项\n点击“开始”，按左侧目录顺序阅读。`);
  }
  setup();
})();
