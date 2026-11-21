import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { viewerState } from '../src/viewer/viewer-state.js';
import {
  handleViewerFileRenamed,
  handleViewerFolderRenamed,
  getViewerRatings,
  setViewerRatings
} from '../src/viewer/viewer.js';

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

  it('migrates overlayCache, drops non-visible preloadCache, and updates audioPath without changing audio src', () => {
    const oldPath = 'C:\\photos\\track1.mp3';
    const newPath = 'C:\\photos\\track1_renamed.mp3';
    viewerState.paths = [oldPath, 'C:\\photos\\image2.png'];
    viewerState.currentImagePath = oldPath;
    viewerState.overlayCache = new Map([
      [oldPath, { dataUrl: 'data:image/png;base64,AAA' }],
      ['C:\\photos\\image2.png', { dataUrl: 'data:image/png;base64,BBB' }]
    ]);

    const viewerImg = document.getElementById('viewer-img');
    viewerImg.dataset.audioPath = oldPath;
    const initialImgSrc = viewerImg.src;

    const nonVisiblePreloadImg = document.createElement('img');
    viewerState.preloadCache = new Map([
      [0, { img: viewerImg, path: oldPath }],
      [99, { img: nonVisiblePreloadImg, path: oldPath }],
      [1, { img: document.createElement('img'), path: 'C:\\photos\\image2.png' }]
    ]);

    const audioEl = document.createElement('audio');
    audioEl.id = 'viewer-audio';
    audioEl.src = 'http://127.0.0.1:12345/?path=track1.mp3';
    document.body.appendChild(audioEl);
    const initialAudioSrc = audioEl.src;

    const res = handleViewerFileRenamed(oldPath, newPath);
    expect(res).toBe(true);

    // overlayCache のキーが新パスへ移行し、無関係キーは維持されること
    expect(viewerState.overlayCache.has(oldPath)).toBe(false);
    expect(viewerState.overlayCache.get(newPath)).toEqual({ dataUrl: 'data:image/png;base64,AAA' });
    expect(viewerState.overlayCache.get('C:\\photos\\image2.png')).toEqual({ dataUrl: 'data:image/png;base64,BBB' });

    // preloadCache の非表示エントリは削除され、表示中要素のエントリのみパス更新・src 維持されること
    expect(viewerState.preloadCache.has(99)).toBe(false);
    expect(viewerState.preloadCache.get(0).path).toBe(newPath);
    expect(viewerState.preloadCache.get(1).path).toBe('C:\\photos\\image2.png');
    expect(viewerImg.src).toBe(initialImgSrc);

    // 表示中要素の dataset.audioPath が新パスへ更新され、再生中 audio の src は変更されないこと
    expect(viewerImg.dataset.audioPath).toBe(newPath);
    expect(audioEl.src).toBe(initialAudioSrc);
  });

  describe('Viewer Folder Rename Following (viewer-folder-renamed)', () => {
    it('follows folder rename for descendant paths, currentImagePath, and ratings without switching image', () => {
      viewerState.paths = [
        'C:\\album\\sub\\img1.png',
        'C:\\album\\img2.png',
        'C:\\album2\\sibling.png'
      ];
      viewerState.currentImagePath = 'C:\\album\\sub\\img1.png';
      viewerState.currentIndex = 0;
      viewerState.totalImages = 3;

      setViewerRatings({
        'C:\\album\\sub\\img1.png': 5,
        'C:\\album\\img2.png': 4,
        'C:\\album2\\sibling.png': 3
      });

      const viewerImg = document.getElementById('viewer-img');
      const initialImgSrc = viewerImg.src;

      const res = handleViewerFolderRenamed('C:\\album', 'C:\\album_renamed');

      // 1. 追随が成功したこと
      expect(res).toBe(true);

      // 2. 配下の paths が境界意識で置換され、兄弟フォルダ（C:\album2）は維持されていること
      expect(viewerState.paths[0]).toBe('C:\\album_renamed\\sub\\img1.png');
      expect(viewerState.paths[1]).toBe('C:\\album_renamed\\img2.png');
      expect(viewerState.paths[2]).toBe('C:\\album2\\sibling.png');

      // 3. currentImagePath が新パスへ付け替えられていること
      expect(viewerState.currentImagePath).toBe('C:\\album_renamed\\sub\\img1.png');

      // 4. 表示中の画像自体（DOM）は切り替わっていないこと
      expect(viewerImg.src).toBe(initialImgSrc);

      // 5. タイトルバーおよびファイル名表示が更新されていること
      expect(document.getElementById('window-filename-display').textContent).toBe('img1.png');
      expect(document.title).toBe('Veloce Viewer - 1 / 3');

      // 6. viewerRatings のキーが配下分のみ移行されていること
      const ratings = getViewerRatings();
      expect(ratings['C:\\album_renamed\\sub\\img1.png']).toBe(5);
      expect(ratings['C:\\album_renamed\\img2.png']).toBe(4);
      expect(ratings['C:\\album2\\sibling.png']).toBe(3);
      expect(ratings['C:\\album\\sub\\img1.png']).toBeUndefined();
      expect(ratings['C:\\album\\img2.png']).toBeUndefined();
    });

    it('does not touch sibling folders with similar prefix when viewer holds only sibling items', () => {
      viewerState.paths = ['C:\\album2\\sibling.png'];
      viewerState.currentImagePath = 'C:\\album2\\sibling.png';
      viewerState.currentIndex = 0;
      viewerState.totalImages = 1;

      setViewerRatings({
        'C:\\album2\\sibling.png': 3
      });

      const viewerImg = document.getElementById('viewer-img');
      const initialImgSrc = viewerImg.src;

      const res = handleViewerFolderRenamed('C:\\album', 'C:\\album_renamed');

      // 対象外として false が返ること
      expect(res).toBe(false);

      // 状態が完全に維持されていること
      expect(viewerState.paths[0]).toBe('C:\\album2\\sibling.png');
      expect(viewerState.currentImagePath).toBe('C:\\album2\\sibling.png');
      expect(getViewerRatings()['C:\\album2\\sibling.png']).toBe(3);
      expect(viewerImg.src).toBe(initialImgSrc);
    });

    it('does nothing when folder is unrelated', () => {
      viewerState.paths = ['C:\\photos\\img1.png'];
      viewerState.currentImagePath = 'C:\\photos\\img1.png';

      const res = handleViewerFolderRenamed('C:\\other_dir', 'C:\\other_dir_renamed');

      expect(res).toBe(false);
      expect(viewerState.paths[0]).toBe('C:\\photos\\img1.png');
      expect(viewerState.currentImagePath).toBe('C:\\photos\\img1.png');
    });

    it('updates folder and currentDirectory properties on viewerState if present', () => {
      viewerState.paths = ['C:\\album\\a.png'];
      viewerState.currentImagePath = 'C:\\album\\a.png';
      viewerState.folder = 'C:\\album\\sub';
      viewerState.currentDirectory = 'C:\\album';

      const res = handleViewerFolderRenamed('C:\\album', 'C:\\album_renamed');

      expect(res).toBe(true);
      expect(viewerState.folder).toBe('C:\\album_renamed\\sub');
      expect(viewerState.currentDirectory).toBe('C:\\album_renamed');

      delete viewerState.folder;
      delete viewerState.currentDirectory;
    });

    it('handles case-insensitivity and slash variations in folder rename', () => {
      viewerState.paths = ['c:/album/image1.png'];
      viewerState.currentImagePath = 'c:/album/image1.png';

      const res = handleViewerFolderRenamed('C:\\ALBUM', 'C:\\album_renamed');

      expect(res).toBe(true);
      expect(viewerState.currentImagePath).toBe('C:\\album_renamed\\image1.png');
      expect(viewerState.paths[0]).toBe('C:\\album_renamed\\image1.png');
      expect(document.getElementById('window-filename-display').textContent).toBe('image1.png');
    });

    it('ensures subsequent viewer-list-updated preserves current image position after folder rename', () => {
      viewerState.paths = ['C:\\album\\img1.png', 'C:\\album\\img2.png'];
      viewerState.currentImagePath = 'C:\\album\\img1.png';

      handleViewerFolderRenamed('C:\\album', 'C:\\album_renamed');
      expect(viewerState.currentImagePath).toBe('C:\\album_renamed\\img1.png');

      const updatedPaths = ['C:\\album_renamed\\img1.png', 'C:\\album_renamed\\img2.png'];
      viewerState.paths = updatedPaths;

      const newIndex = updatedPaths.indexOf(viewerState.currentImagePath);
      expect(newIndex).toBe(0);
      expect(newIndex).not.toBe(-1);
    });

    it('migrates descendant overlayCache, drops non-visible preloadCache, and updates audioPath on folder rename', () => {
      viewerState.paths = [
        'C:\\album\\sub\\song1.mp3',
        'C:\\album\\img2.png',
        'C:\\album2\\sibling.png'
      ];
      viewerState.currentImagePath = 'C:\\album\\sub\\song1.mp3';
      viewerState.currentIndex = 0;
      viewerState.totalImages = 3;
      viewerState.overlayCache = new Map([
        ['C:\\album\\sub\\song1.mp3', { dataUrl: 'data:image/png;base64,111' }],
        ['C:\\album\\img2.png', { dataUrl: 'data:image/png;base64,222' }],
        ['C:\\album2\\sibling.png', { dataUrl: 'data:image/png;base64,333' }]
      ]);

      const viewerImg = document.getElementById('viewer-img');
      viewerImg.dataset.audioPath = 'C:\\album\\sub\\song1.mp3';
      const initialImgSrc = viewerImg.src;

      const hiddenImg = document.createElement('img');
      const siblingImg = document.createElement('img');
      viewerState.preloadCache = new Map([
        [0, { img: viewerImg, path: 'C:\\album\\sub\\song1.mp3' }],
        [1, { img: hiddenImg, path: 'C:\\album\\img2.png' }],
        [2, { img: siblingImg, path: 'C:\\album2\\sibling.png' }]
      ]);

      const audioEl = document.createElement('audio');
      audioEl.id = 'viewer-audio';
      audioEl.src = 'http://127.0.0.1:12345/?path=song1.mp3';
      document.body.appendChild(audioEl);
      const initialAudioSrc = audioEl.src;

      const res = handleViewerFolderRenamed('C:\\album', 'C:\\album_renamed');
      expect(res).toBe(true);

      // overlayCache は配下のみ新フォルダへ移行し、兄弟フォルダは維持されること
      expect(viewerState.overlayCache.has('C:\\album\\sub\\song1.mp3')).toBe(false);
      expect(viewerState.overlayCache.has('C:\\album\\img2.png')).toBe(false);
      expect(viewerState.overlayCache.get('C:\\album_renamed\\sub\\song1.mp3')).toEqual({ dataUrl: 'data:image/png;base64,111' });
      expect(viewerState.overlayCache.get('C:\\album_renamed\\img2.png')).toEqual({ dataUrl: 'data:image/png;base64,222' });
      expect(viewerState.overlayCache.get('C:\\album2\\sibling.png')).toEqual({ dataUrl: 'data:image/png;base64,333' });

      // preloadCache は配下の非表示要素が削除され、表示中要素と兄弟フォルダは維持されること
      expect(viewerState.preloadCache.has(1)).toBe(false);
      expect(viewerState.preloadCache.get(0).path).toBe('C:\\album_renamed\\sub\\song1.mp3');
      expect(viewerState.preloadCache.get(2).path).toBe('C:\\album2\\sibling.png');
      expect(viewerImg.src).toBe(initialImgSrc);

      // 表示中要素の dataset.audioPath が新フォルダへ更新され、再生中 audio の src は変更されないこと
      expect(viewerImg.dataset.audioPath).toBe('C:\\album_renamed\\sub\\song1.mp3');
      expect(audioEl.src).toBe(initialAudioSrc);
    });
  });
});

