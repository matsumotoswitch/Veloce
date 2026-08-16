import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { UIManager } from '../src/renderer-ui.js';

describe('UIManager._runWithUpdateLock', () => {
  let rafSpy;
  let getElementByIdSpy;

  beforeEach(() => {
    // requestAnimationFrame を setTimeout でモック化
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => setTimeout(cb, 0));
    // UIManager はコンストラクタで document.getElementById などを呼ぶためモック化
    getElementByIdSpy = vi.spyOn(document, 'getElementById').mockReturnValue(document.createElement('div'));
  });

  afterEach(() => {
    rafSpy.mockRestore();
    getElementByIdSpy.mockRestore();
  });

  it('非同期処理が重複して呼ばれた場合、同時実行を防ぎ、かつキューイングして後で1度だけ再実行する', async () => {
    const dummyAppState = { ratings: {} };
    const ui = new UIManager(dummyAppState);

    let executionCount = 0;
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const taskFn = async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      executionCount++;
      
      // 非同期タスクのシミュレーション（10ms待機）
      await new Promise(resolve => setTimeout(resolve, 10));
      
      concurrentCount--;
    };

    // 同時に3回呼び出す（マウスホイールの2ノッチ以上の連続スクロールをシミュレート）
    ui._runWithUpdateLock('testLock', taskFn);
    ui._runWithUpdateLock('testLock', taskFn);
    ui._runWithUpdateLock('testLock', taskFn);

    // 全ての非同期タスクがキューイングも含めて終わるまで十分に待機する
    await new Promise(resolve => setTimeout(resolve, 100));

    // 同時実行は必ず1つのみ（排他制御が働いている）
    expect(maxConcurrent).toBe(1); 
    
    // 3回の呼び出しでも、実行中のものはブロックされ、最後の「再実行フラグ」により1度だけ追加実行される。
    // よって、実際の実行回数は「最初の1回」＋「キューイングされた1回」＝ 2回となる。
    expect(executionCount).toBe(2); 
  });
});
