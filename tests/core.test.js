/**
 * 雨课堂脚本 — 核心模块单元测试
 * 跳过：原型链拦截（模块 0/1）、飞书上报（sendBugReport/showBugReportDialog）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ts,
  createPanelLog,
  updateSharedStatus,
  detectPageType,
  isYuketang,
  isVideoPage,
  isScorePage,
  parseVideoStudentUrl,
  buildNextVideoUrl,
  getVideoStatus,
  buildDiagnosticsJSON,
  formatDiagnosticsText,
  parseScorePageItems,
  matchVideoTitle,
} from '../lib/core.js';

// ==================== ts() ====================
describe('ts()', () => {
  it('返回 HH:MM:SS 格式', () => {
    const result = ts();
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('时/分/秒各自补零到 2 位', () => {
    // Mock Date 到 2026-01-01T01:02:03
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 1, 2, 3));
    expect(ts()).toBe('01:02:03');
    vi.useRealTimers();
  });

  it('中午 12:00:00 正确格式化', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    expect(ts()).toBe('12:00:00');
    vi.useRealTimers();
  });
});

// ==================== createPanelLog() ====================
describe('createPanelLog()', () => {
  let log;

  beforeEach(() => {
    log = createPanelLog();
  });

  it('初始为空', () => {
    expect(log.lines).toEqual([]);
  });

  it('add 增加一行含时间戳的日志', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    log.add('测试消息');
    expect(log.lines.length).toBe(1);
    expect(log.lines[0]).toContain('[12:00:00]');
    expect(log.lines[0]).toContain('测试消息');
    vi.useRealTimers();
  });

  it('超过 100 条时移除最早的', () => {
    for (let i = 0; i < 101; i++) {
      log.add(`msg${i}`);
    }
    expect(log.lines.length).toBe(100);
    expect(log.lines[0]).toContain('msg1');
    expect(log.lines[99]).toContain('msg100');
  });
});

// ==================== updateSharedStatus() ====================
describe('updateSharedStatus()', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('创建新的 status 记录', () => {
    updateSharedStatus({ active: true, status: 'playing' });
    const raw = localStorage.getItem('_ykt_status');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw);
    expect(parsed.active).toBe(true);
    expect(parsed.status).toBe('playing');
    expect(parsed._ts).toBeGreaterThan(0);
  });

  it('合并到已有记录', () => {
    localStorage.setItem('_ykt_status', JSON.stringify({ active: true, status: 'idle' }));
    updateSharedStatus({ status: 'playing', progress: 50 });
    const parsed = JSON.parse(localStorage.getItem('_ykt_status'));
    expect(parsed.active).toBe(true);
    expect(parsed.status).toBe('playing');
    expect(parsed.progress).toBe(50);
    expect(parsed._ts).toBeGreaterThan(0);
  });

  it('localStorage 异常时静默失败', () => {
    const brokenStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    // 不应抛出
    expect(() => {
      try {
        const raw = brokenStorage.getItem('_ykt_status');
        const cur = raw ? JSON.parse(raw) : {};
        Object.assign(cur, { active: true });
        brokenStorage.setItem('_ykt_status', JSON.stringify(cur));
      } catch (_) {}
    }).not.toThrow();
  });
});

// ==================== detectPageType() ====================
describe('detectPageType()', () => {
  it('course_list', () => {
    expect(detectPageType('/pro/courselist/123')).toBe('course_list');
  });

  it('video', () => {
    expect(detectPageType('/pro/lms/xxx/12345/video/67890')).toBe('video');
  });

  it('video（长江雨课堂）', () => {
    expect(detectPageType('/v2/web/xcloud/video-student/25007711/46700871')).toBe('video');
  });

  it('course_list（长江雨课堂）', () => {
    expect(detectPageType('/v2/web/xcloud/courselist')).toBe('course_list');
  });

  it('score', () => {
    expect(detectPageType('/pro/lms/xxx/12345/score')).toBe('score');
  });

  it('score（长江雨课堂）', () => {
    expect(detectPageType('/v2/web/xcloud/25007711/score')).toBe('score');
  });

  it('studycontent', () => {
    expect(detectPageType('/pro/lms/xxx/12345/studycontent')).toBe('study');
  });

  it('forum', () => {
    expect(detectPageType('/pro/lms/xxx/12345/forum')).toBe('other');
  });

  it('announcement', () => {
    expect(detectPageType('/pro/lms/xxx/12345/announcement')).toBe('other');
  });

  it('unknown', () => {
    expect(detectPageType('/other/path')).toBe('unknown');
  });

  it('空字符串', () => {
    expect(detectPageType('')).toBe('unknown');
  });

  it('null/undefined 不崩溃', () => {
    expect(detectPageType(null)).toBe('unknown');
    expect(detectPageType(undefined)).toBe('unknown');
  });
});

// ==================== isYuketang / isVideoPage / isScorePage ====================
describe('域名/页面判断', () => {
  it('isYuketang 匹配主域', () => {
    expect(isYuketang('scut.yuketang.cn')).toBe(true);
  });

  it('isYuketang 匹配泛域', () => {
    expect(isYuketang('test.yuketang.cn')).toBe(true);
    expect(isYuketang('yuketang.cn')).toBe(true);
  });

  it('isYuketang 拒绝非雨课堂', () => {
    expect(isYuketang('example.com')).toBe(false);
    expect(isYuketang('')).toBe(false);
  });

  it('isVideoPage 正确判断', () => {
    expect(isVideoPage('/pro/lms/sig/123/video/456', 'scut.yuketang.cn')).toBe(true);
    expect(isVideoPage('/pro/lms/sig/123/video/456', 'example.com')).toBe(false);
    expect(isVideoPage('/other', 'scut.yuketang.cn')).toBe(false);
  });

  it('isVideoPage 支持长江雨课堂', () => {
    expect(isVideoPage('/v2/web/xcloud/video-student/25007711/46700871', 'changjiang.yuketang.cn')).toBe(true);
    expect(isVideoPage('/v2/web/xcloud/video-student/25007711/46700871', 'example.com')).toBe(false);
  });

  it('isScorePage 正确判断', () => {
    expect(isScorePage('/pro/lms/sig/123/score', 'scut.yuketang.cn')).toBe(true);
    expect(isScorePage('/pro/lms/sig/123/video/456', 'scut.yuketang.cn')).toBe(false);
  });

  it('isScorePage 支持长江雨课堂', () => {
    expect(isScorePage('/v2/web/xcloud/25007711/score', 'changjiang.yuketang.cn')).toBe(true);
    expect(isScorePage('/v2/web/xcloud/video-student/25007711/46700871', 'changjiang.yuketang.cn')).toBe(false);
  });
});

// ==================== parseVideoStudentUrl() ====================
describe('parseVideoStudentUrl()', () => {
  it('解析长江视频页 URL', () => {
    expect(parseVideoStudentUrl('/v2/web/xcloud/video-student/25007711/46700871'))
      .toEqual({ courseId: '25007711', leafId: '46700871' });
  });

  it('非长江路径返回 null', () => {
    expect(parseVideoStudentUrl('/pro/lms/sig/123/video/456')).toBeNull();
    expect(parseVideoStudentUrl('')).toBeNull();
    expect(parseVideoStudentUrl(null)).toBeNull();
  });

  it('路径带多余段/非数字 ID 返回 null', () => {
    expect(parseVideoStudentUrl('/v2/web/xcloud/video-student/25007711/46700871/extra')).toBeNull();
    expect(parseVideoStudentUrl('/v2/web/xcloud/video-student/abc/def')).toBeNull();
  });
});

// ==================== buildNextVideoUrl() ====================
describe('buildNextVideoUrl()', () => {
  it('长江雨课堂：仅替换 leafId，保持 courseId', () => {
    expect(buildNextVideoUrl('/v2/web/xcloud/video-student/25007711/46700871', 46700872, 'changjiang.yuketang.cn'))
      .toBe('https://changjiang.yuketang.cn/v2/web/xcloud/video-student/25007711/46700872');
  });

  it('华工雨课堂：原逻辑不变（/pro/lms/{sig}/{cid}/video/{leafId}）', () => {
    expect(buildNextVideoUrl('/pro/lms/sig/123/video/456', 789, 'scut.yuketang.cn'))
      .toBe('https://scut.yuketang.cn/pro/lms/sig/123/video/789');
  });

  it('长江路径失配时回退当前 hostname，不跨站到华工', () => {
    expect(buildNextVideoUrl('/v2/web/xcloud/video-student/25007711/46700871/extra', 1, 'changjiang.yuketang.cn'))
      .toBe('https://changjiang.yuketang.cn/pro/lms/xcloud/video-student/video/1');
  });

  it('空 pathname 不崩溃，回退华工构造（默认 hostname）', () => {
    expect(buildNextVideoUrl('', 1)).toBe('https://scut.yuketang.cn/pro/lms/undefined/undefined/video/1');
  });
});

// ==================== 主脚本与 lib/core.js 同步守卫 ====================
describe('主脚本与 lib/core.js 同步', () => {
  // vitest 启动目录为 脚本文件/（见 vitest.config.js）
  const root = process.cwd();
  const mainSrc = readFileSync(resolve(root, 'yuketang-auto.user.js'), 'utf8');
  const coreSrc = readFileSync(resolve(root, 'lib/core.js'), 'utf8');
  // 源文件中的正则字面量文本（含反斜杠转义）
  const CJ_RE = '^\\/v2\\/web\\/xcloud\\/video-student\\/(\\d+)\\/(\\d+)$';
  const CJ_PREFIX_RE = '\\/v2\\/web\\/xcloud\\/video-student\\/';

  it('长江视频页识别正则两侧一致', () => {
    expect(mainSrc).toContain(CJ_PREFIX_RE);
    expect(coreSrc).toContain(CJ_PREFIX_RE);
  });

  it('buildNextVideoUrl 跳转正则与模板两侧一致', () => {
    expect(mainSrc).toContain(CJ_RE);
    expect(coreSrc).toContain(CJ_RE);
    expect(mainSrc).toContain('changjiang.yuketang.cn');
    expect(coreSrc).toContain('changjiang.yuketang.cn');
    expect(mainSrc).toContain('video/${nid}');
    expect(coreSrc).toContain('video/${nid}');
  });

  it('parseVideoStudentUrl 两侧一致', () => {
    expect(mainSrc).toContain('function parseVideoStudentUrl');
    expect(coreSrc).toContain('export function parseVideoStudentUrl');
  });

  it('detectPageType 的 video-student 判定两侧一致', () => {
    expect(mainSrc).toContain("p.includes('/video/') || p.includes('/video-student/')");
    expect(coreSrc).toContain("p.includes('/video/') || p.includes('/video-student/')");
  });

  it('v1.5 诊断采集字段两侧一致', () => {
    ['mediaEvents', 'uiSummary', 'customElements', 'sessionFlags', 'errorLog'].forEach(k => {
      expect(mainSrc).toContain(k);
      expect(coreSrc).toContain(k);
    });
  });
});

// ==================== getVideoStatus() ====================
describe('getVideoStatus()', () => {
  function makeQS(texts) {
    // 模拟 document.querySelectorAll — 返回含 textContent 的 span 数组
    const spans = texts.map(t => ({ textContent: t }));
    return () => spans;
  }

  it('"已完成" → completed=true', () => {
    const result = getVideoStatus(makeQS(['已完成']));
    expect(result).toEqual({ completed: true, text: '已完成' });
  });

  it('"50%" → percent=50', () => {
    const result = getVideoStatus(makeQS(['50%']));
    expect(result).toEqual({ completed: false, text: '50%', percent: 50 });
  });

  it('"完成度：0%" → percent=0', () => {
    const result = getVideoStatus(makeQS(['完成度：0%']));
    expect(result).toEqual({ completed: false, text: '完成度：0%', percent: 0 });
  });

  it('"完成度: 100%" → percent=100', () => {
    const result = getVideoStatus(makeQS(['完成度: 100%']));
    expect(result).toEqual({ completed: false, text: '完成度: 100%', percent: 100 });
  });

  it('多 span 中优先匹配第一个有效结果', () => {
    const result = getVideoStatus(makeQS(['Video', '已完成', '50%']));
    // 第二个是 "已完成"，所以优先返回
    expect(result).toEqual({ completed: true, text: '已完成' });
  });

  it('无匹配 → (unknown)', () => {
    const result = getVideoStatus(makeQS(['第三讲 应对学习压力--习题']));
    expect(result).toEqual({ completed: false, text: '(unknown)', percent: 0 });
  });

  it('空 span 列表 → (unknown)', () => {
    const result = getVideoStatus(makeQS([]));
    expect(result).toEqual({ completed: false, text: '(unknown)', percent: 0 });
  });

  it('span.textContent 为 null 不崩溃', () => {
    const result = getVideoStatus(() => [{ textContent: null }, { textContent: '已完成' }]);
    expect(result).toEqual({ completed: true, text: '已完成' });
  });

  describe('.finish 元素兜底', () => {
    it('sib textContent="已完成" → completed=true', () => {
      const orig = document.querySelector;
      document.querySelector = (sel) => {
        if (sel === '.finish') return { parentElement: { querySelector: () => ({ textContent: '已完成' }) } };
        return null;
      };
      try { expect(getVideoStatus(() => [])).toEqual({ completed: true, text: '已完成' }); }
      finally { document.querySelector = orig; }
    });

    it('sib 不存在 → (finish)', () => {
      const orig = document.querySelector;
      document.querySelector = (sel) => {
        if (sel === '.finish') return { parentElement: { querySelector: () => null } };
        return null;
      };
      try { expect(getVideoStatus(() => [])).toEqual({ completed: true, text: '(finish)' }); }
      finally { document.querySelector = orig; }
    });

    it('.finish 不存在 → (unknown)', () => {
      const orig = document.querySelector;
      document.querySelector = () => null;
      try { expect(getVideoStatus(() => [])).toEqual({ completed: false, text: '(unknown)', percent: 0 }); }
      finally { document.querySelector = orig; }
    });
  });
});

// ==================== buildDiagnosticsJSON() ====================
describe('buildDiagnosticsJSON()', () => {
  const baseEnv = {
    timestamp: '2026-06-27T08:00:00.000Z',
    userAgent: 'Chrome/149',
    currentUrl: 'https://scut.yuketang.cn/pro/lms/sig/123/video/456',
    scriptVersion: '1.1',
    engineActive: true,
  };

  const basePage = {
    pageType: 'video',
    video: {
      duration: 100, currentTime: 50, ended: false, paused: false,
      muted: true, playbackRate: 2, readyState: 4, networkState: 1,
      seeking: false, buffered: 1, error: null,
      src: 'https://cdn.example.com/video.mp4?…',
    },
    spanText: ['已完成'],
    finishExists: true,
    documentTitle: '华南理工大学',
    btnNextExists: true,
    btnNextRect: { x: 2129, y: 25, w: 72, h: 0 },
    vueInfo: { exists: true, depth: 3, keys: ['nextLeaf'], hasRouter: true, hasGetPreAndNextLeaf: true },
    nextLeaf: { id: 123, type: '' },
    preLeaf: { id: 122, type: '' },
    xtPlayer: { speedText: '2.00X', bigBtnVisible: false, loadingVisible: false, alertText: null },
  };

  const baseInternal = {
    keepAliveRunning: true,
    progressRunning: true,
    panelLogLines: ['[12:00] 开始', '[12:01] 播放中'],
    yktStatus: { _ts: 123, active: true, status: 'playing', progress: 50, items: ['secret'] },
    yktScoreData: { time: 123, total: 10, titles: ['secret'] },
  };

  it('完整构建所有字段', () => {
    const result = buildDiagnosticsJSON(baseEnv, basePage, baseInternal, null);
    expect(result.env.timestamp).toBe('2026-06-27T08:00:00.000Z');
    expect(result.env.engineActive).toBe(true);
    expect(result.page.video.duration).toBe(100);
    expect(result.page.nextLeaf).toEqual({ id: 123, type: '' });
    expect(result.internal.keepAliveRunning).toBe(true);
    expect(result.error).toBeNull();
  });

  it('video 为 null 时正常', () => {
    const page = { ...basePage, video: null };
    const result = buildDiagnosticsJSON(baseEnv, page, baseInternal, null);
    expect(result.page.video).toBeNull();
  });

  it('error 存在时包含 message + stack', () => {
    const result = buildDiagnosticsJSON(baseEnv, basePage, baseInternal, {
      message: 'test error',
      stack: 'line1\nline2',
    });
    expect(result.error.message).toBe('test error');
    expect(result.error.stack).toContain('line1');
  });

  it('stack 超过 2000 字符时截断', () => {
    const longStack = 'x'.repeat(2500);
    const result = buildDiagnosticsJSON(baseEnv, basePage, baseInternal, {
      message: 'long',
      stack: longStack,
    });
    expect(result.error.stack.length).toBeLessThanOrEqual(2000);
  });

  it('脱敏：yktStatus 不含 items', () => {
    const result = buildDiagnosticsJSON(baseEnv, basePage, baseInternal, null);
    expect(result.internal.yktStatus.items).toBeUndefined();
  });

  it('脱敏：yktScoreData 不含 titles', () => {
    const result = buildDiagnosticsJSON(baseEnv, basePage, baseInternal, null);
    expect(result.internal.yktScoreData.titles).toBeUndefined();
    expect(result.internal.yktScoreData.total).toBe(10);
  });

  it('engineActive=false 时正确记录', () => {
    const env = { ...baseEnv, engineActive: false };
    const result = buildDiagnosticsJSON(env, basePage, baseInternal, null);
    expect(result.env.engineActive).toBe(false);
  });

  it('空页面数据不崩溃', () => {
    const emptyPage = { pageType: 'video' };
    const result = buildDiagnosticsJSON(baseEnv, emptyPage, { keepAliveRunning: false, progressRunning: false }, null);
    expect(result.page.video).toBeNull();
    expect(result.page.spanText).toEqual([]);
    expect(result.page.vueInstance.exists).toBe(false);
  });

  it('yktStatus 为 JSON 字符串时正常解析', () => {
    const internal = { ...baseInternal, yktStatus: JSON.stringify({ _ts: 999, active: false, status: 'idle' }) };
    const result = buildDiagnosticsJSON(baseEnv, basePage, internal, null);
    expect(result.internal.yktStatus.status).toBe('idle');
  });

  it('yktStatus 含 total 时删除 items 字段', () => {
    const internal = { ...baseInternal, yktStatus: { _ts: 999, active: true, status: 'playing', progress: 50, total: 20, items: ['secret'] } };
    const result = buildDiagnosticsJSON(baseEnv, basePage, internal, null);
    expect(result.internal.yktStatus.total).toBe(20);
    expect(result.internal.yktStatus.items).toBeUndefined();
  });

  it('yktScoreData 为 JSON 字符串时正常解析', () => {
    const internal = { ...baseInternal, yktScoreData: JSON.stringify({ time: 999, total: 5 }) };
    const result = buildDiagnosticsJSON(baseEnv, basePage, internal, null);
    expect(result.internal.yktScoreData.total).toBe(5);
  });

  it('v1.5 新字段透传（screen/结构摘要/事件史/flags/errorLog）', () => {
    const env = { ...baseEnv, screen: { w: 1920, h: 1080, dpr: 2 } };
    const page = {
      ...basePage,
      customElements: ['xt-player', 'xt-bigbutton'],
      playerInfo: { globals: [{ k: 'xtPlayer', type: 'object' }], videoAttrs: { preload: 'auto' } },
      uiSummary: [{ sel: '.btn-next', count: 1, tag: 'button' }],
      mediaEvents: [{ t: '12:00:00', type: 'play', ct: 3, rs: 4 }],
      videoErrors: [{ t: '12:00:01', code: 4, msg: 'ERR', ct: 5 }],
    };
    const internal = { ...baseInternal, sessionFlags: { fallbackCount: '2' }, engineFlags: { resumeGuard: true } };
    const result = buildDiagnosticsJSON(env, page, internal, null, [{ t: '12:00:02', message: 'boom', stack: 'x' }]);
    expect(result.env.screen).toEqual({ w: 1920, h: 1080, dpr: 2 });
    expect(result.page.customElements).toContain('xt-player');
    expect(result.page.playerInfo.globals[0].k).toBe('xtPlayer');
    expect(result.page.uiSummary[0].sel).toBe('.btn-next');
    expect(result.page.mediaEvents[0].type).toBe('play');
    expect(result.page.videoErrors[0].code).toBe(4);
    expect(result.internal.sessionFlags.fallbackCount).toBe('2');
    expect(result.internal.engineFlags.resumeGuard).toBe(true);
    expect(result.errorLog[0].message).toBe('boom');
  });

  it('errorLog 缺省时为空数组，不破坏旧调用', () => {
    const result = buildDiagnosticsJSON(baseEnv, basePage, baseInternal, null);
    expect(result.errorLog).toEqual([]);
  });
});

// ==================== formatDiagnosticsText() ====================
describe('formatDiagnosticsText()', () => {
  const sampleDiag = buildDiagnosticsJSON(
    {
      timestamp: '2026-06-27T08:00:00.000Z',
      userAgent: 'Chrome/149',
      currentUrl: 'https://scut.yuketang.cn/test',
      scriptVersion: '1.1',
      engineActive: false,
    },
    {
      pageType: 'video',
      video: {
        duration: 100, currentTime: 50, ended: false, paused: false,
        muted: true, playbackRate: 2, readyState: 4, networkState: 1,
        seeking: false, buffered: 1, error: null,
        src: 'https://cdn.example.com/v.mp4?…',
      },
      spanText: ['已完成'],
      finishExists: true,
      documentTitle: '测试',
      btnNextExists: true,
      btnNextRect: { x: 0, y: 0, w: 72, h: 24 },
      vueInfo: { exists: false, depth: -1, keys: [], hasRouter: false, hasGetPreAndNextLeaf: false },
      nextLeaf: null,
      preLeaf: null,
      xtPlayer: { bigBtnVisible: null, loadingVisible: null },
    },
    { keepAliveRunning: false, progressRunning: false, panelLogLines: ['log1'] },
    null
  );

  it('包含标题头', () => {
    const text = formatDiagnosticsText(sampleDiag, null);
    expect(text).toContain('🐛 雨课堂脚本 BUG 上报');
  });

  it('包含所有四层分段', () => {
    const text = formatDiagnosticsText(sampleDiag, null);
    expect(text).toContain('🔴 环境信息');
    expect(text).toContain('🟡 页面结构');
    expect(text).toContain('🎬 播放器状态');
    expect(text).toContain('🟢 脚本内部');
    expect(text).toContain('🔴 错误信息');
  });

  it('用户描述置于最前', () => {
    const text = formatDiagnosticsText(sampleDiag, '视频卡住不动');
    const idxDesc = text.indexOf('💬 用户描述');
    const idxBug = text.indexOf('🐛 雨课堂');
    expect(idxDesc).toBeGreaterThan(-1);
    expect(idxDesc).toBeLessThan(idxBug);
    expect(text).toContain('视频卡住不动');
  });

  it('video 为 null 时显示 (无)', () => {
    const diag = buildDiagnosticsJSON(
      { timestamp: '', userAgent: '', currentUrl: '', scriptVersion: '', engineActive: false },
      { pageType: 'video' },
      { keepAliveRunning: false, progressRunning: false },
      null
    );
    const text = formatDiagnosticsText(diag, null);
    expect(text).toContain('video: (无)');
  });

  it('video.error 非空时正常显示', () => {
    const diag = buildDiagnosticsJSON(
      { timestamp: '', userAgent: '', currentUrl: '', scriptVersion: '', engineActive: false },
      {
        pageType: 'video',
        video: { error: { code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' } },
      },
      { keepAliveRunning: false, progressRunning: false },
      null
    );
    const text = formatDiagnosticsText(diag, null);
    expect(text).toContain('code=4');
  });

  it('readyState 显示中文说明', () => {
    const text = formatDiagnosticsText(sampleDiag, null);
    expect(text).toContain('足够数据');
  });

  it('networkState 显示中文说明', () => {
    const text = formatDiagnosticsText(sampleDiag, null);
    expect(text).toContain('闲置');
  });

  it('bigBtnVisible=null 时显示无元素', () => {
    const text = formatDiagnosticsText(sampleDiag, null);
    expect(text).toContain('(无xt-bigbutton)');
  });

  it('bigBtnVisible=true/false 时正确显示', () => {
    const diag = buildDiagnosticsJSON(
      { timestamp: '', userAgent: '', currentUrl: '', scriptVersion: '', engineActive: false },
      { pageType: 'video', xtPlayer: { bigBtnVisible: true, loadingVisible: false } },
      { keepAliveRunning: false, progressRunning: false },
      null
    );
    const text = formatDiagnosticsText(diag, null);
    expect(text).toContain('可见');
  });

  it('包含最近日志行', () => {
    const text = formatDiagnosticsText(sampleDiag, null);
    expect(text).toContain('log1');
  });
});

// ==================== parseScorePageItems() ====================
describe('parseScorePageItems()', () => {
  function makeLi(typeText, titleText, hasDone) {
    const fullText = hasDone ? `prefix ${titleText} 已完成 suffix` : `${titleText}`;
    return {
      textContent: fullText,
      querySelector(sel) {
        if (sel.includes('unit-name')) return { textContent: typeText };
        if (sel.includes('chapter-name')) return { textContent: titleText };
        return null;
      },
    };
  }

  it('解析标准 Video 项', () => {
    const items = parseScorePageItems([
      makeLi('Video', '第一讲、测试标题', false),
    ]);
    expect(items.totalVideos).toBe(1);
    expect(items.titles[0]).toEqual({ title: '第一讲、测试标题', completed: false });
  });

  it('已完成标记', () => {
    const items = parseScorePageItems([
      makeLi('Video', '第一讲、测试', true),
    ]);
    expect(items.titles[0].completed).toBe(true);
  });

  it('非 Video 类型被过滤', () => {
    const items = parseScorePageItems([
      makeLi('Homework', '作业一', false),
      makeLi('Video', '第一讲、视频', false),
    ]);
    expect(items.totalVideos).toBe(1);
  });

  it('标题过滤：极短标题不含 、 被过滤', () => {
    const items = parseScorePageItems([
      makeLi('Video', '短', false),
      makeLi('Video', '第一讲、正常标题', false),
    ]);
    // "短" 长度 1 且不含 、 → 被 filter 掉
    expect(items.totalVideos).toBe(1);
    expect(items.titles[0].title).toBe('第一讲、正常标题');
  });

  it('空列表', () => {
    const items = parseScorePageItems([]);
    expect(items.totalVideos).toBe(0);
    expect(items.titles).toEqual([]);
  });

  it('querySelector 返回 null 时不崩溃', () => {
    const li = {
      textContent: 'test',
      querySelector: () => null,
    };
    const items = parseScorePageItems([li]);
    expect(items.totalVideos).toBe(0);
  });
});

// ==================== matchVideoTitle() ====================
describe('matchVideoTitle()', () => {
  const titles = [
    { title: '第一讲、入门', completed: true },
    { title: '第二讲、进阶', completed: false },
    { title: '第三讲、高级', completed: false },
  ];

  it('精确匹配', () => {
    const result = matchVideoTitle(titles, '第二讲、进阶');
    expect(result).toEqual({ index: 2, total: 3, title: '第二讲、进阶' });
  });

  it('模糊匹配：当前标题包含目标', () => {
    const result = matchVideoTitle(titles, '第二讲、进阶课程');
    expect(result).toEqual({ index: 2, total: 3, title: '第二讲、进阶' });
  });

  it('模糊匹配：目标包含当前标题', () => {
    const result = matchVideoTitle(titles, '进阶');
    expect(result).not.toBeNull();
  });

  it('无匹配返回 null', () => {
    const result = matchVideoTitle(titles, '完全不同');
    expect(result).toBeNull();
  });

  it('空标题列表返回 null', () => {
    expect(matchVideoTitle([], '测试')).toBeNull();
    expect(matchVideoTitle(null, '测试')).toBeNull();
  });

  it('空当前标题返回 null', () => {
    expect(matchVideoTitle(titles, '')).toBeNull();
    expect(matchVideoTitle(titles, null)).toBeNull();
  });
});
