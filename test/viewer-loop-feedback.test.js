import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { viewerUI } from '../src/viewer/viewer-ui.js';
import { viewerState } from '../src/viewer/viewer-state.js';
import { showNext, showPrev, handleWheel } from '../src/viewer/viewer.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Viewer Loop Boundary Feedback (Phase 6)', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html class="viewer-html"><body class="viewer-body"><img id="viewer-img"><div id="border-overlay"></div></body></html>', {
      url: 'http://localhost'
    });
    global.window = dom.window;
    global.document = dom.window.document;

    global.window.scrollTo = vi.fn();
    global.window.veloceAPI = {
      convertFileSrc: (p) => `asset://${p}`
    };

    global.window.HTMLImageElement.prototype.decode = vi.fn().mockReturnValue(Promise.resolve());

    vi.useFakeTimers();

    viewerState.paths = ['C:/images/img1.png', 'C:/images/img2.png', 'C:/images/img3.png'];
    viewerState.currentIndex = 0;
    viewerState.totalImages = 3;

    global.showToast = vi.fn();
    global.window.showToast = global.showToast;
    global.window._wheelDeltaAccumulator = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.window;
    delete global.document;
    delete global.showToast;
  });

  describe('ViewerUI.prototype.triggerLoopFeedback', () => {
    it('boundary === "start"（末尾から先頭へループ）のとき、エッジグローが付与され「先頭に戻りました」トーストが発火すること', () => {
      viewerUI.triggerLoopFeedback('start');

      expect(document.body.classList.contains('viewer-edge-glow')).toBe(true);
      expect(global.showToast).toHaveBeenCalledWith('先頭に戻りました', 1500, 'info');

      // 400ms 後にクラスが削除されること
      vi.advanceTimersByTime(400);
      expect(document.body.classList.contains('viewer-edge-glow')).toBe(false);
    });

    it('boundary === "end"（先頭から末尾へループ）のとき、エッジグローが付与され「末尾に戻りました」トーストが発火すること', () => {
      viewerUI.triggerLoopFeedback('end');

      expect(document.body.classList.contains('viewer-edge-glow')).toBe(true);
      expect(global.showToast).toHaveBeenCalledWith('末尾に戻りました', 1500, 'info');

      vi.advanceTimersByTime(400);
      expect(document.body.classList.contains('viewer-edge-glow')).toBe(false);
    });

    it('400ms 以内に連続して発火された場合、前回のタイマーをクリアしてクラスが維持されること', () => {
      viewerUI.triggerLoopFeedback('start');
      expect(document.body.classList.contains('viewer-edge-glow')).toBe(true);

      vi.advanceTimersByTime(200);
      // 200ms 後に再度ループ発火
      viewerUI.triggerLoopFeedback('start');
      expect(document.body.classList.contains('viewer-edge-glow')).toBe(true);

      // さらに 200ms 経過（最初の発火から 400ms）時点では、2回目のタイマー（400ms）が生きているためクラスが残っている
      vi.advanceTimersByTime(200);
      expect(document.body.classList.contains('viewer-edge-glow')).toBe(true);

      // さらに 200ms 経過（2回目の発火から 400ms）で削除される
      vi.advanceTimersByTime(200);
      expect(document.body.classList.contains('viewer-edge-glow')).toBe(false);
    });
  });

  describe('showNext / showPrev のループ境界検知', () => {
    it('末尾画像（currentIndex === totalImages - 1）で showNext 実行時、先頭（0）へループし triggerLoopFeedback("start") が呼ばれること', () => {
      const triggerSpy = vi.spyOn(viewerUI, 'triggerLoopFeedback');

      viewerState.totalImages = 3;
      viewerState.currentIndex = 2; // 末尾

      showNext();

      expect(viewerState.currentIndex).toBe(0);
      expect(triggerSpy).toHaveBeenCalledWith('start');
    });

    it('先頭画像（currentIndex === 0）で showPrev 実行時、末尾（totalImages - 1）へループし triggerLoopFeedback("end") が呼ばれること', () => {
      const triggerSpy = vi.spyOn(viewerUI, 'triggerLoopFeedback');

      viewerState.totalImages = 3;
      viewerState.currentIndex = 0; // 先頭

      showPrev();

      expect(viewerState.currentIndex).toBe(2);
      expect(triggerSpy).toHaveBeenCalledWith('end');
    });

    it('通常送り（境界外）の遷移では triggerLoopFeedback が呼ばれないこと', () => {
      const triggerSpy = vi.spyOn(viewerUI, 'triggerLoopFeedback');

      viewerState.totalImages = 3;

      // 0 -> 1 (Next)
      viewerState.currentIndex = 0;
      showNext();
      expect(viewerState.currentIndex).toBe(1);
      expect(triggerSpy).not.toHaveBeenCalled();

      // 2 -> 1 (Prev)
      viewerState.currentIndex = 2;
      showPrev();
      expect(viewerState.currentIndex).toBe(1);
      expect(triggerSpy).not.toHaveBeenCalled();
    });

    it('画像総数が 1 枚のみの場合、showNext / showPrev ともにループフィードバックが抑止されること', () => {
      const triggerSpy = vi.spyOn(viewerUI, 'triggerLoopFeedback');

      viewerState.totalImages = 1;
      viewerState.currentIndex = 0;

      showNext();
      expect(viewerState.currentIndex).toBe(0);
      expect(triggerSpy).not.toHaveBeenCalled();

      showPrev();
      expect(viewerState.currentIndex).toBe(0);
      expect(triggerSpy).not.toHaveBeenCalled();
    });

    it('マウスホイール下スクロールで末尾から先頭へループしたとき、インデックスが0になり（タイマー進行後も2番目に飛ばないこと）triggerLoopFeedback("start")が呼ばれること', () => {
      const triggerSpy = vi.spyOn(viewerUI, 'triggerLoopFeedback');

      viewerState.totalImages = 3;
      viewerState.currentIndex = 2; // 末尾

      handleWheel({ deltaY: 100 });

      expect(viewerState.currentIndex).toBe(0);
      expect(triggerSpy).toHaveBeenCalledWith('start');

      // 以前の不具合で100ms後に再実行されインデックスが1（2番目）に飛ぶ問題が発生していたため、時間経過後も0が維持されることを検証
      vi.advanceTimersByTime(300);
      expect(viewerState.currentIndex).toBe(0);
    });

    it('マウスホイール上スクロールで先頭から末尾へループしたとき、インデックスが末尾になり（タイマー進行後も最後から2番目に飛ばないこと）triggerLoopFeedback("end")が呼ばれること', () => {
      const triggerSpy = vi.spyOn(viewerUI, 'triggerLoopFeedback');

      viewerState.totalImages = 3;
      viewerState.currentIndex = 0; // 先頭

      handleWheel({ deltaY: -100 });

      expect(viewerState.currentIndex).toBe(2);
      expect(triggerSpy).toHaveBeenCalledWith('end');

      // 以前の不具合で100ms後に再実行されインデックスが1（最後から2番目）に飛ぶ問題が発生していたため、時間経過後も2が維持されることを検証
      vi.advanceTimersByTime(300);
      expect(viewerState.currentIndex).toBe(2);
    });

    it('マウスホイールの連続スクロールで 0 -> 1 -> 2 -> 0 と順次正しく遷移すること', () => {
      viewerState.totalImages = 3;
      viewerState.currentIndex = 0;

      handleWheel({ deltaY: 100 });
      expect(viewerState.currentIndex).toBe(1);
      vi.advanceTimersByTime(200);

      handleWheel({ deltaY: 100 });
      expect(viewerState.currentIndex).toBe(2);
      vi.advanceTimersByTime(200);

      handleWheel({ deltaY: 100 });
      expect(viewerState.currentIndex).toBe(0);
      vi.advanceTimersByTime(200);
    });

    it('マウスホイールの連続逆スクロールで 0 -> 2 -> 1 -> 0 と順次正しく遷移すること', () => {
      viewerState.totalImages = 3;
      viewerState.currentIndex = 0;

      handleWheel({ deltaY: -100 });
      expect(viewerState.currentIndex).toBe(2);
      vi.advanceTimersByTime(200);

      handleWheel({ deltaY: -100 });
      expect(viewerState.currentIndex).toBe(1);
      vi.advanceTimersByTime(200);

      handleWheel({ deltaY: -100 });
      expect(viewerState.currentIndex).toBe(0);
      vi.advanceTimersByTime(200);
    });
  });

  describe('viewer.css のスタイル定義', () => {
    it('viewer.css に .viewer-edge-glow と @keyframes viewerEdgeFade が定義されていること', () => {
      const cssPath = path.resolve(__dirname, '../src/viewer/viewer.css');
      const cssContent = fs.readFileSync(cssPath, 'utf-8');

      expect(cssContent).toContain('.viewer-body.viewer-edge-glow::after');
      expect(cssContent).toContain('@keyframes viewerEdgeFade');
      expect(cssContent).toContain('--accent-color');
    });
  });
});
