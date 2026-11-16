import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Viewer Play Mode (Stop / Repeat / AutoNext)', () => {
  let originalVideoServerPort;
  let originalVideoServerToken;
  let originalVeloceAPI;

  beforeEach(() => {
    localStorage.clear();
    if (window.SettingsStore && typeof window.SettingsStore.resetForTesting === 'function') {
      window.SettingsStore.resetForTesting();
    }
    originalVideoServerPort = window.videoServerPort;
    originalVideoServerToken = window.videoServerToken;
    originalVeloceAPI = window.veloceAPI;

    window.videoServerPort = 12345;
    window.videoServerToken = 'test_token_123';
    window.scrollTo = vi.fn();
    window.showToast = vi.fn();

    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      get() { return 4; },
      configurable: true,
    });
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();

    window.veloceAPI = {
      convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}`,
      showWindow: vi.fn().mockResolvedValue(true),
      resizeViewer: vi.fn().mockResolvedValue(true),
      getAllRatings: vi.fn().mockResolvedValue({}),
      isViewerMaximized: vi.fn().mockResolvedValue(false),
      getStreamUrl: vi.fn((path, base) => `${base}?token=test_token_123`),
    };

    document.body.innerHTML = `
      <img id="viewer-img" decoding="async" src="" alt="">
      <div id="border-overlay"></div>
    `;
  });

  afterEach(() => {
    window.videoServerPort = originalVideoServerPort;
    window.videoServerToken = originalVideoServerToken;
    window.veloceAPI = originalVeloceAPI;
    vi.restoreAllMocks();
    localStorage.clear();
    if (window.SettingsStore && typeof window.SettingsStore.resetForTesting === 'function') {
      window.SettingsStore.resetForTesting();
    }
  });

  it('defaults to repeat mode for both video and audio when unset', async () => {
    const { getSavedViewerPlayMode, PLAY_MODES } = await import('../src/viewer/viewer.js');

    expect(getSavedViewerPlayMode('video')).toBe(PLAY_MODES.REPEAT);
    expect(getSavedViewerPlayMode('audio')).toBe(PLAY_MODES.REPEAT);
    expect(getSavedViewerPlayMode()).toBe(PLAY_MODES.REPEAT);
  });

  it('persists video and audio play modes independently', async () => {
    await import('../src/common/settings-store.js');
    const {
      getSavedViewerPlayMode,
      saveViewerPlayMode,
      PLAY_MODES,
    } = await import('../src/viewer/viewer.js');

    saveViewerPlayMode('video', PLAY_MODES.STOP);
    expect(getSavedViewerPlayMode('video')).toBe(PLAY_MODES.STOP);
    expect(getSavedViewerPlayMode('audio')).toBe(PLAY_MODES.REPEAT);
    expect(localStorage.getItem('viewerPlayModeVideo')).toBe(PLAY_MODES.STOP);
    expect(localStorage.getItem('viewerPlayModeAudio')).toBeNull();

    saveViewerPlayMode('audio', PLAY_MODES.AUTO_NEXT);
    expect(getSavedViewerPlayMode('video')).toBe(PLAY_MODES.STOP);
    expect(getSavedViewerPlayMode('audio')).toBe(PLAY_MODES.AUTO_NEXT);
    expect(localStorage.getItem('viewerPlayModeAudio')).toBe(PLAY_MODES.AUTO_NEXT);
  });

  it('cycles modes in order (stop -> repeat -> auto_next -> stop) with toast notification', async () => {
    await import('../src/common/settings-store.js');
    const {
      cycleViewerPlayMode,
      getSavedViewerPlayMode,
      saveViewerPlayMode,
      PLAY_MODES,
    } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    // 動画ファイルを表示中の状態にする
    viewerState.currentImagePath = 'C:/videos/sample.mp4';
    saveViewerPlayMode('video', PLAY_MODES.STOP);

    // 停止 -> リピート
    const mode1 = cycleViewerPlayMode();
    expect(mode1).toBe(PLAY_MODES.REPEAT);
    expect(getSavedViewerPlayMode('video')).toBe(PLAY_MODES.REPEAT);
    expect(window.showToast).toHaveBeenCalledWith('再生モード：リピート');

    // リピート -> 自動送り
    const mode2 = cycleViewerPlayMode();
    expect(mode2).toBe(PLAY_MODES.AUTO_NEXT);
    expect(getSavedViewerPlayMode('video')).toBe(PLAY_MODES.AUTO_NEXT);
    expect(window.showToast).toHaveBeenCalledWith('再生モード：自動送り');

    // 自動送り -> 停止
    const mode3 = cycleViewerPlayMode();
    expect(mode3).toBe(PLAY_MODES.STOP);
    expect(getSavedViewerPlayMode('video')).toBe(PLAY_MODES.STOP);
    expect(window.showToast).toHaveBeenCalledWith('再生モード：停止');
  });

  it('applies mode loop setting to <video> and <audio> elements upon creation', async () => {
    await import('../src/common/settings-store.js');
    const {
      loadImage,
      saveViewerPlayMode,
      getActivePlaybackMedia,
      PLAY_MODES,
    } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    // 1. 動画（既定値: repeat -> loop = true）
    viewerState.paths = ['C:/videos/sample.mp4', 'C:/music/track.mp3'];
    viewerState.totalImages = 2;
    viewerState.currentIndex = 0;
    viewerState.preloadCache.clear();

    await loadImage();
    let videoEl = getActivePlaybackMedia();
    expect(videoEl).not.toBeNull();
    expect(videoEl.tagName).toBe('VIDEO');
    expect(videoEl.loop).toBe(true);

    // 動画のモードを停止に変更して再読込 -> loop = false
    saveViewerPlayMode('video', PLAY_MODES.STOP);
    viewerState.preloadCache.clear();
    await loadImage();
    videoEl = getActivePlaybackMedia();
    expect(videoEl.loop).toBe(false);

    // 2. 音声（モードを自動送りに変更 -> loop = false）
    saveViewerPlayMode('audio', PLAY_MODES.AUTO_NEXT);
    viewerState.currentIndex = 1;
    viewerState.preloadCache.clear();
    await loadImage();
    const audioEl = getActivePlaybackMedia();
    expect(audioEl).not.toBeNull();
    expect(audioEl.tagName).toBe('AUDIO');
    expect(audioEl.loop).toBe(false);

    // 音声のモードをリピートに変更して再読込 -> loop = true
    saveViewerPlayMode('audio', PLAY_MODES.REPEAT);
    viewerState.preloadCache.clear();
    await loadImage();
    const audioEl2 = getActivePlaybackMedia();
    expect(audioEl2.loop).toBe(true);
  });

  it('immediately reflects loop flag change on active playback media during playback', async () => {
    await import('../src/common/settings-store.js');
    const {
      loadImage,
      cycleViewerPlayMode,
      saveViewerPlayMode,
      getActivePlaybackMedia,
      PLAY_MODES,
    } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    viewerState.paths = ['C:/videos/sample.mp4'];
    viewerState.totalImages = 1;
    viewerState.currentIndex = 0;
    viewerState.preloadCache.clear();
    saveViewerPlayMode('video', PLAY_MODES.STOP);

    await loadImage();
    const videoEl = getActivePlaybackMedia();
    expect(videoEl.loop).toBe(false);

    // 再生中にモード切替（stop -> repeat）
    cycleViewerPlayMode();
    expect(videoEl.loop).toBe(true);

    // 再生中にモード切替（repeat -> auto_next）
    cycleViewerPlayMode();
    expect(videoEl.loop).toBe(false);
  });

  it('advances to next file upon ended event in auto_next mode, but stops at the end of the list', async () => {
    await import('../src/common/settings-store.js');
    const {
      loadImage,
      saveViewerPlayMode,
      getActivePlaybackMedia,
      PLAY_MODES,
    } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    viewerState.paths = ['C:/videos/part1.mp4', 'C:/music/part2.mp3', 'C:/images/photo.png'];
    viewerState.totalImages = 3;
    viewerState.currentIndex = 0;
    viewerState.preloadCache.clear();
    saveViewerPlayMode('video', PLAY_MODES.AUTO_NEXT);
    saveViewerPlayMode('audio', PLAY_MODES.AUTO_NEXT);

    // 1番目（動画）をロード
    await loadImage();
    expect(viewerState.currentIndex).toBe(0);
    const videoEl = getActivePlaybackMedia();

    // 動画再生終了（ended） -> 2番目へ進む
    videoEl.dispatchEvent(new Event('ended', { bubbles: true }));
    expect(viewerState.currentIndex).toBe(1);

    // 2番目（音声）をロード
    await loadImage();
    expect(viewerState.currentIndex).toBe(1);
    const audioEl = getActivePlaybackMedia();

    // 音声再生終了（ended） -> 3番目（画像）へ進む
    audioEl.dispatchEvent(new Event('ended', { bubbles: true }));
    expect(viewerState.currentIndex).toBe(2);

    // 3番目（画像）をロード。画像は再生対象メディアを持たないため終了イベントは起きず、停止する
    await loadImage();
    expect(viewerState.currentIndex).toBe(2);
    expect(getActivePlaybackMedia()).toBeNull();

    // もし末尾が動画だった場合でも、リスト末尾ならラップせず進まないことを確認
    viewerState.paths = ['C:/images/photo.png', 'C:/videos/last.mp4'];
    viewerState.totalImages = 2;
    viewerState.currentIndex = 1;
    viewerState.preloadCache.clear();
    await loadImage();

    const lastVideo = getActivePlaybackMedia();
    lastVideo.dispatchEvent(new Event('ended', { bubbles: true }));
    // 末尾のため進まず 1 のまま
    expect(viewerState.currentIndex).toBe(1);
  });

  it('does not advance to next file upon ended event in stop mode', async () => {
    await import('../src/common/settings-store.js');
    const {
      loadImage,
      saveViewerPlayMode,
      getActivePlaybackMedia,
      PLAY_MODES,
    } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    viewerState.paths = ['C:/videos/part1.mp4', 'C:/videos/part2.mp4'];
    viewerState.totalImages = 2;
    viewerState.currentIndex = 0;
    viewerState.preloadCache.clear();
    saveViewerPlayMode('video', PLAY_MODES.STOP);

    await loadImage();
    const videoEl = getActivePlaybackMedia();

    videoEl.dispatchEvent(new Event('ended', { bubbles: true }));
    // 停止モードのため進まない
    expect(viewerState.currentIndex).toBe(0);
  });

  it('integrates play mode button into #video-controls-actions with proper Lucide SVG and title', async () => {
    await import('../src/common/settings-store.js');
    const {
      loadImage,
      saveViewerPlayMode,
      PLAY_MODES,
    } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    viewerState.paths = ['C:/videos/sample.mp4'];
    viewerState.totalImages = 1;
    viewerState.currentIndex = 0;
    viewerState.preloadCache.clear();
    saveViewerPlayMode('video', PLAY_MODES.REPEAT);

    await loadImage();
    const container = window.ensureVideoSeekBarContainer();
    window.setVideoSeekBarVisibility(true);

    const actionsContainer = document.getElementById('video-controls-actions');
    expect(actionsContainer).not.toBeNull();

    const playModeBtn = document.getElementById('video-play-mode-btn');
    expect(playModeBtn).not.toBeNull();
    expect(actionsContainer.contains(playModeBtn)).toBe(true);

    // 初期状態はリピート
    expect(playModeBtn.title).toBe('再生モード：リピート');
    expect(playModeBtn.innerHTML).toContain('<svg');
    expect(playModeBtn.innerHTML).toContain('m17 2 4 4-4 4'); // repeat path

    // ボタンクリックで自動送りへ切替
    playModeBtn.click();
    expect(playModeBtn.title).toBe('再生モード：自動送り');
    expect(playModeBtn.innerHTML).toContain('polygon'); // skip-forward

    // ボタンクリックで停止へ切替
    playModeBtn.click();
    expect(playModeBtn.title).toBe('再生モード：停止');
    expect(playModeBtn.innerHTML).toContain('rect'); // square
  });
});

