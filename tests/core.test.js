/**
 * 雨课堂连播助手 — 单元测试
 *
 * 设计：直接加载出货脚本 `yuketang-auto.user.js` 本体，测试它导出的
 * `window._ykt.pure` 纯函数。**不再维护 lib/core.js 镜像**，从根上杜绝
 * "改了脚本忘了改镜像" 的漂移问题。
 *
 * 不覆盖（需要真实浏览器/油猴环境）：
 *   - 模块 0 always-on-focus（纯 DOM 覆写）
 *   - 模块 1 HTMLMediaElement 原型链拦截（已在真实页面手动验证）
 *   - 面板 UI / DOM 交互、接口调用、飞书上报
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_PATH = ['yuketang-auto.user.js', '../yuketang-auto.user.js']
  .map(p => resolve(process.cwd(), p))
  .find(p => existsSync(p));
const SCRIPT_SRC = readFileSync(SCRIPT_PATH, 'utf-8');

let ykt;
let pure;

beforeEach(async () => {
  document.body.innerHTML = '';
  localStorage.clear();
  sessionStorage.clear();
  // 通过动态 import 执行出货脚本：既能每次都重新跑一遍 IIFE，
  // 又能让 v8 覆盖率统计到真实代码（new Function 的 eval 代码统计不到）
  vi.resetModules();
  await import('../yuketang-auto.user.js');
  ykt = window._ykt;
  pure = ykt.pure;
});

// ==================== 脚本入口 ====================
describe('脚本入口', () => {
  it('暴露 window._ykt API', () => {
    expect(typeof ykt.start).toBe('function');
    expect(typeof ykt.stop).toBe('function');
    expect(typeof ykt.context).toBe('function');
    expect(typeof ykt.status).toBe('function');
    expect(typeof ykt.plan).toBe('function');
  });

  it('版本号与 @version 一致', () => {
    const m = SCRIPT_SRC.match(/@version\s+([\d.]+)/);
    expect(m).not.toBeNull();
    expect(ykt.version).toBe(m[1]);
  });

  it('pure 导出齐全', () => {
    ['parsePageContext', 'parsePageType', 'buildVideoUrl', 'pickNextVideo',
     'buildApiHeaders', 'getVideoStatus', 'formatDiagnosticsText'].forEach(k => {
      expect(typeof pure[k], k).toBe('function');
    });
  });
});

// ==================== parsePageContext / parsePageType ====================
describe('parsePageContext()', () => {
  it('新版视频页', () => {
    expect(pure.parsePageContext('/ai-workspace/lms-graph/26776303/video/49200284'))
      .toEqual({ version: 'new', classroomId: '26776303', rawKind: 'video', kind: 'video', leafId: '49200284' });
  });

  it('新版视频页带 query 不受影响（只吃 pathname）', () => {
    const ctx = pure.parsePageContext('/ai-workspace/lms-graph/26776303/video/49200284');
    expect(ctx.leafId).toBe('49200284');
  });

  it('新版讨论页 → forum', () => {
    const ctx = pure.parsePageContext('/ai-workspace/lms-graph/26776303/forum/49322365');
    expect(ctx.kind).toBe('forum');
    expect(ctx.leafId).toBe('49322365');
  });

  it('新版作业页 quiz → quiz', () => {
    const ctx = pure.parsePageContext('/ai-workspace/lms-graph/26776303/quiz/49464653');
    expect(ctx.kind).toBe('quiz');
  });

  it('新版课程学习空间（无 leaf）→ course', () => {
    const ctx = pure.parsePageContext('/ai-workspace/lms-graph/26776303');
    expect(ctx.kind).toBe('course');
    expect(ctx.leafId).toBeNull();
  });

  it('旧版华工视频页', () => {
    const ctx = pure.parsePageContext('/pro/lms/scut-89QA0744001577N/26776303/video/41157053');
    expect(ctx).toEqual({
      version: 'legacy', sign: 'scut-89QA0744001577N', classroomId: '26776303',
      rawKind: 'video', kind: 'video', leafId: '41157053',
    });
  });

  it('旧版未完成列表页 → course', () => {
    const ctx = pure.parsePageContext('/pro/lms/scut-89QA0744001577N/26776303/unfinished');
    expect(ctx.kind).toBe('course');
    expect(ctx.sign).toBe('scut-89QA0744001577N');
  });

  it('旧版成绩单页 → course', () => {
    expect(pure.parsePageContext('/pro/lms/scut-1/123/score').kind).toBe('course');
  });

  it('长江视频页', () => {
    const ctx = pure.parsePageContext('/v2/web/xcloud/video-student/2588039/49200284');
    expect(ctx).toEqual({
      version: 'cj', classroomId: '2588039', rawKind: 'video', kind: 'video', leafId: '49200284',
    });
  });

  it('无关路径返回 null', () => {
    expect(pure.parsePageContext('/pro/portal/home/')).toBeNull();
    expect(pure.parsePageContext('/')).toBeNull();
    expect(pure.parsePageContext('')).toBeNull();
    expect(pure.parsePageContext(undefined)).toBeNull();
  });
});

describe('parsePageType()', () => {
  it('视频 / 课程分类', () => {
    expect(pure.parsePageType('/ai-workspace/lms-graph/26776303/video/49200284')).toBe('video');
    expect(pure.parsePageType('/ai-workspace/lms-graph/26776303')).toBe('course');
    expect(pure.parsePageType('/pro/lms/x/26776303/unfinished')).toBe('course');
    expect(pure.parsePageType('/pro/lms/x/26776303/video/1')).toBe('video');
  });

  it('非课程路径 → unknown', () => {
    expect(pure.parsePageType('/pro/portal/home/')).toBe('unknown');
  });
});

// ==================== buildVideoUrl ====================
describe('buildVideoUrl()', () => {
  it('新版：拼出 ai-workspace/lms-graph 视频页 URL', () => {
    const ctx = pure.parsePageContext('/ai-workspace/lms-graph/26776303/video/1');
    const url = pure.buildVideoUrl(ctx, '49208337');
    expect(url).toBe('https://scut.yuketang.cn/ai-workspace/lms-graph/26776303/video/49208337' +
      '?node_id=0&fromProIframe=1&isyth=1&is_chapter=1');
  });

  it('长江：只替换 leafId', () => {
    const ctx = pure.parsePageContext('/v2/web/xcloud/video-student/2588039/111');
    expect(pure.buildVideoUrl(ctx, '222'))
      .toBe('https://scut.yuketang.cn/v2/web/xcloud/video-student/2588039/222');
  });

  it('旧版华工：保留 sign', () => {
    const ctx = pure.parsePageContext('/pro/lms/scut-89QA0744001577N/26776303/video/1');
    expect(pure.buildVideoUrl(ctx, '999'))
      .toBe('https://scut.yuketang.cn/pro/lms/scut-89QA0744001577N/26776303/video/999');
  });

  it('ctx 为空返回 null', () => {
    expect(pure.buildVideoUrl(null, '1')).toBeNull();
  });
});

// ==================== pickNextVideo（v2 核心决策） ====================
describe('pickNextVideo()', () => {
  const v = (leafId) => ({ leafId, type: 0 });
  const forum = (leafId) => ({ leafId, type: 4 });
  const quiz = (leafId) => ({ leafId, type: 5 });

  it('取第一个未完成视频（当前视频仍在清单 → 未确认完成）', () => {
    const r = pure.pickNextVideo([v('1'), v('2'), v('3')], '1');
    expect(r.next.leafId).toBe('2');
    expect(r.currentStillTodo).toBe(true);
    expect(r.total).toEqual({ all: 3, video: 3 });
  });

  it('跳过讨论/作业，只挑 type=0', () => {
    const r = pure.pickNextVideo([v('1'), forum('2'), quiz('3'), v('4')], '1');
    expect(r.next.leafId).toBe('4');
    expect(r.total).toEqual({ all: 4, video: 2 });
  });

  it('当前视频仍在清单里 → currentStillTodo=true（服务端未确认完成）', () => {
    const r = pure.pickNextVideo([v('1'), v('2')], '1');
    expect(r.currentStillTodo).toBe(true);
  });

  it('当前视频已从清单消失 → currentStillTodo=false', () => {
    const r = pure.pickNextVideo([v('2'), v('3')], '1');
    expect(r.currentStillTodo).toBe(false);
    expect(r.next.leafId).toBe('2');
  });

  it('leafId 数字/字符串都能比较（接口给字符串，DOM 给数字）', () => {
    const r = pure.pickNextVideo([{ leafId: '49200284', type: 0 }, { leafId: '5', type: 0 }], 49200284);
    expect(r.currentStillTodo).toBe(true);
    expect(r.next.leafId).toBe('5');
  });

  it('只剩讨论/作业 → next 为 null（视为全部视频已刷完）', () => {
    const r = pure.pickNextVideo([forum('1'), quiz('2')], '9');
    expect(r.next).toBeNull();
    expect(r.total.video).toBe(0);
  });

  it('清单为空 → next 为 null', () => {
    const r = pure.pickNextVideo([], '1');
    expect(r.next).toBeNull();
    expect(r.total).toEqual({ all: 0, video: 0 });
  });

  it('非数组入参不抛错', () => {
    expect(pure.pickNextVideo(null, '1').next).toBeNull();
    expect(pure.pickNextVideo(undefined, '1').total.all).toBe(0);
  });

  it('当前 leafId 为 null（课程页）时取第一个视频', () => {
    const r = pure.pickNextVideo([forum('0'), v('1'), v('2')], null);
    expect(r.next.leafId).toBe('1');
    expect(r.currentStillTodo).toBe(false);
  });
});

// ==================== buildApiHeaders ====================
describe('buildApiHeaders()', () => {
  const cookie = 'university_id=2627; platform_id=3; xtbz=cloud; platform_type=1; csrftoken=3Tia8W0x';

  it('从 cookie 抽出全部必需头部', () => {
    const h = pure.buildApiHeaders(cookie);
    expect(h['university-id']).toBe('2627');
    expect(h['platform-id']).toBe('3');
    expect(h['xtbz']).toBe('cloud');
    expect(h['x-csrftoken']).toBe('3Tia8W0x');
    expect(h['x-client']).toBe('web');
    expect(h['terminal-type']).toBe('web');
  });

  it('缺 xtbz 时回退 cloud', () => {
    expect(pure.buildApiHeaders('university_id=1').xtbz).toBe('cloud');
  });

  it('cookie 为空不发散', () => {
    const h = pure.buildApiHeaders('');
    expect(h['university-id']).toBe('');
    expect(h['x-csrftoken']).toBe('');
    expect(h.xtbz).toBe('cloud');
  });

  it('cookie 值做 URL 解码', () => {
    expect(pure.buildApiHeaders('csrftoken=a%2Bb')['x-csrftoken']).toBe('a+b');
  });

  it('不会把 classroom_id 误当成 platform_id', () => {
    const h = pure.buildApiHeaders('classroom_id=26776303; platform_id=3');
    expect(h['platform-id']).toBe('3');
  });
});

// ==================== getVideoStatus ====================
describe('getVideoStatus()', () => {
  function setBody(html) { document.body.innerHTML = html; }

  it('新版：完成度：3%', () => {
    setBody('<span class="rate-detail"><span class="el-tooltip text">完成度：3%</span></span>');
    expect(pure.getVideoStatus()).toEqual({ completed: false, text: '完成度：3%', percent: 3 });
  });

  it('新版：已完成', () => {
    setBody('<span class="rate-detail"><span class="el-tooltip text">已完成</span></span>');
    const s = pure.getVideoStatus();
    expect(s.completed).toBe(true);
    expect(s.text).toBe('已完成');
  });

  it('新版：小数百分比', () => {
    setBody('<span class="rate-detail"><span class="el-tooltip text">完成度：97.5%</span></span>');
    expect(pure.getVideoStatus().percent).toBe(97.5);
  });

  it('新版兜底：目录当前项有完成图标 → completed', () => {
    setBody('<div class="leaf-item is-active"><div class="leaf-item-status">' +
      '<i class="icon iconfont icon-yuanquangou-mianzhuang"></i></div></div>');
    const s = pure.getVideoStatus();
    expect(s.completed).toBe(true);
    expect(s.text).toBe('(leaf-icon)');
  });

  it('新版兜底：目录进度饼 --p: 37', () => {
    setBody('<div class="leaf-item is-active"><div class="leaf-item-status">' +
      '<div class="status-pie" style="--p: 37;"></div></div></div>');
    const s = pure.getVideoStatus();
    expect(s.completed).toBe(false);
    expect(s.percent).toBe(37);
  });

  it('新版兜底：进度饼 --p: 100 → completed', () => {
    setBody('<div class="leaf-item is-active"><div class="leaf-item-status">' +
      '<div class="status-pie" style="--p: 100;"></div></div></div>');
    expect(pure.getVideoStatus().completed).toBe(true);
  });

  it('新版：leaf-item 存在但无状态标记 → (leaf-empty)', () => {
    setBody('<div class="leaf-item is-active"><div class="leaf-item-status"><!----></div></div>');
    const s = pure.getVideoStatus();
    expect(s.completed).toBe(false);
    expect(s.text).toBe('(leaf-empty)');
  });

  it('旧版：span.text 已完成', () => {
    setBody('<span class="text">已完成</span>');
    expect(pure.getVideoStatus()).toEqual({ completed: true, text: '已完成' });
  });

  it('旧版：span.text 50%', () => {
    setBody('<span class="text">50%</span>');
    expect(pure.getVideoStatus().percent).toBe(50);
  });

  it('旧版：.finish 兜底', () => {
    setBody('<div class="finish"></div>');
    const s = pure.getVideoStatus();
    expect(s.completed).toBe(true);
    expect(s.text).toBe('(finish)');
  });

  it('什么都没有 → (unknown)', () => {
    setBody('');
    expect(pure.getVideoStatus()).toEqual({ completed: false, text: '(unknown)', percent: 0 });
  });

  it('新版选择器优先于旧版选择器', () => {
    setBody('<span class="rate-detail"><span class="el-tooltip text">已完成</span></span>' +
            '<span class="text">50%</span>');
    expect(pure.getVideoStatus().completed).toBe(true);
  });
});

// ==================== formatDiagnosticsText ====================
describe('formatDiagnosticsText()', () => {
  const diag = {
    env: {
      timestamp: '2026-10-07T08:00:00.000Z', userAgent: 'UA/1.0',
      currentUrl: 'https://scut.yuketang.cn/ai-workspace/lms-graph/26776303/video/1',
      scriptVersion: '2.0', engineActive: true,
      screen: { w: 1920, h: 1080, dpr: 1 },
    },
    page: {
      pageType: 'video',
      context: { version: 'new', classroomId: '26776303', leafId: '1', kind: 'video' },
      video: {
        duration: 100, currentTime: 50, ended: false, paused: false, muted: true,
        playbackRate: 2, volume: 0, src: 'https://ali-cdn.xuetangx.com/a.mp4?…',
        readyState: 4, networkState: 1, error: null, seeking: false, buffered: 2,
      },
      rateText: '完成度：50%', activeLeafTitle: '测试视频',
      leafSummary: { total: 74, done: 3, activeIdx: 1 },
      nextArrow: { cls: 'unit-arrow arrow-reverse', disabled: false },
      oldBtns: { btnNext: 0, finish: 0, spanText: 0 },
      xtPlayer: { speedText: '1.00X', bigBtnVisible: false, loadingVisible: false, alertText: null },
      customElements: ['xt-wrap', 'xt-bigbutton'],
      mediaEvents: [{ t: '12:00:01', type: 'play', ct: 0, rs: 4 }],
      videoErrors: [],
    },
    internal: {
      videoBound: true, keepAliveRunning: true, healthRunning: true,
      stopRequested: false, sessionRunning: true,
      health: { stall: 0, reloads: 0 },
      panelLogLines: ['[12:00:00] 面板已就绪'],
      sessionFlags: null, yktStatus: null,
    },
    errorLog: [],
  };

  it('渲染关键分段', () => {
    const t = pure.formatDiagnosticsText(diag, '');
    expect(t).toContain('🐛 雨课堂脚本 BUG 上报');
    expect(t).toContain('🔴 环境信息');
    expect(t).toContain('🟡 页面结构');
    expect(t).toContain('🎬 播放器状态');
    expect(t).toContain('🟢 脚本内部');
    expect(t).toContain('📋 最近日志');
    expect(t).toContain('完成度：50%');
    expect(t).toContain('rate=2');
  });

  it('用户描述置顶', () => {
    const t = pure.formatDiagnosticsText(diag, '视频卡住了');
    const idxUser = t.indexOf('💬 用户描述');
    expect(idxUser).toBeGreaterThan(-1);
    expect(idxUser).toBeLessThan(t.indexOf('🐛 雨课堂脚本 BUG 上报'));
    expect(t).toContain('视频卡住了');
  });

  it('video 为空时不抛错', () => {
    const d2 = JSON.parse(JSON.stringify(diag));
    d2.page.video = null;
    expect(() => pure.formatDiagnosticsText(d2, '')).not.toThrow();
    expect(pure.formatDiagnosticsText(d2, '')).toContain('video: (无)');
  });

  it('mediaEvents 逐条展开', () => {
    expect(pure.formatDiagnosticsText(diag, '')).toContain('[12:00:01] play ct=0s rs=4');
  });
});

// ==================== 上下文与真实 URL 回归 ====================
describe('真实 URL 回归', () => {
  const cases = [
    ['https://scut.yuketang.cn/ai-workspace/lms-graph/26776303/video/49200284', 'video', '49200284'],
    ['https://scut.yuketang.cn/pro/lms/scut-89QA0744001577N/26776303/unfinished', 'course', null],
    ['https://scut.yuketang.cn/pro/lms/scut-89QA0744001577N/26776303/video/41157053', 'video', '41157053'],
    ['https://changjiang.yuketang.cn/v2/web/xcloud/video-student/2588039/49200284', 'video', '49200284'],
  ];

  cases.forEach(([url, kind, leafId]) => {
    it(`${url}`, () => {
      const ctx = pure.parsePageContext(new URL(url).pathname);
      expect(ctx).not.toBeNull();
      expect(ctx.kind).toBe(kind);
      expect(ctx.leafId).toBe(leafId);
    });
  });
});
