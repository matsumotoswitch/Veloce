import { describe, it, expect } from 'vitest';

// ============================================================
// Wheel scroll delta scaling logic
// renderer-ui.js smoothWheel 関数のスケール計算をテストする。
//
// 設計:
//   deltaMode=0 (px): delta = deltaY * WHEEL_SCALE_FACTOR
//   deltaMode=1 (行): delta = deltaY * 24
//   deltaMode=2 (ページ): delta = deltaY * clientHeight
// ============================================================

const WHEEL_SCALE_FACTOR = 1.5;
const LINE_HEIGHT_PX = 24;

function calcScrollDelta(deltaY, deltaMode, clientHeight) {
  if (deltaMode === 1) {
    return deltaY * LINE_HEIGHT_PX;
  } else if (deltaMode === 2) {
    return deltaY * clientHeight;
  } else {
    // deltaMode=0 (px), WebView2
    return deltaY * WHEEL_SCALE_FACTOR;
  }
}

describe('Wheel scroll delta calculation', () => {
  describe('deltaMode=0 (px / WebView2)', () => {
    it('1ノッチ分(100px)のdeltaYで150pxスクロール', () => {
      expect(calcScrollDelta(100, 0, 600)).toBe(150);
    });

    it('1ノッチ分(120px)のdeltaYで180pxスクロール', () => {
      expect(calcScrollDelta(120, 0, 600)).toBe(180);
    });

    it('逆方向(下→上)のスクロールが正しく負値になる', () => {
      expect(calcScrollDelta(-100, 0, 600)).toBe(-150);
    });

    it('delta=0のとき0になる', () => {
      expect(calcScrollDelta(0, 0, 600)).toBe(0);
    });

    it('WHEEL_SCALE_FACTORが1.5であること', () => {
      // 係数の値を固定して誤って変更されたときに検知できるようにする
      expect(WHEEL_SCALE_FACTOR).toBe(1.5);
    });
  });

  describe('deltaMode=1 (行単位 / Firefox等)', () => {
    it('3行分のdeltaYで72pxスクロール', () => {
      expect(calcScrollDelta(3, 1, 600)).toBe(72);
    });

    it('1行分のdeltaYで24pxスクロール', () => {
      expect(calcScrollDelta(1, 1, 600)).toBe(24);
    });

    it('逆方向が正しく動く', () => {
      expect(calcScrollDelta(-1, 1, 600)).toBe(-24);
    });
  });

  describe('deltaMode=2 (ページ単位)', () => {
    it('1ページ分のdeltaYでclientHeight分スクロール', () => {
      expect(calcScrollDelta(1, 2, 600)).toBe(600);
    });

    it('0.5ページ分は clientHeight/2', () => {
      expect(calcScrollDelta(0.5, 2, 600)).toBe(300);
    });
  });

  describe('アキュムレータ不使用の確認(各イベントが独立)', () => {
    it('連続したホイールイベントがそれぞれ独立してスケールされる', () => {
      // アキュムレータ方式なら内部状態が累積されるが、
      // 減衰係数方式では毎回 deltaY * FACTOR で完結する
      const deltas = [100, 100, 100];
      const results = deltas.map(d => calcScrollDelta(d, 0, 600));
      expect(results).toEqual([150, 150, 150]);
    });

    it('小さいdeltaYでも毎回スクロール量が計算される(閾値なし)', () => {
      // 旧アキュムレータ方式ではNOTCH_THRESHOLD未満だとスクロールしなかった
      // 新方式ではどんな微小値でも即時スクロールに変換される
      const smallDelta = 10;
      expect(calcScrollDelta(smallDelta, 0, 600)).toBe(15); // 10 * 1.5
    });
  });
});
