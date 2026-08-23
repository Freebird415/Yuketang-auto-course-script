// ==UserScript==
// @name         雨课堂连播助手
// @namespace    https://greasyfork.org/users/1616996-acac1a
// @version      1.5
// @description  一个利用Reasonix开发的，雨课堂自动静音二倍速刷课脚本。内嵌alwaysonfocus功能，可后台挂机。支持一键BUG上报。适用于华工雨课堂：https://scut.yuketang.cn 与 长江雨课堂：https://changjiang.yuketang.cn
// @author       Acac1a
// @match        *://scut.yuketang.cn/*
// @match        *://changjiang.yuketang.cn/*
// @match        *://*.yuketang.cn/*
// @grant        GM_xmlhttpRequest
// @connect      open.feishu.cn
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const IS_YUKETANG = /yuketang\.cn/.test(location.hostname);
  // 华工: /pro/lms/{sig}/{cid}/video/{leafId}；长江: /v2/web/xcloud/video-student/{cid}/{leafId}
  const IS_VIDEO_PAGE = IS_YUKETANG && (/\/pro\/lms\/.*\/video\//.test(location.pathname) || /\/v2\/web\/xcloud\/video-student\//.test(location.pathname));
  const IS_SCORE_PAGE = IS_YUKETANG && (/\/pro\/lms\/.*\/score/.test(location.pathname) || /\/v2\/web\/xcloud\/.*\/score/.test(location.pathname));
  const IS_COURSE_LIST = IS_YUKETANG && (/\/pro\/courselist/.test(location.pathname) || location.pathname.includes('/v2/web/xcloud/courselist'));

  // ===================================================================
  //  模块 0：always-on-focus（始终激活，不受开始/停止影响）
  // ===================================================================
  (function alwaysOnFocus() {
    if (!IS_YUKETANG) return;
    try {
      ['hidden', 'mozHidden', 'msHidden', 'webkitHidden'].forEach(p => {
        try { Object.defineProperty(document, p, { value: false }); } catch (_) {}
      });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
      Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible' });
      document.hasFocus = () => true;
      window.onblur = null;

      const block = (e) => {
        if (e.type === 'blur') {
          if (e.target instanceof HTMLInputElement || e.target instanceof HTMLAnchorElement ||
              e.target instanceof HTMLSpanElement || e.target instanceof HTMLParagraphElement) return;
          if (e.target.classList?.contains('ql-editor')) return;
        }
        if (['mouseleave', 'mouseout'].includes(e.type)) {
          if (!(e.target instanceof HTMLHtmlElement || e.target instanceof HTMLBodyElement ||
                e.target instanceof HTMLIFrameElement || e.target instanceof HTMLHeadElement)) return;
        }
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      };
      ['visibilitychange', 'webkitvisibilitychange', 'blur', 'mouseleave', 'mouseout',
       'mozvisibilitychange', 'msvisibilitychange'].forEach(evt => {
        window.addEventListener(evt, block, true);
        document.addEventListener(evt, block, true);
      });
    } catch (e) {}
  })();

  // ===================================================================
  //  模块 1：条件性原型链拦截（仅在激活时生效）
  // ===================================================================
  (function conditionalHack() {
    if (!IS_YUKETANG) return;
    try {
      window._yktEngineActive = false; // 默认关闭

      const rateDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
      if (rateDesc?.set) {
        const orig = rateDesc.set;
        rateDesc.set = function (val) {
          return window._yktEngineActive ? orig.call(this, 2) : orig.call(this, val);
        };
        Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', rateDesc);
      }

      const volDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
      if (volDesc?.set) {
        const orig = volDesc.set;
        volDesc.set = function (val) {
          return window._yktEngineActive ? orig.call(this, 0) : orig.call(this, val);
        };
        Object.defineProperty(HTMLMediaElement.prototype, 'volume', volDesc);
      }

      const origPause = HTMLVideoElement.prototype.pause;
      HTMLVideoElement.prototype.pause = function () {
        if (!window._yktEngineActive) return origPause.call(this);
        if (this._scriptAllowPause) return origPause.call(this);
        if (this.ended) return origPause.call(this);
        if (document.hidden) return;
        this.play().catch(() => {});
      };
    } catch (e) { console.error('[雨课堂] 原型链失败:', e); }
  })();


  // ===================================================================
  //  以下是雨课堂页面的完整逻辑
  // ===================================================================

  const DEBUG = true;
  const ts = () => {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  };
  function log(s, r, d) {
    if (!DEBUG) return;
    const i = { OK: '✅', FAIL: '❌', WAIT: '⏳', INFO: '📋' }[r] || '📋';
    if (d !== undefined) console.log(`[雨课堂] [${ts()}] ${i} ${s}`, d);
    else console.log(`[雨课堂] [${ts()}] ${i} ${s}`);
  }
  log('脚本加载', 'INFO', `v1.5 | 视频页:${IS_VIDEO_PAGE} | 成绩单:${IS_SCORE_PAGE}`);

  // ========== 诊断事件史（v1.5） ==========
  // 运行时记录关键媒体/错误事件到内存环形缓冲，BUG 上报时随诊断数据发送，
  // 免去用户开控制台执行命令。capture 监听可捕获动态创建的 <video> 事件。
  const MEDIA_WATCH_EVENTS = ['play', 'pause', 'ended', 'seeked', 'stalled', 'waiting', 'canplay', 'loadeddata', 'emptied'];
  const mediaEventLog = [];
  const videoErrorLog = [];
  window._yktErrorLog = [];

  function captureMediaEvent(e) {
    const t = e.target;
    if (!t || (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO')) return;
    // stalled/waiting 高频节流：5 秒内同类型只记一条，避免挤占环形缓冲
    const now = Date.now();
    if ((e.type === 'stalled' || e.type === 'waiting')
      && mediaEventLog.length && mediaEventLog[mediaEventLog.length - 1].type === e.type
      && now - lastMediaEventTs < 5000) return;
    lastMediaEventTs = now;
    mediaEventLog.push({ t: ts(), type: e.type, ct: Math.round(t.currentTime || 0), rs: t.readyState ?? -1 });
    if (mediaEventLog.length > 20) mediaEventLog.shift();
  }
  let lastMediaEventTs = 0;
  if (document.addEventListener) {
    MEDIA_WATCH_EVENTS.forEach(evt => document.addEventListener(evt, captureMediaEvent, true));
    document.addEventListener('error', (e) => {
      const t = e.target;
      if (!t || (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO')) return;
      videoErrorLog.push({
        t: ts(), code: t.error?.code ?? null,
        ct: Math.round(t.currentTime || 0),
      });
      if (videoErrorLog.length > 3) videoErrorLog.shift();
    }, true);
  }

  // ========== 面板日志 ==========
  let panelLogLines = [];
  function panelLog(msg) {
    panelLogLines.push(`[${ts()}] ${msg}`);
    if (panelLogLines.length > 100) panelLogLines.shift();
    updatePanelLog();
  }

  // ========== 跨页面状态共享 ==========
  function updateSharedStatus(updates) {
    try {
      const raw = localStorage.getItem('_ykt_status');
      const cur = raw ? JSON.parse(raw) : {};
      Object.assign(cur, updates, { _ts: Date.now() });
      localStorage.setItem('_ykt_status', JSON.stringify(cur));
    } catch (_) {}
  }

  // ========== 成绩单页面：抓取视频列表 ==========
  function scrapeScorePage() {
    if (!IS_SCORE_PAGE) return;
    try {
      const items = [];
      // 查找所有 li 中的 Video 单元
      const lis = document.querySelectorAll('li');
      lis.forEach((li, idx) => {
        const videoSpan = li.querySelector('span.cursorpoint.unit-name-hover, span[class*="unit-name"]');
        const titleDiv = li.querySelector('div.chapter-name-td, div[class*="chapter-name"]');
        if (videoSpan && titleDiv) {
          const title = (titleDiv.textContent || '').trim();
          const typeText = (videoSpan.textContent || '').trim();
          if (typeText === 'Video' && title) {
            // 检查是否有"已完成"标记
            const done = /已完成/.test(li.textContent || '');
            items.push({ index: idx, title, completed: done });
          }
        }
      });

      if (items.length > 0) {
        const videoItems = items.filter(it => it.title.includes('、') || it.title.length > 3);
        const data = {
          totalVideos: videoItems.length,
          titles: videoItems.map(it => ({ title: it.title, completed: it.completed })),
          timestamp: Date.now(),
        };
        localStorage.setItem('_ykt_score_data', JSON.stringify(data));
        panelLog(`成绩单扫描: ${videoItems.length} 个视频`);
      }
    } catch (e) { panelLog(`成绩单扫描失败: ${e.message}`); }
  }

  // ========== 视频页面：匹配当前视频标题以确定索引 ==========
  function matchCurrentVideo() {
    try {
      const raw = localStorage.getItem('_ykt_score_data');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data.titles || !data.titles.length) return;

      // 获取当前视频页面的标题
      const headerBar = document.querySelector('.header-bar__wrap');
      const titleEl = headerBar?.querySelector('.text, [class*="title"]');
      const currentTitle = titleEl ? (titleEl.textContent || '').trim() : '';
      if (!currentTitle) return;

      // 匹配
      for (let i = 0; i < data.titles.length; i++) {
        if (data.titles[i].title === currentTitle) {
          const total = data.totalVideos;
          const pct = video && video.duration ? Math.round(video.currentTime / video.duration * 100) : 0;
          updateSharedStatus({
            currentIndex: i + 1,
            totalVideos: total,
            currentTitle,
            progress: pct,
            progressText: `第${i + 1}/${total}个视频，进度:${pct}%`,
          });
          return;
        }
      }
      // 模糊匹配
      for (let i = 0; i < data.titles.length; i++) {
        if (currentTitle.includes(data.titles[i].title) || data.titles[i].title.includes(currentTitle)) {
          const total = data.totalVideos;
          const pct = video && video.duration ? Math.round(video.currentTime / video.duration * 100) : 0;
          updateSharedStatus({
            currentIndex: i + 1,
            totalVideos: total,
            currentTitle: data.titles[i].title,
            progress: pct,
            progressText: `第${i + 1}/${total}个视频，进度:${pct}%`,
          });
          return;
        }
      }
    } catch (_) {}
  }

  // ========== 状态变量 ==========
  let video = null;
  let keepAliveTimer = null;
  let progressReportTimer = null;

  // ========== 引擎激活/停用 ==========
  function activateEngine() {
    window._yktEngineActive = true;
    localStorage.setItem('_ykt_engine_active', '1');
    updateSharedStatus({ active: true, status: 'playing' });
    panelLog('🔒 引擎已激活（倍速+静音+防暂停）');
  }

  function deactivateEngine() {
    window._yktEngineActive = false;
    localStorage.removeItem('_ykt_engine_active');
    updateSharedStatus({ active: false, status: 'idle' });
    panelLog('🔓 引擎已停用，恢复正常播放');
    if (video) {
      video._scriptAllowPause = true;
    }
  }

  // 页面加载时恢复引擎状态
  if (IS_VIDEO_PAGE && localStorage.getItem('_ykt_engine_active') === '1') {
    window._yktEngineActive = true;
    updateSharedStatus({ active: true, status: 'playing' });
  }

  // ========== 面板（仅视频页显示） ==========
  function createPanel() {
    if (!IS_VIDEO_PAGE) return;
    if (document.getElementById('ykt-panel')) return;
    const mount = document.body || document.documentElement;
    if (!mount) { setTimeout(createPanel, 500); return; }

    // 注入全局动效样式（仅一次）
    if (!document.getElementById('ykt-anim-style')) {
      const style = document.createElement('style');
      style.id = 'ykt-anim-style';
      style.textContent = `
        /* 面板初始滑入 */
        #ykt-panel {
          animation: yktSlideUp 0.35s cubic-bezier(0.22, 0.61, 0.36, 1);
        }
        @keyframes yktSlideUp {
          from { opacity: 0; transform: translateY(24px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        /* 按钮 hover/active 过渡 */
        #ykt-btn-toggle,
        #ykt-btn-copylog,
        #ykt-btn-report {
          transition: background 0.2s, color 0.2s, transform 0.15s, box-shadow 0.2s;
        }
        #ykt-btn-toggle:active,
        #ykt-btn-copylog:active,
        #ykt-btn-report:active {
          transform: scale(0.96);
        }
        #ykt-btn-report:hover {
          box-shadow: 0 2px 8px rgba(255,77,79,0.25);
        }
        #ykt-btn-toggle:hover {
          box-shadow: 0 2px 10px rgba(0,0,0,0.12);
        }
        /* 日志展开/收起 */
        #ykt-panel-log-wrap {
          transition: max-height 0.25s ease, opacity 0.2s;
        }
        /* 弹窗遮罩淡入 */
        #ykt-report-overlay {
          animation: yktFadeIn 0.2s ease;
        }
        @keyframes yktFadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        /* 弹窗内容滑入+弹跳 */
        #ykt-report-overlay > div {
          animation: yktPopIn 0.3s cubic-bezier(0.22, 0.61, 0.36, 1);
        }
        @keyframes yktPopIn {
          from { opacity: 0; transform: scale(0.9) translateY(12px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        /* 弹窗内 step 切换淡入 */
        #ykt-report-overlay .ykt-step-fade {
          animation: yktFadeIn 0.22s ease;
        }
        /* 弹窗按钮 */
        #ykt-rpt-yes, #ykt-rpt-no, #ykt-rpt-submit, #ykt-rpt-cancel,
        #ykt-rpt-done, #ykt-rpt-retry, #ykt-rpt-close {
          transition: background 0.2s, color 0.2s, transform 0.15s, box-shadow 0.2s;
        }
        #ykt-rpt-yes:active, #ykt-rpt-no:active, #ykt-rpt-submit:active,
        #ykt-rpt-cancel:active, #ykt-rpt-done:active, #ykt-rpt-retry:active,
        #ykt-rpt-close:active {
          transform: scale(0.96);
        }
        #ykt-rpt-yes:hover {
          box-shadow: 0 2px 8px rgba(255,77,79,0.3);
        }
        #ykt-rpt-submit:hover {
          box-shadow: 0 2px 8px rgba(22,119,255,0.3);
        }
        /* textarea 聚焦效果 */
        #ykt-rpt-desc {
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        #ykt-rpt-desc:focus {
          border-color: #1677ff;
          box-shadow: 0 0 0 2px rgba(22,119,255,0.15);
          outline: none;
        }
        /* 面板关闭按钮 */
        #ykt-panel-close {
          transition: color 0.2s, transform 0.15s;
        }
        #ykt-panel-close:hover {
          color: #ff4d4f;
        }
      `;
      document.head.appendChild(style);
    }

    const panel = document.createElement('div');
    panel.id = 'ykt-panel';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '20px', right: '20px', width: '340px',
      background: '#fff', borderRadius: '12px', boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
      zIndex: '999998', fontFamily: '"Segoe UI","PingFang SC",Arial,sans-serif',
      fontSize: '13px', color: '#333', overflow: 'hidden', display: 'flex', flexDirection: 'column',
    });

    const isActive = localStorage.getItem('_ykt_engine_active') === '1';
    const btnText = isActive ? '⏹ 停止刷课' : '🚀 开始刷课';
    const btnBg = isActive ? '#ff4d4f' : '#1677ff';

    panel.innerHTML = `
      <div id="ykt-panel-header" style="background:#1677ff; color:#fff; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; cursor:move; font-weight:bold; font-size:14px;">
        <span>🎓 雨课堂连播助手 v1.5</span>
        <span id="ykt-panel-close" style="cursor:pointer;">✕</span>
      </div>
      <div style="background:#f0f5ff; padding:8px 14px; border-bottom:1px solid #e8e8e8; font-size:12px;">
        状态：<span id="ykt-status-text" style="color:#1677ff;">${isActive ? '运行中' : '就绪'}</span>
      </div>
      <div style="padding:8px 14px; border-bottom:1px solid #e8e8e8;">
        <button id="ykt-btn-toggle" style="
          width:100%; padding:8px 0; border:none; border-radius:6px;
          background:${btnBg}; color:#fff; cursor:pointer; font-size:14px;
        ">${btnText}</button>
      </div>
      <div style="padding:6px 14px; display:flex; justify-content:space-between; align-items:center;">
        <span id="ykt-log-toggle" style="cursor:pointer; color:#1677ff; font-size:12px; user-select:none;">📋 展开日志 ▸</span>
        <button id="ykt-btn-copylog" style="padding:2px 10px; border:1px solid #d9d9d9; border-radius:4px; background:#fff; color:#666; cursor:pointer; font-size:10px;">📋 复制</button>
        <button id="ykt-btn-report" style="padding:2px 10px; border:1px solid #ffccc7; border-radius:4px; background:#fff1f0; color:#ff4d4f; cursor:pointer; font-size:10px;">BUG上报</button>
      </div>
      <div id="ykt-panel-log-wrap" style="display:none;">
        <div id="ykt-panel-log" style="padding:6px 10px; font-size:11px; font-family:'Consolas','Monaco',monospace; background:#fafafa; color:#555; max-height:260px; overflow-y:auto; line-height:1.6; word-break:break-all;"></div>
      </div>
      <div style="padding:4px 14px 8px; font-size:10px; color:#aaa; text-align:center;">
        提示：点击「开始」自动播放+连播；切换页面会自动继续
      </div>
    `;
    mount.appendChild(panel);

    // 事件
    document.getElementById('ykt-panel-close').addEventListener('click', () => { panel.style.display = 'none'; });
    document.getElementById('ykt-btn-toggle').addEventListener('click', function () {
      if (window._yktEngineActive) {
        panelLog('手动停止');
        deactivateEngine();
        stopAll();
        this.textContent = '🚀 开始刷课';
        this.style.background = '#1677ff';
        updatePanelStatus('已停止', '#ff4d4f');
      } else {
        panelLog('手动开始');
        activateEngine();
        this.textContent = '⏹ 停止刷课';
        this.style.background = '#ff4d4f';
        updatePanelStatus('运行中', '#52c41a');
        startSession();
      }
    });
    document.getElementById('ykt-btn-copylog').addEventListener('click', () => {
      const t = panelLogLines.join('\n');
      navigator.clipboard.writeText(t).then(() => panelLog('📋 已复制')).catch(() => {
        const ta = document.createElement('textarea'); ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px;'; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      });
    });
    document.getElementById('ykt-btn-report').addEventListener('click', () => {
      showBugReportDialog();
    });
    let logExp = false;
    document.getElementById('ykt-log-toggle').addEventListener('click', function () {
      logExp = !logExp;
      document.getElementById('ykt-panel-log-wrap').style.display = logExp ? 'block' : 'none';
      this.innerHTML = logExp ? '📋 收起日志 ▾' : '📋 展开日志 ▸';
    });

    // 拖拽
    let dragging = false, sx, sy, px, py;
    document.getElementById('ykt-panel-header').addEventListener('mousedown', (e) => {
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); px = r.left; py = r.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = px + 'px'; panel.style.top = py + 'px';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (px + e.clientX - sx) + 'px';
      panel.style.top = (py + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    panelLog('面板已就绪');
  }

  function updatePanelLog() {
    const d = document.getElementById('ykt-panel-log');
    if (d) { d.innerHTML = panelLogLines.map(l => `<div>${l}</div>`).join(''); d.scrollTop = d.scrollHeight; }
  }
  function updatePanelStatus(text, color = '#1677ff') {
    const el = document.getElementById('ykt-status-text');
    if (el) { el.textContent = text; el.style.color = color; }
  }

  function initPanel() {
    if (IS_VIDEO_PAGE && !IS_COURSE_LIST) {
      if (document.body) createPanel();
      else document.addEventListener('DOMContentLoaded', createPanel);
    }
  }
  if (document.body) initPanel();
  else document.addEventListener('DOMContentLoaded', initPanel);

  // ========== BUG 上报 ==========
  const FEISHU_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/1babe215-e574-40e9-9333-ba426c824b92';
  const SCRIPT_VERSION = '1.5';

  function collectDiagnosticsJSON() {
    const v = document.querySelector('video');
    const btnNext = document.querySelector('.btn-next');
    let vueInfo = { exists: false, depth: -1, keys: [], hasRouter: false, hasGetPreAndNextLeaf: false };
    let nextLeafDump = null;
    let preLeafDump = null;

    if (btnNext) {
      let el = btnNext;
      for (let i = 0; i < 8 && el; i++) {
        if (el.__vue__) {
          const vm = el.__vue__;
          vueInfo.exists = true;
          vueInfo.depth = i;
          vueInfo.keys = Object.keys(vm).filter(k => !k.startsWith('$') && !k.startsWith('_'));
          vueInfo.hasRouter = !!vm.$router;
          vueInfo.hasGetPreAndNextLeaf = typeof vm.getPreAndNextLeaf === 'function';

          if (vm.nextLeaf) {
            const nl = vm.nextLeaf;
            // 不采集 title（隐私原则：不收集视频标题）
            nextLeafDump = { id: nl.id, leaf_id: nl.leaf_id, leafId: nl.leafId, type: nl.type };
          }
          if (vm.preLeaf) {
            const pl = vm.preLeaf;
            preLeafDump = { id: pl.id, leaf_id: pl.leaf_id, leafId: pl.leafId, type: pl.type };
          }
          break;
        }
        el = el.parentElement;
      }
    }

    return {
      env: {
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        currentUrl: location.href,
        scriptVersion: SCRIPT_VERSION,
        engineActive: !!window._yktEngineActive,
        screen: { w: window.innerWidth || 0, h: window.innerHeight || 0, dpr: window.devicePixelRatio || 1 },
      },
      page: {
        pageType: detectPageType(),
        video: v ? {
          duration: v.duration, ended: v.ended, paused: v.paused,
          muted: v.muted, playbackRate: v.playbackRate, currentTime: v.currentTime,
          src: (v.src || '').replace(/\?.*$/, '?…'),  // 去查询参数，保护签名 token
          readyState: v.readyState,                     // 0=无数据 1=元数据 4=可播
          networkState: v.networkState,                 // 0=空 1=闲置 2=加载中 3=无源
          error: v.error ? { code: v.error.code, message: v.error.message } : null,
          seeking: v.seeking,
          buffered: v.buffered?.length || 0,            // 已缓冲的时间段数量
        } : null,
        spanText: (() => {
          const s = document.querySelectorAll('span.text');
          return Array.from(s).map(sp => (sp.textContent || '').trim()).filter(t => t);
        })(),
        finishExists: !!document.querySelector('.finish'),
        documentTitle: document.title,
        btnNextExists: !!btnNext,
        btnNextRect: btnNext ? (() => { const r = btnNext.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
        vueInstance: vueInfo,
        nextLeaf: nextLeafDump,
        preLeaf: preLeafDump,
        xtPlayer: {
          speedText: (document.querySelector('xt-speedvalue')?.textContent || '').trim() || null,
          bigBtnVisible: (() => {
            const bb = document.querySelector('xt-bigbutton');
            if (!bb) return null;
            return bb.offsetHeight > 0 && getComputedStyle(bb).display !== 'none';
          })(),
          loadingVisible: (() => {
            const ld = document.querySelector('xt-loading');
            if (!ld) return null;
            return getComputedStyle(ld).display !== 'none';
          })(),
          alertText: (document.querySelector('xt-alertbox')?.textContent || '').trim() || null,
        },
        cj: {
          parsed: parseVideoStudentUrl(),
          videoStudentLinks: Array.from(document.querySelectorAll('a[href*="video-student"]'))
            .map(a => {
              const m = (a.getAttribute('href') || '').match(/video-student\/(\d+)\/(\d+)/);
              return m ? { courseId: m[1], leafId: m[2] } : null;
            })
            .filter(Boolean)
            .slice(0, 20),
          videoCount: document.querySelectorAll('video').length,
        },
        customElements: (() => {
          // 页面所有自定义元素 tag 名（如 xt-*），帮助识别播放器组件结构
          const tags = new Set();
          document.querySelectorAll('*').forEach(el => {
            const tag = el.tagName.toLowerCase();
            if (tag.includes('-')) tags.add(tag);
          });
          return Array.from(tags).slice(0, 30);
        })(),
        playerInfo: (() => {
          // 播放器全局对象探测 + video 关键属性
          const globals = ['player', 'xtPlayer', 'videojs', 'xgplayer', 'hls', 'flv', 'dplayer', 'ckplayer']
            .filter(k => window[k] !== undefined)
            .map(k => ({ k, type: typeof window[k] }));
          const v = document.querySelector('video');
          return {
            globals,
            videoAttrs: v ? {
              preload: v.preload, autoplay: v.autoplay, controls: v.controls, loop: v.loop,
              currentSrc: (v.currentSrc || '').replace(/\?.*$/, '?…'),
            } : null,
          };
        })(),
        uiSummary: (() => {
          // 关键元素摘要：导航/状态按钮类采文本（短文本，非标题），容器类只采数量（隐私）
          const textSels = ['.btn-next', '[class*="next"]', '[class*="prev"]', '[class*="finish"]'];
          const countSels = ['[class*="chapter"]', '[class*="catalog"]', '[class*="outline"]', '[class*="menu"]', '[class*="sidebar"]', 'aside', '[class*="unit"]', '[class*="player"]', '.header-bar__wrap'];
          const out = [];
          textSels.forEach(sel => {
            const nodes = document.querySelectorAll(sel);
            if (!nodes.length) return;
            const f = nodes[0];
            out.push({
              sel, count: nodes.length, tag: f.tagName.toLowerCase(),
              cls: String(f.className || '').slice(0, 60),
              text: (f.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || null,
            });
          });
          countSels.forEach(sel => {
            const n = document.querySelectorAll(sel).length;
            if (n) out.push({ sel, count: n });
          });
          return out.slice(0, 25);
        })(),
        mediaEvents: mediaEventLog.slice(-20),
        videoErrors: videoErrorLog.slice(-3),
      },
      internal: {
        keepAliveRunning: keepAliveTimer !== null,
        progressRunning: progressReportTimer !== null,
        panelLogLines: panelLogLines.slice(-50),
        sessionFlags: (() => {
          try {
            return {
              autoContinue: sessionStorage.getItem('_ykt_auto_continue'),
              reloadCheck: sessionStorage.getItem('_ykt_reload_check'),
              fallbackLast: sessionStorage.getItem('_ykt_fallback_last'),
              fallbackCount: sessionStorage.getItem('_ykt_fallback_count'),
              healthReloads: sessionStorage.getItem('_ykt_health_reloads'),
            };
          } catch (_) { return null; }
        })(),
        engineFlags: {
          resumeGuard: !!window._yktResumeGuard,
          engineActive: !!window._yktEngineActive,
          persisted: localStorage.getItem('_ykt_engine_active'),
        },
        yktStatus: (() => {
          try {
            const r = localStorage.getItem('_ykt_status');
            if (!r) return null;
            const p = JSON.parse(r);
            // 脱敏：只保留 summary，不暴露完整数据
            if (p.total !== undefined) delete p.items;
            return { _ts: p._ts, active: p.active, status: p.status, progress: p.progress, total: p.total };
          } catch (_) { return null; }
        })(),
        yktScoreData: (() => {
          try {
            const r = localStorage.getItem('_ykt_score_data');
            if (!r) return null;
            const d = JSON.parse(r);
            return { time: d.time, total: d.total };
          } catch (_) { return null; }
        })(),
      },
      error: (() => {
        try {
          return window._yktLastError ? { message: window._yktLastError.message, stack: String(window._yktLastError.stack).slice(0, 2000) } : null;
        } catch (_) { return null; }
      })(),
      errorLog: window._yktErrorLog.slice(-3),
    };
  }

  function formatDiagnosticsText(d, userMessage) {
    const lines = [];
    const L = (label, val) => lines.push(`  ${label}: ${val ?? '(null)'}`);

    // 用户描述放在最前面，开发者一眼看到
    if (userMessage) {
      lines.push('💬 用户描述');
      lines.push('  ' + userMessage.replace(/\n/g, '\n  '));
      lines.push('');
    }

    lines.push('🐛 雨课堂脚本 BUG 上报');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('🔴 环境信息');
    L('时间', d.env.timestamp);
    L('脚本版本', d.env.scriptVersion);
    L('引擎状态', d.env.engineActive ? '激活' : '未激活');
    L('浏览器', d.env.userAgent);
    L('当前URL', d.env.currentUrl);
    if (d.env.screen) L('屏幕', `${d.env.screen.w}x${d.env.screen.h} dpr=${d.env.screen.dpr}`);
    lines.push('');
    lines.push('🟡 页面结构');
    L('页面类型', d.page.pageType);
    if (d.page.video) {
      L('video.duration', d.page.video.duration);
      L('video.currentTime', d.page.video.currentTime);
      L('video.ended', d.page.video.ended);
      L('video.paused', d.page.video.paused);
      L('video.muted', d.page.video.muted);
      L('video.playbackRate', d.page.video.playbackRate);
      L('video.readyState', d.page.video.readyState + ' (' + ['无数据','元数据','当前数据','未来数据','足够数据'][d.page.video.readyState||0] + ')');
      L('video.networkState', d.page.video.networkState + ' (' + ['空','闲置','加载中','无源'][d.page.video.networkState||0] + ')');
      L('video.seeking', d.page.video.seeking);
      L('video.buffered', (d.page.video.buffered || 0) + '段');
      L('video.error', d.page.video.error ? `code=${d.page.video.error.code} msg=${d.page.video.error.message}` : '(无)');
      L('video.src', d.page.video.src);
    } else {
      L('video', '(无)');
    }
    L('document.title', d.page.documentTitle);
    L('span.text', JSON.stringify(d.page.spanText));
    L('.finish', d.page.finishExists ? '存在' : '不存在');
    L('.btn-next', d.page.btnNextExists ? '存在' : '不存在');
    if (d.page.btnNextRect) {
      L('  btnNext.rect', `x=${d.page.btnNextRect.x} y=${d.page.btnNextRect.y} ${d.page.btnNextRect.w}x${d.page.btnNextRect.h}`);
    }
    L('Vue实例', d.page.vueInstance.exists ? `depth=${d.page.vueInstance.depth} keys=[${d.page.vueInstance.keys.join(',')}]` : '未找到');
    L('$router', d.page.vueInstance.hasRouter ? '有' : '无');
    L('getPreAndNextLeaf', d.page.vueInstance.hasGetPreAndNextLeaf ? '有' : '无');
    L('nextLeaf', d.page.nextLeaf ? JSON.stringify(d.page.nextLeaf) : '(无)');
    L('preLeaf', d.page.preLeaf ? JSON.stringify(d.page.preLeaf) : '(无)');
    lines.push('');
    lines.push('🎬 播放器状态');
    L('xt.speedText', d.page.xtPlayer?.speedText || '(无)');
    L('xt.bigBtnVisible', d.page.xtPlayer?.bigBtnVisible === null ? '(无xt-bigbutton)' : (d.page.xtPlayer?.bigBtnVisible ? '可见' : '隐藏'));
    L('xt.loadingVisible', d.page.xtPlayer?.loadingVisible === null ? '(无xt-loading)' : (d.page.xtPlayer?.loadingVisible ? '可见' : '隐藏'));
    L('xt.alertText', d.page.xtPlayer?.alertText || '(无)');
    if (d.page.cj) {
      L('cj.videoStudent', d.page.cj.parsed ? JSON.stringify(d.page.cj.parsed) : '(非长江视频页)');
      L('cj.links', d.page.cj.videoStudentLinks.length
        ? JSON.stringify(d.page.cj.videoStudentLinks.slice(0, 5)) : '(无 video-student 链接)');
      L('cj.videoCount', d.page.cj.videoCount + '个');
    }
    if (d.page.customElements?.length) {
      L('自定义元素', d.page.customElements.join(','));
    }
    if (d.page.playerInfo) {
      L('playerGlobals', d.page.playerInfo.globals?.length ? JSON.stringify(d.page.playerInfo.globals) : '(无)');
      if (d.page.playerInfo.videoAttrs) L('videoAttrs', JSON.stringify(d.page.playerInfo.videoAttrs));
    }
    if (d.page.uiSummary?.length) {
      lines.push('  uiSummary:');
      d.page.uiSummary.forEach(u => lines.push(
        `    ${u.sel} ×${u.count}${u.tag ? ` <${u.tag} class="${u.cls}">` : ''}${u.text ? ` text="${u.text}"` : ''}`));
    }
    if (d.page.mediaEvents?.length) {
      lines.push('  mediaEvents:');
      d.page.mediaEvents.forEach(m => lines.push(`    [${m.t}] ${m.type} ct=${m.ct}s rs=${m.rs}`));
    }
    if (d.page.videoErrors?.length) {
      lines.push('  videoErrors:');
      d.page.videoErrors.forEach(m => lines.push(`    [${m.t}] code=${m.code} ct=${m.ct}s`));
    }
    lines.push('');
    lines.push('🟢 脚本内部');
    L('keepAliveTimer', d.internal.keepAliveRunning ? '运行中' : '停');
    L('progressTimer', d.internal.progressRunning ? '运行中' : '停');
    if (d.internal.sessionFlags) L('sessionFlags', JSON.stringify(d.internal.sessionFlags));
    if (d.internal.engineFlags) L('engineFlags', JSON.stringify(d.internal.engineFlags));
    L('ykt_status', d.internal.yktStatus ? JSON.stringify(d.internal.yktStatus) : '(无)');
    L('ykt_score_data', d.internal.yktScoreData ? JSON.stringify(d.internal.yktScoreData) : '(无)');
    lines.push('');
    lines.push('🔴 错误信息');
    if (d.errorLog?.length) {
      d.errorLog.forEach((er, i) => {
        L(`[${i}] ${er.t || '?'}`, `${er.message || '(无)'}${er.stack ? ' | ' + String(er.stack).slice(0, 300) : ''}`);
      });
    } else if (d.error) {
      L('error.message', d.error.message);
      L('error.stack', d.error.stack);
    } else {
      L('error', '(无)');
    }
    lines.push('');
    lines.push('📋 最近日志');
    d.internal.panelLogLines.forEach(l => lines.push(`  ${l}`));
    lines.push('━━━━━━━━━━━━━━━━━━');
    return lines.join('\n');
  }

  function showBugReportDialog() {
    // 移除已存在的弹窗
    const old = document.getElementById('ykt-report-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ykt-report-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
      background: 'rgba(0,0,0,0.45)', zIndex: '9999999',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
      background: '#fff', borderRadius: '12px', boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
      width: '420px', maxWidth: '90vw', padding: '24px', fontFamily: '"PingFang SC","Segoe UI",Arial,sans-serif',
      fontSize: '14px', color: '#333',
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // ---------- Step 1: 询问是否有异常 ----------
    function showStep1() {
      box.innerHTML = `
        <div class="ykt-step-fade">
        <div style="font-size:17px; font-weight:bold; margin-bottom:6px;">🐛 BUG 上报</div>
        <div style="color:#666; margin-bottom:18px;">脚本运行时是否出现了异常？</div>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button id="ykt-rpt-no" style="padding:8px 20px; border:1px solid #d9d9d9; border-radius:6px; background:#fff; color:#666; cursor:pointer; font-size:14px;">否，没有异常</button>
          <button id="ykt-rpt-yes" style="padding:8px 20px; border:none; border-radius:6px; background:#ff4d4f; color:#fff; cursor:pointer; font-size:14px;">是，出现异常</button>
        </div>
        </div>
      `;
      box.querySelector('#ykt-rpt-no').addEventListener('click', () => {
        panelLog('🐛 用户取消上报：无异常');
        overlay.remove();
      });
      box.querySelector('#ykt-rpt-yes').addEventListener('click', showStep2);
    }

    // ---------- Step 2: 说明 + 输入框 + 确认上报 ----------
    function showStep2() {
      box.innerHTML = `
        <div class="ykt-step-fade">
        <div style="font-size:17px; font-weight:bold; margin-bottom:10px;">📤 确认上报</div>
        <div style="background:#fff7e6; border:1px solid #ffd591; border-radius:8px; padding:12px; margin-bottom:14px; font-size:12px; color:#8c6d00; line-height:1.7;">
          ⚠️ 点击确认后，可能会弹出油猴的<strong>「跨源资源请求」</strong>安全确认对话框。请你放心，这绝对安全。<br>
          这是脚本通过 Webhook 将页面元素诊断信息发送给开发者的必要步骤，<strong>请放心点击「总是允许此域名」</strong>，以后就不会再弹出了。<br>
          💡 无需在浏览器控制台执行任何命令——脚本已自动采集页面结构、播放器事件与运行日志。请直接描述你看到的现象即可（何时发生、什么操作、期望结果）。
        </div>
        <textarea id="ykt-rpt-desc" placeholder="如果你能更详细地描述遇到的问题，尤其是体验方面的问题，会更有利于开发者帮你解决。当然也可以留空。" style="
          width:100%; height:90px; border:1px solid #d9d9d9; border-radius:8px; padding:12px;
          font-size:13px; font-family:inherit; color:#333; resize:vertical; box-sizing:border-box;
        "></textarea>
        <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:14px;">
          <button id="ykt-rpt-cancel" style="padding:8px 20px; border:1px solid #d9d9d9; border-radius:6px; background:#fff; color:#666; cursor:pointer; font-size:14px;">取消</button>
          <button id="ykt-rpt-submit" style="padding:8px 24px; border:none; border-radius:6px; background:#1677ff; color:#fff; cursor:pointer; font-size:14px; font-weight:bold;">确认上报</button>
        </div>
        </div>
      `;
      box.querySelector('#ykt-rpt-cancel').addEventListener('click', () => {
        panelLog('🐛 用户取消上报');
        overlay.remove();
      });
      box.querySelector('#ykt-rpt-submit').addEventListener('click', () => {
        const desc = (box.querySelector('#ykt-rpt-desc').value || '').trim();
        // 替换弹窗为发送中状态
        box.innerHTML = `
          <div style="text-align:center; padding:20px;">
            <div style="font-size:28px; margin-bottom:12px;">⏳</div>
            <div style="font-size:15px; color:#666;">正在发送诊断信息...</div>
          </div>
        `;
        panelLog('🐛 正在上报...');
        sendBugReport(desc, (ok, msg) => {
          if (ok) {
            box.innerHTML = `
              <div style="text-align:center; padding:20px;">
                <div style="font-size:36px; margin-bottom:10px;">✅</div>
                <div style="font-size:16px; font-weight:bold; margin-bottom:6px;">上报成功</div>
                <div style="font-size:13px; color:#999; margin-bottom:16px;">开发者已收到你的诊断信息，感谢反馈！ (≧v≦) ♡</div>
                <button id="ykt-rpt-done" style="padding:8px 30px; border:none; border-radius:6px; background:#1677ff; color:#fff; cursor:pointer; font-size:14px;">完成</button>
              </div>
            `;
            box.querySelector('#ykt-rpt-done').addEventListener('click', () => overlay.remove());
            panelLog('✅ 上报成功');
          } else {
            box.innerHTML = `
              <div style="text-align:center; padding:20px;">
                <div style="font-size:36px; margin-bottom:10px;">❌</div>
                <div style="font-size:16px; font-weight:bold; margin-bottom:6px;">上报失败</div>
                <div style="font-size:13px; color:#999; margin-bottom:16px;">${msg}</div>
                <button id="ykt-rpt-retry" style="padding:8px 16px; border:1px solid #d9d9d9; border-radius:6px; background:#fff; color:#666; cursor:pointer; font-size:14px; margin-right:8px;">重试</button>
                <button id="ykt-rpt-close" style="padding:8px 16px; border:none; border-radius:6px; background:#1677ff; color:#fff; cursor:pointer; font-size:14px;">关闭</button>
              </div>
            `;
            box.querySelector('#ykt-rpt-retry').addEventListener('click', () => {
              // 回到 step2，保留之前的描述
              showStep2();
              const ta = box.querySelector('#ykt-rpt-desc');
              if (ta) ta.value = desc;
            });
            box.querySelector('#ykt-rpt-close').addEventListener('click', () => overlay.remove());
            panelLog('❌ 上报失败: ' + msg);
          }
        });
      });
    }

    showStep1();

    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }

  function sendBugReport(userMessage, callback) {
    if (!FEISHU_WEBHOOK_URL || FEISHU_WEBHOOK_URL.includes('REPLACE_WITH_YOUR_KEY')) {
      panelLog('⚠ Webhook URL 未配置');
      if (callback) callback(false, 'Webhook URL 未配置');
      return;
    }
    let diag;
    try {
      diag = collectDiagnosticsJSON();
    } catch (e) {
      panelLog('❌ 采集诊断失败: ' + e.message);
      if (callback) callback(false, '采集失败: ' + e.message);
      return;
    }
    const text = formatDiagnosticsText(diag, userMessage);
    GM_xmlhttpRequest({
      method: 'POST',
      url: FEISHU_WEBHOOK_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ msg_type: 'text', content: { text: text } }),
      onload: function (r) {
        try {
          const resp = JSON.parse(r.responseText);
          if (r.status === 200 && resp.code === 0) {
            if (callback) callback(true, 'ok');
          } else {
            if (callback) callback(false, 'HTTP ' + r.status + ' / code=' + (resp.code ?? '?'));
          }
        } catch (_) {
          if (callback) callback(r.status === 200, 'HTTP ' + r.status);
        }
      },
      onerror: function (e) {
        if (callback) callback(false, '网络错误: ' + (e.error || 'unknown'));
      },
      ontimeout: function () {
        if (callback) callback(false, '请求超时');
      },
      timeout: 15000,
    });
  }

  function findVideo() {
    return new Promise((resolve) => {
      let n = 0;
      const t = setInterval(() => {
        n++;
        const v = document.querySelector('video');
        if (v && v.duration > 0) { clearInterval(t); video = v; resolve(true); }
        else if (v && !v.duration) { /* waiting for metadata */ }
        // 3 秒内无 video 元素 → 快速失败（可能是非视频页面）
        else if (!v && n >= 3) { clearInterval(t); panelLog('  findVideo: 3s 无 video 元素，快速失败'); resolve(false); }
        else if (n >= 30) { clearInterval(t); panelLog('  findVideo: 30s 超时（有 video 无 metadata）'); resolve(false); }
      }, 1000);
    });
  }

  function startPlayback() {
    if (!video) return;
    video._scriptAllowPause = false;
    video.muted = true;
    if (video.paused) video.play().catch(() => {});
  }

  function preventPause() {
    keepAliveTimer = setInterval(() => {
      if (!window._yktEngineActive) return;
      if (video && video.paused && !video.ended) video.play().catch(() => {});
    }, 1000);

    video.addEventListener('ended', () => {
      video._shouldStop = true;
      video._scriptAllowPause = true;
      panelLog('✅ 视频播放完毕');
      updatePanelStatus('已完成，跳转中...', '#faad14');
    });
  }

  function monitorProgress() {
    progressReportTimer = setInterval(() => {
      if (!window._yktEngineActive || video._shouldStop) return;
      if (video && video.duration) {
        const pct = Math.round(video.currentTime / video.duration * 100);
        updateSharedStatus({ progress: pct, status: 'playing' });
        matchCurrentVideo();
      }
    }, 3000);
  }

  function stopAll() {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    if (progressReportTimer) { clearInterval(progressReportTimer); progressReportTimer = null; }
    if (video) {
      video._shouldStop = true;
      video._scriptAllowPause = true;
    }
  }

  // ========== 播放健康守护（v1.4，长江适配） ==========
  // 长江视频为分段 mp4（如 ...-10.mp4），播放器切段时可能重建/替换 <video> 元素，
  // 导致脚本全局 video 引用失效 → 黑屏/停滞。此守护每秒：
  //   1. 检测新 video 元素并重新绑定（muted + play）
  //   2. 检测播放停滞（有数据但不推进）→ 尝试恢复 → 卡死则刷新
  function watchPlaybackHealth() {
    let lastTime = -1;
    let stallCount = 0;
    const t = setInterval(() => {
      if (!window._yktEngineActive || !video || video._shouldStop) { clearInterval(t); return; }
      // 1. 播放器可能切换/重建 video 元素（分段视频）→ 重新绑定
      const v = document.querySelector('video');
      if (v && v !== video) {
        panelLog('↻ 检测到新的 video 元素，重新绑定');
        video = v;
        video._scriptAllowPause = false;
        video.muted = true;
        if (video.paused) video.play().catch(() => {});
        lastTime = -1; stallCount = 0;
        return;
      }
      if (video.ended) { clearInterval(t); return; }
      // 2. 停滞检测：有数据但不推进
      const cur = video.currentTime;
      if (cur === lastTime && video.readyState >= 3) {
        stallCount++;
        if (stallCount === 5) {
          panelLog('⚠ 播放停滞，尝试恢复播放...');
          if (video.paused) video.play().catch(() => {});
          // 尝试点击播放器大按钮（xt-bigbutton 为 WebComponent，可能响应 click）
          const bb = document.querySelector('xt-bigbutton');
          if (bb) { try { bb.click(); } catch (_) {} }
        }
        if (stallCount >= 15) {
          if (parseVideoStudentUrl() && navigator.onLine !== false) {
            // 长江：尝试刷新恢复；限制连续刷新次数（3 次），防止持续故障时无限自刷
            try {
              const n = parseInt(sessionStorage.getItem('_ykt_health_reloads') || '0', 10) + 1;
              if (n >= 3) {
                sessionStorage.removeItem('_ykt_health_reloads');
                panelLog('❌ 多次刷新仍无法播放，请检查网络后手动重试');
                clearInterval(t);
                return;
              }
              sessionStorage.setItem('_ykt_health_reloads', String(n));
            } catch (_) {}
            panelLog('❌ 播放卡死，刷新页面重试');
            try { sessionStorage.setItem('_ykt_reload_check', '1'); } catch (_) {}
            location.reload();
            clearInterval(t);
            return;
          }
          // 华工：保持原行为，不自动刷新（原兜底为 waitForVideoEnd 超时后统一处理）
          panelLog('⚠ 播放长时间停滞，停止健康守护（等待播放器自行恢复）');
          clearInterval(t);
          return;
        }
      } else if (cur !== lastTime) {
        stallCount = 0;
      }
      lastTime = cur;
    }, 1000);
  }

  // ========== 防续播守护（v1.4，长江适配） ==========
  // 重播场景（进度未确认 → 刷新重试）：长江播放器会自动续播到服务端记录的位置
  // （如 89%），导致断区永远无法覆盖。前 15 秒监测播放位置异常跳跃并重置到开头。
  function guardAgainstResumeJump() {
    let resets = 0;
    let lastT = video ? video.currentTime : 0;
    let lastCheck = Date.now();
    const t = setInterval(() => {
      if (!window._yktEngineActive || !video || video.ended) { clearInterval(t); return; }
      const now = Date.now();
      const dt = (now - lastCheck) / 1000;
      const jump = video.currentTime - lastT;
      // 正常 2x 播放每秒约 +2s；播放器续播 seek 是一次性大跳跃（几十秒以上）
      if (video.currentTime > 5 && jump > dt * 5 + 10) {
        if (resets < 2) {
          panelLog(`↺ 播放位置异常跳跃(+${Math.round(jump)}s)，重置到开头`);
          video.currentTime = 0;
          resets++;
        } else {
          // 重置多次仍跳跃（可能是分段切集等正常行为），放弃干预避免死循环
          panelLog('⚠ 连续跳跃重置无效，停止防续播干预');
          clearInterval(t);
          return;
        }
      }
      lastT = video.currentTime;
      lastCheck = now;
    }, 1000);
    setTimeout(() => clearInterval(t), 15000);
  }

  // ========== 状态检测 ==========
  function getVideoStatus() {
    const spans = document.querySelectorAll('span.text');
    for (const sp of spans) {
      const t = (sp.textContent || '').trim();
      if (t === '已完成') return { completed: true, text: t };
      // 支持三种百分比格式："50%" / "完成度：0%" / "完成度: 50%"
      const m = t.match(/(\d{1,3})%/);
      if (m) return { completed: false, text: t, percent: parseInt(m[1]) };
    }
    const fe = document.querySelector('.finish');
    if (fe) {
      const sib = fe.parentElement?.querySelector('span.text');
      if (sib) { const tx = (sib.textContent || '').trim(); return { completed: tx === '已完成', text: tx }; }
      return { completed: true, text: '(finish)' };
    }
    return { completed: false, text: '(unknown)', percent: 0 };
  }

  function waitForCompleted(maxSec = 5) {
    return new Promise((resolve) => {
      const start = Date.now();
      let lastPercent = null;
      const t = setInterval(() => {
        const st = getVideoStatus();
        const progressStr = st.percent !== undefined ? `(${st.percent}%)` : '';
        panelLog(`  状态: "${st.text}" ${progressStr} ${st.completed ? '✅' : '⏳'}`);

        // 已完成 → 立即返回
        if (st.completed) { clearInterval(t); resolve(true); return; }

        // 进度在涨 → 延长等待（最多 30s），不超时
        if (st.percent !== undefined && lastPercent !== null && st.percent > lastPercent) {
          panelLog(`  进度 ${lastPercent}% → ${st.percent}%，继续等待`);
        }
        lastPercent = st.percent ?? lastPercent;

        if (Date.now() - start > maxSec * 1000) {
          clearInterval(t);
          // 进度在涨 → 给额外 25s（总共 30s）
          if (st.percent !== undefined && st.percent > 0) {
            panelLog('  ⏳ 进度非零，额外等待 25s...');
            const bonus = setInterval(() => {
              const st2 = getVideoStatus();
              panelLog(`    状态: "${st2.text}" (${st2.percent ?? '?'}%)`);
              if (st2.completed) { clearInterval(bonus); resolve(true); return; }
              if (Date.now() - start > 30000) { clearInterval(bonus); panelLog('  ⚠ 最终超时'); resolve(false); }
            }, 3000);
            return;
          }
          panelLog('  ⚠ 等待超时（进度未增长）');
          resolve(false);
        }
      }, 2000);
    });
  }

  function waitForVideoEnd() {
    return new Promise((resolve) => {
      const c = setInterval(() => {
        const v = document.querySelector('video');
        if (!v) { clearInterval(c); resolve('gone'); return; }
        if (v.ended) { clearInterval(c); resolve('ended'); return; }
      }, 2000);
      const v = document.querySelector('video');
      const timeout = v?.duration ? (v.duration / 2) * 1000 + 60000 : 600000;
      setTimeout(() => { clearInterval(c); resolve('timeout'); }, timeout);
    });
  }

  // ========== 导航 ==========
  function detectPageType() {
    const p = location.pathname;
    if (p.includes('/pro/courselist') || p.includes('/v2/web/xcloud/courselist')) return 'course_list';
    // 华工: /pro/lms/.../video/...；长江: /v2/web/xcloud/video-student/...
    if (p.includes('/video/') || p.includes('/video-student/')) return 'video';
    if (p.endsWith('/score')) return 'score';
    if (p.endsWith('/studycontent')) return 'study';
    if (p.endsWith('/forum') || p.endsWith('/announcement')) return 'other';
    return 'unknown';
  }

  /** 解析长江雨课堂视频页 URL：/v2/web/xcloud/video-student/{courseId}/{leafId} */
  function parseVideoStudentUrl() {
    const m = location.pathname.match(/^\/v2\/web\/xcloud\/video-student\/(\d+)\/(\d+)$/);
    if (!m) return null;
    return { courseId: m[1], leafId: m[2] };
  }

  /** 构造下一个视频的跳转 URL：长江 /v2/web/xcloud/video-student/...，华工 /pro/lms/.../video/... */
  function buildNextVideoUrl(nid) {
    // 长江雨课堂：/v2/web/xcloud/video-student/{courseId}/{leafId} → 仅替换 leafId
    const cj = parseVideoStudentUrl();
    if (cj) return `https://changjiang.yuketang.cn/v2/web/xcloud/video-student/${cj.courseId}/${nid}`;
    // 华工雨课堂（原逻辑保持不变）：/pro/lms/{sig}/{cid}/video/{leafId}；用当前 hostname 避免跨站
    const sig = location.pathname.split('/')[3];
    const cid = location.pathname.split('/')[4];
    return `https://${location.hostname}/pro/lms/${sig}/${cid}/video/${nid}`;
  }

  async function clickNextUnit() {
    const btn = document.querySelector('.btn-next');
    if (btn) {
      let el = btn;
      for (let i = 0; i < 8 && el; i++) {
        if (el.__vue__) {
          const vm = el.__vue__;
          if (vm.nextLeaf) {
            const nl = vm.nextLeaf;
            const nid = nl.id || nl.leaf_id || nl.leafId;
            if (nid) {
              // 用 sessionStorage 标记自动连播（跨页面重载）
              try { sessionStorage.setItem('_ykt_auto_continue', '1'); } catch (_) {}
              location.href = buildNextVideoUrl(nid);
              return true;
            }
          }
          if (typeof vm.getPreAndNextLeaf === 'function') {
            vm.getPreAndNextLeaf();
            await new Promise(r => setTimeout(r, 500));
            const nl = vm.nextLeaf;
            if (nl) {
              const nid = nl.id || nl.leaf_id || nl.leafId;
              if (nid) {
                try { sessionStorage.setItem('_ykt_auto_continue', '1'); } catch (_) {}
                location.href = buildNextVideoUrl(nid);
                return true;
              }
            }
          }
          break;
        }
        el = el.parentElement;
      }
    }

    // 长江雨课堂 fallback：无 .btn-next / 无 Vue nextLeaf 时，leafId + 1 直接跳转（用户实测有效）
    const cj = parseVideoStudentUrl();
    if (cj) {
      const nid = String(parseInt(cj.leafId, 10) + 1);
      try { sessionStorage.setItem('_ykt_auto_continue', '1'); } catch (_) {}
      location.href = buildNextVideoUrl(nid);
      return true;
    }
    return false;
  }

  // ========== 主会话 ==========
  async function runVideoPage() {
    const status = getVideoStatus();
    panelLog(`状态: "${status.text}"`);

    if (status.completed) {
      panelLog('⏭ 已完成，跳下一视频');
    } else {
      const found = await findVideo();
      if (!found) {
        panelLog('⚠ 无视频，尝试跳过...');
        // 长江连续无视频保护：连续 3 次 fallback 仍无视频则停止（防 404/空号死循环）
        try {
          const cj = parseVideoStudentUrl();
          if (cj) {
            const curLeaf = parseInt(cj.leafId, 10);
            const last = parseInt(sessionStorage.getItem('_ykt_fallback_last') || '', 10);
            const count = parseInt(sessionStorage.getItem('_ykt_fallback_count') || '0', 10);
            if (last + 1 === curLeaf) {
              if (count >= 2) {
                sessionStorage.removeItem('_ykt_fallback_last');
                sessionStorage.removeItem('_ykt_fallback_count');
                panelLog('⚠ 连续多次未找到视频，停止自动跳转');
                return 'done';
              }
              sessionStorage.setItem('_ykt_fallback_last', cj.leafId);
              sessionStorage.setItem('_ykt_fallback_count', String(count + 1));
            } else {
              sessionStorage.setItem('_ykt_fallback_last', cj.leafId);
              sessionStorage.setItem('_ykt_fallback_count', '0');
            }
          }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 1000));
        const jumped = await clickNextUnit();
        return jumped ? 'continue' : 'done';
      }
      video._shouldStop = false;
      startPlayback();

      // ── 杂交页面早期检测（播放后） ──
      // 杂交页面：bigBtn 在 video.play() 后仍然可见，且进度永不更新
      const isBigVisible = () => {
        const bb = document.querySelector('xt-bigbutton');
        return bb && bb.offsetHeight > 0 && getComputedStyle(bb).display !== 'none';
      };

      if (isBigVisible()) {
        panelLog('⚠ bigBtn 在播放后仍可见，检测是否为杂交页面...');
        let hybrid = true;
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 1000));
          // 真实视频：bigBtn 会在 1-2 秒内隐藏
          if (!isBigVisible()) {
            panelLog('  bigBtn 已隐藏，确认为真实视频');
            hybrid = false;
            break;
          }
        }
        if (hybrid && isBigVisible()) {
          panelLog('⏭ 确认为杂交页面，跳过');
          stopAll();
          video._shouldStop = true;
          await new Promise(r => setTimeout(r, 500));
          const jumped = await clickNextUnit();
          return jumped ? 'continue' : 'done';
        }
      }

      preventPause();
      monitorProgress();
      watchPlaybackHealth();
      if (window._yktResumeGuard && parseVideoStudentUrl()) guardAgainstResumeJump();
      await waitForVideoEnd();
      try { sessionStorage.removeItem('_ykt_health_reloads'); } catch (_) {}
      stopAll();
      panelLog('  等待确认"已完成"...');
      const ok = await waitForCompleted(5);
      if (!ok) {
        // 主动刷新策略：设标记后 reload 当前页，刷新后检测
        panelLog('  ⚠ 5s 未确认，刷新页面重试...');
        try { sessionStorage.setItem('_ykt_reload_check', '1'); } catch (_) {}
        location.reload();
        return 'reload';
      }
      panelLog('  ✅ 确认为已完成');
    }

    // ── 跳转前二次确认 ──
    await new Promise(r => setTimeout(r, 2000));
    const st2 = getVideoStatus();
    if (!st2.completed) {
      panelLog(`  ⚠ 二次确认失败: "${st2.text}"，重新检查...`);
      // 回到状态检测起点
      const st3 = getVideoStatus();
      if (st3.completed) {
        panelLog('  三次确认已完成，继续跳转');
      } else {
        panelLog(`  ❌ 确认非已完成，重新播放`);
        location.reload();
        return 'reload';
      }
    }

    const jumped = await clickNextUnit();
    if (!jumped) {
      panelLog('🎉 全部完成！');
      updatePanelStatus('全部完成 🎉', '#1677ff');
      deactivateEngine();
      const btn = document.getElementById('ykt-btn-toggle');
      if (btn) { btn.textContent = '🚀 开始刷课'; btn.style.background = '#1677ff'; }
      return 'done';
    }
    return 'continue';
  }

  async function startSession() {
    const pt = detectPageType();
    panelLog(`开始会话: ${pt}`);
    updatePanelStatus('运行中', '#52c41a');

    if (pt !== 'video') {
      panelLog('请进入视频播放页');
      return;
    }

    await runVideoPage();
  }

  // ========== 路由监听 ==========
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const nt = detectPageType();
      panelLog(`页面切换: ${nt}`);

      // 成绩单页面：抓取视频列表
      if (nt === 'score') {
        setTimeout(scrapeScorePage, 2000);
      }

      // 自动连播跳转（仅 SPA 跳转时，user 手动点击导航）
      if (nt === 'video') {
        updatePanelStatus(window._yktEngineActive ? '运行中' : '视频页', window._yktEngineActive ? '#52c41a' : '#1677ff');
        if (!document.getElementById('ykt-panel') || document.getElementById('ykt-panel').style.display === 'none') {
          initPanel();
        }
      }
    }
  }).observe(document, { subtree: true, childList: true });

  // 初始化：成绩单页面自动抓取
  if (IS_SCORE_PAGE) {
    setTimeout(scrapeScorePage, 2000);
  }

  // 视频页：如果引擎已激活，自动恢复
  if (IS_VIDEO_PAGE && window._yktEngineActive) {
    panelLog('🔄 引擎已激活，自动恢复刷课...');
    const btn = document.getElementById('ykt-btn-toggle');
    if (btn) { btn.textContent = '⏹ 停止刷课'; btn.style.background = '#ff4d4f'; }
    updatePanelStatus('运行中', '#52c41a');
    setTimeout(() => startSession(), 1500);
  }

  // 自动连播：跨页面重载后恢复（clickNextUnit 用 location.href 跳转）
  (() => {
    try {
      if (sessionStorage.getItem('_ykt_auto_continue') === '1') {
        sessionStorage.removeItem('_ykt_auto_continue');
        if (IS_VIDEO_PAGE && window._yktEngineActive) {
          panelLog('🔄 自动连播中...');
          updatePanelStatus('自动连播', '#52c41a');
          setTimeout(() => startSession(), 1500);
        }
      }
    } catch (_) {}
  })();

  // 刷新检测：waitForCompleted 超时后主动刷新，检查是否已完成
  // 不重复调用 startSession() — 由上方引擎自动恢复统一触发
  (() => {
    try {
      if (sessionStorage.getItem('_ykt_reload_check') === '1') {
        sessionStorage.removeItem('_ykt_reload_check');
        if (IS_VIDEO_PAGE && window._yktEngineActive) {
          // 重播场景：启用防续播守护（长江播放器会自动续播到上次位置，导致断区无法覆盖）
          window._yktResumeGuard = true;
          const st = getVideoStatus();
          panelLog(st.completed
            ? '🔄 刷新后确认为已完成，继续跳转'
            : `🔄 刷新后仍为 "${st.text}"，正常重播（防续播已启用）`);
        }
      }
    } catch (_) {}
  })();

  window._yuketangAbort = () => {
    deactivateEngine();
    stopAll();
    panelLog('⏹ 已停止');
    updatePanelStatus('已停止', '#ff4d4f');
    const btn = document.getElementById('ykt-btn-toggle');
    if (btn) { btn.textContent = '🚀 开始刷课'; btn.style.background = '#1677ff'; }
  };

  // 全局错误捕获（供 BUG 上报使用，环形 3 条带时间戳）
  window.addEventListener('error', (e) => {
    const entry = { t: ts(), message: e.message || String(e), stack: e.error?.stack || '' };
    window._yktErrorLog.push(entry);
    if (window._yktErrorLog.length > 3) window._yktErrorLog.shift();
    window._yktLastError = entry;
  });
  window.addEventListener('unhandledrejection', (e) => {
    const entry = { t: ts(), message: e.reason?.message || String(e.reason), stack: e.reason?.stack || '' };
    window._yktErrorLog.push(entry);
    if (window._yktErrorLog.length > 3) window._yktErrorLog.shift();
    window._yktLastError = entry;
  });

  log('就绪', 'INFO', '面板+引擎+状态共享全部就绪');
})();
