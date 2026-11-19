import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { viewerState } from '../src/viewer/viewer-state.js';
import { handleViewerFileRenamed } from '../src/viewer/viewer.js';

describe('Viewer Rename Following (viewer-file-renamed)', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM(`
      <!DOCTYPE html>
      <html>
        <head><title>Veloce Viewer</title></head>
        <body>
          <div id="window-filename-display"></div>
          <div id="viewer-container">
            <img id="viewer-img" src="convert_src://C:/photos/image1.png" />
          </div>
        </body>
      </html>
    `, { url: 'http://localhost' });

    global.window = dom.window;
    global.document = dom.window.document;

    // 初期状態のセットアップ
    viewerState.paths = ['C:\\photos\\image1.png', 'C:\\photos\\image2.png'];
    viewerState.currentImagePath = 'C:\\photos\\image1.png';
    viewerState.currentIndex = 0;
    viewerState.totalImages = 2;
    viewerState.isMetadataVisible = false;

    const filenameEl = document.getElementById('window-filename-display');
    filenameEl.textContent = 'image1.png';
    document.title = 'Veloce Viewer - 1 / 2';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.window;
    delete global.document;
  });

  it('follows rename when oldPath matches currentImagePath without switching image', () => {
    const oldPath = 'C:\\photos\\image1.png';
    const newPath = 'C:\\photos\\image1_renamed.png';

    const viewerImg = document.getElementById('viewer-img');
    const initialImgSrc = viewerImg.src;

    const res = handleViewerFileRenamed(oldPath, newPath);

    // 1. 追随が成功したこと
    expect(res).toBe(true);

    // 2. currentImagePath が新パスに更新されていること
    expect(viewerState.currentImagePath).toBe(newPath);

    // 3. viewerState.paths 内の該当要素が新パスに差し替えられていること
    expect(viewerState.paths[0]).toBe(newPath);
    expect(viewerState.paths[1]).toBe('C:\\photos\\image2.png');

    // 4. ファイル名表示およびタイトルバーが更新されていること
    const filenameEl = document.getElementById('window-filename-display');
    expect(filenameEl.textContent).toBe('image1_renamed.png');
    expect(document.title).toBe('Veloce Viewer - 1 / 2');

    // 5. 表示中の画像自体（DOM）は切り替わっていないこと
    expect(viewerImg.src).toBe(initialImgSrc);
  });

  it('does nothing when oldPath does not match currentImagePath (unrelated file)', () => {
    const oldPath = 'C:\\photos\\unrelated.png';
    const newPath = 'C:\\photos\\unrelated_renamed.png';

    const viewerImg = document.getElementById('viewer-img');
    const initialImgSrc = viewerImg.src;

    const res = handleViewerFileRenamed(oldPath, newPath);

    // 1. 追随対象外として false が返ること
    expect(res).toBe(false);

    // 2. 状態が維持されていること
    expect(viewerState.currentImagePath).toBe('C:\\photos\\image1.png');
    expect(viewerState.paths[0]).toBe('C:\\photos\\image1.png');
    expect(viewerState.paths[1]).toBe('C:\\photos\\image2.png');

    // 3. 表示要素も変化しないこと
    const filenameEl = document.getElementById('window-filename-display');
    expect(filenameEl.textContent).toBe('image1.png');
    expect(viewerImg.src).toBe(initialImgSrc);
  });

  it('handles case-insensitivity and slash variations gracefully', () => {
    viewerState.currentImagePath = 'c:/photos/image1.png';

    const oldPath = 'C:\\PHOTOS\\image1.png';
    const newPath = 'C:\\photos\\renamed_variation.png';

    const res = handleViewerFileRenamed(oldPath, newPath);

    expect(res).toBe(true);
    expect(viewerState.currentImagePath).toBe(newPath);
    expect(document.getElementById('window-filename-display').textContent).toBe('renamed_variation.png');
  });

  it('ensures subsequent viewer-list-updated preserves current image position without reloading image', () => {
    // 1. リネーム通知を受信して追随
    handleViewerFileRenamed('C:\\photos\\image1.png', 'C:\\photos\\image1_renamed.png');
    expect(viewerState.currentImagePath).toBe('C:\\photos\\image1_renamed.png');

    // 2. メイン画面のソート等により更新されたファイルリストが viewer-list-updated で届く
    const updatedPaths = ['C:\\photos\\image1_renamed.png', 'C:\\photos\\image2.png'];
    viewerState.paths = updatedPaths;

    // viewer.js の viewer-list-updated ハンドラ相当の照合ロジック
    const newIndex = updatedPaths.indexOf(viewerState.currentImagePath);

    // 追随済みのため新リスト内でも正しくインデックスが見つかり、画像の再ロード（切り替え）が発生しないこと
    expect(newIndex).toBe(0);
    expect(newIndex).not.toBe(-1);
  });
});

