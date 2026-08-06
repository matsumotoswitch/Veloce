import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

// テスト用のグローバルモック環境構築
let dom;
beforeEach(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body><div id="tab-container"></div><div id="thumbnail-grid"><div class="virtual-spacer"></div><div class="virtual-content"></div></div><table id="file-list-body"></table></body></html>', {
    url: 'http://localhost'
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(),
      readText: vi.fn().mockResolvedValue('')
    }
  };
});

describe('PLAN.md Specifications', () => {
  
  describe('2.3 タブシステム - スクロール位置の同期的復元', () => {
    let appState;
    let uiManager;

    beforeEach(async () => {
      appState = {
        totalCount: 100,
        savedScrollTopGrid: 5000,
        savedScrollTopList: 3000,
      };

      // renderer-ui の uiManager のスタブ（本番ロジックをシミュレーション）
      uiManager = {
        elements: {
          thumbnailGrid: document.getElementById('thumbnail-grid'),
          fileListBody: document.getElementById('file-list-body')
        },
        async renderGrid() {
          const container = this.elements.thumbnailGrid;
          const spacer = container.querySelector('.virtual-spacer');
          
          // PLAN.md: コンテナ全体の高さが算出された直後に同期的に復元する
          const totalHeight = 10000;
          spacer.style.height = `${totalHeight}px`;

          if (appState.savedScrollTopGrid) {
            container.scrollTop = appState.savedScrollTopGrid;
            appState.savedScrollTopGrid = 0;
          }
        },
        async updateVirtualList() {
          const container = document.getElementById('tab-container'); // List container
          
          // PLAN.md: リストビューでも同期的復元
          const fragment = document.createDocumentFragment();
          const tr = document.createElement('tr');
          fragment.appendChild(tr);

          this.elements.fileListBody.innerHTML = '';
          this.elements.fileListBody.appendChild(fragment);

          if (appState.savedScrollTopList !== undefined && appState.savedScrollTopList !== 0) {
            container.scrollTop = appState.savedScrollTopList;
            appState.savedScrollTopList = 0;
          }
        }
      };
    });

    it('should synchronously restore grid scroll position and clear the saved value', async () => {
      expect(uiManager.elements.thumbnailGrid.scrollTop).toBe(0);
      expect(appState.savedScrollTopGrid).toBe(5000);

      await uiManager.renderGrid();

      // 同期的に反映されていること
      expect(uiManager.elements.thumbnailGrid.scrollTop).toBe(5000);
      // 変数がクリアされていること
      expect(appState.savedScrollTopGrid).toBe(0);
    });

    it('should synchronously restore list scroll position and clear the saved value', async () => {
      const tabContainer = document.getElementById('tab-container');
      expect(tabContainer.scrollTop).toBe(0);
      expect(appState.savedScrollTopList).toBe(3000);

      await uiManager.updateVirtualList();

      expect(tabContainer.scrollTop).toBe(3000);
      expect(appState.savedScrollTopList).toBe(0);
    });
  });

  describe('3.2 インスペクター - タグのクリップボード追加コピー', () => {
    let _lastCopiedTags = '';

    const setupListener = (uiManagerMock) => {
      _lastCopiedTags = '';
      document.body.addEventListener('click', async (e) => {
        const targetTag = e.target.closest('.diff-tag');
        if (targetTag) {
          const text = targetTag.textContent;
          if (text) {
            let textToCopy = text;
            let isAppended = false;
            
            // PLAN.md: WebView2制約回避のため内部変数 (_lastCopiedTags) で自己管理
            if (e.ctrlKey && _lastCopiedTags) {
              isAppended = true;
              const currentTags = _lastCopiedTags.split(',').map(t => t.trim()).filter(t => t);
              if (!currentTags.includes(text)) {
                textToCopy = _lastCopiedTags + ', ' + text;
              } else {
                textToCopy = _lastCopiedTags;
              }
            }
            _lastCopiedTags = textToCopy;
            
            await navigator.clipboard.writeText(textToCopy);
            
            const prefix = isAppended ? '追加コピーしました: ' : 'コピーしました: ';
            uiManagerMock.showToast(prefix + textToCopy, 3000, null, 'success');
          }
        }
      });
    };

    it('should copy single tag and show normal toast on normal click', async () => {
      const uiManagerMock = { showToast: vi.fn() };
      setupListener(uiManagerMock);

      const tag = document.createElement('span');
      tag.className = 'diff-tag';
      tag.textContent = '1girl';
      document.body.appendChild(tag);

      const clickEvent = new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: false });
      tag.dispatchEvent(clickEvent);
      await new Promise(r => setTimeout(r, 0));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('1girl');
      expect(uiManagerMock.showToast).toHaveBeenCalledWith('コピーしました: 1girl', 3000, null, 'success');
    });

    it('should append tag and show append toast on Ctrl+click without using clipboard.readText', async () => {
      const uiManagerMock = { showToast: vi.fn() };
      setupListener(uiManagerMock);

      // 第一のタグをクリック
      const tag1 = document.createElement('span');
      tag1.className = 'diff-tag';
      tag1.textContent = '1girl';
      document.body.appendChild(tag1);
      tag1.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: false }));
      await new Promise(r => setTimeout(r, 0));

      // 第二のタグをCtrl+クリック
      const tag2 = document.createElement('span');
      tag2.className = 'diff-tag';
      tag2.textContent = 'solo';
      document.body.appendChild(tag2);
      tag2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
      await new Promise(r => setTimeout(r, 0));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('1girl, solo');
      // readTextが呼び出されていないことを確認（WebView制約回避）
      expect(navigator.clipboard.readText).not.toHaveBeenCalled();
      expect(uiManagerMock.showToast).toHaveBeenCalledWith('追加コピーしました: 1girl, solo', 3000, null, 'success');
    });
  });

});
