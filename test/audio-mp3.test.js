import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';
import {
  AUDIO_EXTENSIONS,
  AUDIO_PLACEHOLDER_URL,
  isAudioFile,
  getStreamUrl,
  getAudioCoverUrl,
  formatDurationSeconds,
  isLocalMediaServerUrl,
} from '../src/common/utils.js';
import {
  extractMetadataFields,
  buildInspectorSections,
  formatRecordingDate,
} from '../src/common/metadata-format.js';

describe('MP3 Audio Support', () => {
  describe('utils & detection', () => {
    beforeEach(() => {
      window.videoServerPort = 19876;
      window.videoServerToken = 'tok123';
    });

    afterEach(() => {
      delete window.videoServerPort;
      delete window.videoServerToken;
    });

    it('identifies only supported audio extensions via isAudioFile', () => {
      expect(AUDIO_EXTENSIONS).toEqual(['.mp3']);
      expect(isAudioFile('C:\\music\\song.mp3')).toBe(true);
      expect(isAudioFile('/home/user/Track01.MP3')).toBe(true);
      expect(isAudioFile('song.mp4')).toBe(false);
      expect(isAudioFile('song.wav')).toBe(false);
      expect(isAudioFile('song.flac')).toBe(false);
      expect(isAudioFile('image.png')).toBe(false);
      expect(isAudioFile('')).toBe(false);
      expect(isAudioFile(null)).toBe(false);
    });

    it('builds stream and audio cover URLs with consistent 127.0.0.1 host for covers and token when videoServerPort is present', () => {
      const mp3Path = 'C:\\Music\\track 01.mp3';
      expect(getStreamUrl(mp3Path, '')).toBe(
        'http://localhost:19876/?path=C%3A%5CMusic%5Ctrack%2001.mp3&token=tok123'
      );
      expect(getAudioCoverUrl(mp3Path)).toBe(
        'http://127.0.0.1:19876/?path=C%3A%5CMusic%5Ctrack%2001.mp3&cover=1&token=tok123'
      );
      expect(isLocalMediaServerUrl(getAudioCoverUrl(mp3Path))).toBe(true);
      expect(isLocalMediaServerUrl(getStreamUrl(mp3Path, ''))).toBe(true);
      expect(isLocalMediaServerUrl('asset://localhost/foo.png')).toBe(false);
    });

    it('formats duration seconds as M:SS and H:MM:SS', () => {
      expect(formatDurationSeconds(0)).toBe('0:00');
      expect(formatDurationSeconds(9.4)).toBe('0:09');
      expect(formatDurationSeconds(125)).toBe('2:05');
      expect(formatDurationSeconds(3661)).toBe('1:01:01');
    });

    it('provides Lucide music line-art SVG placeholder constant', async () => {
      const { AUDIO_PLACEHOLDER_URL: uiPlaceholder } = await import('../src/renderer/renderer-ui.js');
      expect(uiPlaceholder).toBe(AUDIO_PLACEHOLDER_URL);
      expect(uiPlaceholder.startsWith('data:image/svg+xml;base64,')).toBe(true);

      const svgText = Buffer.from(
        uiPlaceholder.replace('data:image/svg+xml;base64,', ''),
        'base64'
      ).toString('utf8');
      expect(svgText).toContain('viewBox="0 0 24 24"');
      expect(svgText).toContain('stroke="#444"');
      expect(svgText).toContain('stroke-width="1.5"');
      expect(svgText).toContain('<circle');
    });
  });

  describe('metadata formatting for audio tags', () => {
    it('extracts title, artist, and duration and renders inspector sections', () => {
      const extracted = extractMetadataFields(
        { name: 'track.mp3' },
        {
          metadata_source: 'Audio Tags',
          params: {
            title: 'Midnight Signal',
            artist: 'North Coast Unit',
            durationSecs: 222,
          },
        }
      );
      expect(extracted.params.title).toBe('Midnight Signal');
      expect(extracted.params.artist).toBe('North Coast Unit');
      expect(extracted.params.duration).toBe('3:42');

      const sections = buildInspectorSections(extracted);
      const titles = sections.map((s) => s.title);
      expect(titles).toContain('タイトル');
      expect(titles).toContain('アーティスト');
      expect(titles).toContain('再生時間');
      const durationSec = sections.find((s) => s.title === '再生時間');
      expect(durationSec.value).toBe('3:42');
      expect(titles).not.toContain('アルバム');
      expect(titles).not.toContain('録音日時');
      expect(titles).not.toContain('コメント');
      expect(titles).not.toContain('歌詞');
    });

    it('includes album, recordingDate, comment, and lyrics when present and hides them when absent', () => {
      const extracted = extractMetadataFields(
        { name: 'track.mp3' },
        {
          metadata_source: 'Audio Tags',
          params: {
            title: 'Midnight Signal',
            artist: 'North Coast Unit',
            album: 'Harbor Sessions',
            lyrics: 'Line one\nLine two',
            comment: 'Recorded live in studio',
            recordingDate: '2026-11-14T15:46:20',
            durationSecs: 222,
          },
        }
      );

      expect(extracted.params.album).toBe('Harbor Sessions');
      expect(extracted.params.lyrics).toBe('Line one\nLine two');
      expect(extracted.params.comment).toBe('Recorded live in studio');
      expect(extracted.params.recordingDate).toBe('2026/11/14 15:46:20');

      const sections = buildInspectorSections(extracted);
      const albumSec = sections.find((s) => s.title === 'アルバム');
      const recordingSec = sections.find((s) => s.title === '録音日時');
      const commentSec = sections.find((s) => s.title === 'コメント');
      const lyricsSec = sections.find((s) => s.title === '歌詞');

      expect(albumSec).toEqual({
        title: 'アルバム',
        value: 'Harbor Sessions',
        isParam: true,
        copyable: true,
      });
      expect(recordingSec).toEqual({
        title: '録音日時',
        value: '2026/11/14 15:46:20',
        isParam: true,
      });
      expect(commentSec).toEqual({
        title: 'コメント',
        value: 'Recorded live in studio',
        isText: true,
        copyable: true,
      });
      expect(lyricsSec).toEqual({
        title: '歌詞',
        value: 'Line one\nLine two',
        isText: true,
        copyable: true,
      });

      const emptyExtracted = extractMetadataFields(
        { name: 'empty.mp3' },
        {
          metadata_source: 'Audio Tags',
          params: {
            title: 'Only Title',
            album: '',
            lyrics: null,
            comment: undefined,
          },
        }
      );
      const emptyTitles = buildInspectorSections(emptyExtracted).map((s) => s.title);
      expect(emptyTitles).toContain('タイトル');
      expect(emptyTitles).not.toContain('アルバム');
      expect(emptyTitles).not.toContain('録音日時');
      expect(emptyTitles).not.toContain('コメント');
      expect(emptyTitles).not.toContain('歌詞');
    });

    it('formats recording dates as yyyy/mm/dd hh:mm:ss', () => {
      expect(formatRecordingDate('2026-11-14T15:46:20')).toBe('2026/11/14 15:46:20');
      expect(formatRecordingDate('2026-11-14T9:5:3')).toBe('2026/11/14 09:05:03');
      expect(formatRecordingDate('2026-11-14T15:46')).toBe('2026/11/14 15:46:00');
      expect(formatRecordingDate('2025-04-12')).toBe('2025/04/12 00:00:00');
      expect(formatRecordingDate('2026')).toBe('2026');
      expect(formatRecordingDate('')).toBeNull();
      expect(formatRecordingDate(null)).toBeNull();
    });

    it('renders comment and lyrics with text-box (unified UI font) instead of monospace raw-box', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const css = fs.readFileSync(
        path.resolve(__dirname, '../src/renderer/css/dialogs.css'),
        'utf8'
      );
      const textBoxMatch = css.match(/\.prompt-look\.text-box\s*\{([^}]*)\}/);
      expect(textBoxMatch).not.toBeNull();
      expect(textBoxMatch[1]).toContain('white-space: pre-wrap');
      expect(textBoxMatch[1]).not.toContain('--font-family-mono');
      expect(textBoxMatch[1]).not.toContain('--font-size-xs');

      const { renderMetadata, resetInspectorPools } = await import(
        '../src/renderer/renderer-inspector.js'
      );
      resetInspectorPools();
      document.body.innerHTML = `
        <div id="right-pane">
          <div id="inspector-header"><div id="inspector-header-path"></div></div>
          <div id="inspector-content"><div id="inspector-empty"></div></div>
        </div>
        <div id="static-file-info-table"></div>
        <div id="file-info-empty"></div>
      `;
      window.veloceAPI = {
        parseMetadata: vi.fn(async () => ({
          metadata_source: 'Audio Tags',
          params: {
            title: '挨拶',
            comment: 'コメント行1\nコメント行2',
            lyrics: '歌詞行1\n歌詞行2',
          },
        })),
      };
      await renderMetadata({
        name: 'voice.mp3',
        path: 'C:/audio/voice.mp3',
        width: 0,
        height: 0,
        mtime: 1000,
        ctime: 1000,
      });

      const blocks = Array.from(document.querySelectorAll('.inspector-section-block'));
      const findBoxByTitle = (t) => {
        const blk = blocks.find((b) => b.querySelector('h3 span span')?.textContent === t);
        return blk?.querySelector('.prompt-look');
      };
      const titleBox = findBoxByTitle('タイトル');
      const commentBox = findBoxByTitle('コメント');
      const lyricsBox = findBoxByTitle('歌詞');
      expect(titleBox.className).toBe('prompt-look param-box');
      expect(commentBox.className).toBe('prompt-look text-box');
      expect(lyricsBox.className).toBe('prompt-look text-box');
      expect(commentBox.textContent).toBe('コメント行1\nコメント行2');
      expect(lyricsBox.textContent).toBe('歌詞行1\n歌詞行2');
    });
  });

  describe('cover-less thumbnail placeholder & self-healing', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="grid-container">
          <div class="virtual-content">
            <div data-filepath="C:/audio/nocover.mp3">
              <img class="thumbnail-img" />
            </div>
          </div>
        </div>
      `;
      const wrapper = document.querySelector('[data-filepath="C:/audio/nocover.mp3"]');
      appState.thumbnailUrls.clear();
      appState.selection.clear();
      appState.filteredFiles = [{ path: 'C:/audio/nocover.mp3', mtime: 5000 }];
      appState.viewMode = 'grid';
      window.appState = appState;
      window.uiManager = {
        _domByPath: new Map([['C:/audio/nocover.mp3', wrapper]]),
      };
      window.veloceAPI = {
        getThumbnail: vi.fn(async () => ''),
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete window.uiManager;
    });

    it('uses AUDIO_PLACEHOLDER_URL and adds .audio-placeholder when mp3 has no embedded cover', async () => {
      const { ThumbnailQueueManager, checkThumbnailSelfHealing } = await import(
        '../src/renderer/renderer-thumbnails.js'
      );

      const manager = new ThumbnailQueueManager();
      window.thumbnailQueue = manager;
      await manager.runTask('C:/audio/nocover.mp3', false);

      const img = document.querySelector('img.thumbnail-img');
      expect(img.src).toBe(AUDIO_PLACEHOLDER_URL);
      expect(img.classList.contains('audio-placeholder')).toBe(true);
      expect(appState.thumbnailUrls.get('C:/audio/nocover.mp3')).toBe(
        AUDIO_PLACEHOLDER_URL
      );

      // Self-healing must not repeatedly queue cover-less audio placeholders
      const queueSpy = vi.spyOn(manager, 'enqueuePriority');
      expect(checkThumbnailSelfHealing()).toBe(0);
      expect(queueSpy).not.toHaveBeenCalled();
    });

    it('falls back to AUDIO_PLACEHOLDER_URL on updateDOM img.onerror and never writes raw file URL to thumbnailUrls', async () => {
      const { ThumbnailQueueManager } = await import('../src/renderer/renderer-thumbnails.js');
      const manager = new ThumbnailQueueManager();
      window.veloceAPI.convertFileSrc = vi.fn((p) => `asset://localhost/${encodeURIComponent(p)}`);

      const failingHttpUrl = 'http://127.0.0.1:19876/?path=C%3A%2Faudio%2Fnocover.mp3&mtime=5000&thumb=1';
      appState.thumbnailUrls.set('C:/audio/nocover.mp3', failingHttpUrl);
      manager.updateDOM('C:/audio/nocover.mp3', failingHttpUrl);

      const img = document.querySelector('img.thumbnail-img');
      expect(typeof img.onerror).toBe('function');
      img.onerror();

      expect(img.src).toBe(AUDIO_PLACEHOLDER_URL);
      expect(img.classList.contains('audio-placeholder')).toBe(true);
      expect(appState.thumbnailUrls.get('C:/audio/nocover.mp3')).toBe(AUDIO_PLACEHOLDER_URL);
      expect(appState.thumbnailUrls.get('C:/audio/nocover.mp3')).not.toContain('asset://');
    });
  });

  describe('viewer <audio> playback, generalized seekbar, and persistent volume', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      localStorage.clear();
      global.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      document.body.innerHTML = `
        <div class="viewer-body">
          <img id="viewer-img" decoding="async" src="" alt="" />
        </div>
        <div id="border-overlay"></div>
      `;

      window.scrollTo = vi.fn();
      window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
      window.HTMLMediaElement.prototype.pause = vi.fn();
      window.HTMLMediaElement.prototype.load = vi.fn();

      window.veloceAPI = {
        convertFileSrc: vi.fn((p) => `asset://localhost/${encodeURIComponent(p)}`),
        showWindow: vi.fn().mockResolvedValue(true),
        resizeViewer: vi.fn().mockResolvedValue(true),
        setWindowSize: vi.fn().mockResolvedValue(true),
        getFullMetadata: vi.fn().mockResolvedValue({ source: 'None', params: {} }),
        updateViewerState: vi.fn().mockResolvedValue(),
        getAllRatings: vi.fn().mockResolvedValue({}),
        isViewerMaximized: vi.fn().mockResolvedValue(false),
        setSetting: vi.fn().mockResolvedValue(),
        getSettings: vi.fn().mockResolvedValue({}),
        deleteSetting: vi.fn().mockResolvedValue(),
      };
      window.videoServerPort = 19876;
      window.videoServerToken = 'test_tok';
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
      localStorage.clear();
    });

    it('creates <audio>, auto-plays without loop, uses placeholder on missing cover, and discards on navigation', async () => {
      await import('../src/common/settings-store.js');
      const { loadImage, getActivePlaybackMedia } = await import('../src/viewer/viewer.js');
      const { viewerState } = await import('../src/viewer/viewer-state.js');

      viewerState.paths = ['C:/music/track1.mp3', 'C:/images/photo.png'];
      viewerState.totalImages = viewerState.paths.length;
      viewerState.currentIndex = 0;
      viewerState.preloadCache.clear();

      await loadImage();
      const audio1 = getActivePlaybackMedia();
      expect(audio1).not.toBeNull();
      expect(audio1.tagName).toBe('AUDIO');
      expect(audio1.loop).toBe(false);
      expect(audio1.autoplay).toBe(true);
      expect(audio1.src).toContain('19876');
      expect(audio1.src).toContain('track1.mp3');
      expect(audio1.play).toHaveBeenCalled();

      // Cover <img> points to ?cover=1 and swaps to AUDIO_PLACEHOLDER_URL on error
      const viewerImg = document.getElementById('viewer-img');
      expect(viewerImg.tagName).toBe('IMG');
      expect(viewerImg.src).toContain('cover=1');
      viewerImg.dispatchEvent(new Event('error'));
      expect(viewerImg.src).toBe(AUDIO_PLACEHOLDER_URL);
      expect(viewerImg.classList.contains('audio-placeholder')).toBe(true);

      // Navigating away stops and discards previous <audio>
      const pauseSpy = audio1.pause;
      const loadSpy = audio1.load;
      viewerState.currentIndex = 1;
      await loadImage();
      expect(pauseSpy).toHaveBeenCalled();
      expect(loadSpy).toHaveBeenCalled();
      expect(audio1.getAttribute('src')).toBeNull();
      expect(getActivePlaybackMedia()).toBeNull();
    });

    it('drives <audio> via generalized controls bar and persists volume/mute across <video> and <audio>', async () => {
      await import('../src/common/settings-store.js');
      const {
        loadImage,
        getActivePlaybackMedia,
        getSavedViewerVolume,
        getSavedViewerMuted,
      } = await import('../src/viewer/viewer.js');
      const { viewerState } = await import('../src/viewer/viewer-state.js');

      viewerState.paths = ['C:/music/track1.mp3', 'C:/videos/sample.mp4', 'C:/music/track2.mp3'];
      viewerState.totalImages = viewerState.paths.length;
      viewerState.currentIndex = 0;
      viewerState.preloadCache.clear();

      await loadImage();
      const audio = getActivePlaybackMedia();
      expect(audio).not.toBeNull();
      Object.defineProperty(audio, 'duration', { value: 120, configurable: true });

      const container = window.ensureVideoSeekBarContainer();
      window.setVideoSeekBarVisibility(true);
      expect(container.style.display).toBe('flex');

      const volumeBtn = document.getElementById('video-volume-btn');
      const volumePopup = document.getElementById('video-volume-popup');
      const volumeSlider = document.getElementById('video-volume-slider');
      const muteBtn = document.getElementById('video-mute-btn');
      const seekBar = document.getElementById('video-seek-bar');
      const playBtn = document.getElementById('video-play-btn');
      const timeDisplay = document.getElementById('video-time-display');
      const actionsContainer = document.getElementById('video-controls-actions');
      expect(document.getElementById('video-volume-bar')).toBeNull();
      expect(volumeBtn).not.toBeNull();
      expect(volumePopup).not.toBeNull();
      expect(volumeSlider).not.toBeNull();
      expect(muteBtn).not.toBeNull();
      expect(actionsContainer).not.toBeNull();
      expect(volumePopup.contains(volumeSlider)).toBe(true);
      expect(volumePopup.contains(muteBtn)).toBe(true);
      expect(volumePopup.style.display).toBe('none');

      // Open popup and adjust vertical volume slider -> applies to <audio> and persists to SettingsStore / localStorage
      volumeBtn.click();
      expect(volumePopup.style.display).toBe('flex');
      volumeSlider.value = '0.35';
      volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
      expect(audio.volume).toBeCloseTo(0.35, 2);
      expect(localStorage.getItem('viewerVolume')).toBe('0.35');
      expect(getSavedViewerVolume()).toBeCloseTo(0.35, 2);

      // Toggle mute button inside popup -> applies muted state and persists
      muteBtn.click();
      expect(audio.muted).toBe(true);
      expect(localStorage.getItem('viewerMuted')).toBe('true');
      expect(getSavedViewerMuted()).toBe(true);

      // Seek bar drives <audio>.currentTime and timeupdate updates #video-time-display
      seekBar.value = '50';
      seekBar.dispatchEvent(new Event('input', { bubbles: true }));
      expect(audio.currentTime).toBe(60);
      expect(timeDisplay.textContent).toBe('1:00 / 2:00');
      seekBar.dispatchEvent(new Event('change', { bubbles: true }));
      audio.dispatchEvent(new Event('timeupdate'));
      expect(timeDisplay.textContent).toBe('1:00 / 2:00');

      // Play/pause button toggles audio playback
      Object.defineProperty(audio, 'paused', { value: false, configurable: true });
      playBtn.click();
      expect(audio.pause).toHaveBeenCalled();

      // Switch to a <video> file -> saved volume and mute persist onto the <video> element
      viewerState.currentIndex = 1;
      await loadImage();
      const pendingVideo = viewerState.preloadCache.get(1).img;
      pendingVideo.dispatchEvent(new Event('loadedmetadata'));
      const video = document.getElementById('viewer-img');
      expect(video.tagName).toBe('VIDEO');
      expect(video.volume).toBeCloseTo(0.35, 2);
      expect(video.muted).toBe(true);

      // Unmute on <video>, then navigate back to <audio> -> stays unmuted with 0.35 volume
      muteBtn.click();
      expect(video.muted).toBe(false);
      expect(localStorage.getItem('viewerMuted')).toBe('false');

      viewerState.currentIndex = 2;
      await loadImage();
      const audio2 = getActivePlaybackMedia();
      expect(audio2.volume).toBeCloseTo(0.35, 2);
      expect(audio2.muted).toBe(false);
    });

    it('keeps 480x480 dimensions on placeholder audio through swapImageElement and always shows controls bar for audio', async () => {
      await import('../src/common/settings-store.js');
      const { loadImage, getMediaWidth, getMediaHeight, swapImageElement } = await import('../src/viewer/viewer.js');
      const { viewerState } = await import('../src/viewer/viewer-state.js');

      // Ensure showViewerSeekBar is OFF (default behavior)
      localStorage.setItem('showViewerSeekBar', 'false');

      viewerState.paths = ['C:/music/nocover.mp3', 'C:/videos/clip.mp4'];
      viewerState.totalImages = viewerState.paths.length;
      viewerState.currentIndex = 0;
      viewerState.preloadCache.clear();

      await loadImage();

      const viewerImg = document.getElementById('viewer-img');
      viewerImg.dispatchEvent(new Event('error'));
      expect(viewerImg.src).toBe(AUDIO_PLACEHOLDER_URL);
      expect(viewerImg.classList.contains('audio-placeholder')).toBe(true);
      expect(getMediaWidth(viewerImg)).toBe(480);
      expect(getMediaHeight(viewerImg)).toBe(480);

      // Even after swapImageElement runs on a pre-marked placeholder img, .audio-placeholder and 480x480 persist
      const placeholderImg = document.createElement('img');
      placeholderImg.dataset.audioPath = 'C:/music/nocover2.mp3';
      placeholderImg.classList.add('audio-placeholder');
      placeholderImg.src = AUDIO_PLACEHOLDER_URL;
      Object.defineProperty(placeholderImg, 'naturalWidth', { value: 48, configurable: true });
      Object.defineProperty(placeholderImg, 'naturalHeight', { value: 48, configurable: true });
      swapImageElement(placeholderImg, 999999);
      expect(placeholderImg.classList.contains('audio-placeholder')).toBe(true);
      expect(placeholderImg.classList.contains('viewer-img-pending')).toBe(true);
      expect(getMediaWidth(placeholderImg)).toBe(480);
      expect(getMediaHeight(placeholderImg)).toBe(480);

      // Controls bar MUST be visible for <audio> even when showViewerSeekBar is 'false'
      await loadImage();
      const container = document.getElementById('video-controls-container');
      expect(container).not.toBeNull();
      expect(container.style.display).toBe('flex');

      // Moving to <video> respects showViewerSeekBar === 'false' (hidden)
      viewerState.currentIndex = 1;
      await loadImage();
      const pendingVideo = viewerState.preloadCache.get(1).img;
      pendingVideo.dispatchEvent(new Event('loadedmetadata'));
      expect(container.style.display).toBe('none');
    });

    it('opens/closes volume popup via toggle, outside click, Escape, and file navigation without leaking events or closing window on Esc', async () => {
      await import('../src/common/settings-store.js');
      const closeWindowMock = vi.fn();
      window.veloceAPI.closeWindow = closeWindowMock;
      const { loadImage, getActivePlaybackMedia } = await import('../src/viewer/viewer.js');
      const { viewerState } = await import('../src/viewer/viewer-state.js');

      viewerState.paths = ['C:/music/track1.mp3', 'C:/music/track2.mp3'];
      viewerState.totalImages = viewerState.paths.length;
      viewerState.currentIndex = 0;
      viewerState.preloadCache.clear();

      await loadImage();
      const audio = getActivePlaybackMedia();
      expect(audio).not.toBeNull();

      const container = window.ensureVideoSeekBarContainer();
      const volumeBtn = document.getElementById('video-volume-btn');
      const volumePopup = document.getElementById('video-volume-popup');
      const volumeSlider = document.getElementById('video-volume-slider');
      const muteBtn = document.getElementById('video-mute-btn');
      const seekBar = document.getElementById('video-seek-bar');

      // 1. Toggle open/close on speaker button click
      expect(volumePopup.style.display).toBe('none');
      expect(volumeBtn.getAttribute('aria-expanded')).toBe('false');
      expect(container.classList.contains('volume-popup-open')).toBe(false);

      volumeBtn.click();
      expect(volumePopup.style.display).toBe('flex');
      expect(volumeBtn.getAttribute('aria-expanded')).toBe('true');
      expect(container.classList.contains('volume-popup-open')).toBe(true);

      volumeBtn.click();
      expect(volumePopup.style.display).toBe('none');
      expect(volumeBtn.getAttribute('aria-expanded')).toBe('false');
      expect(container.classList.contains('volume-popup-open')).toBe(false);

      // 2. Outside click (both document.body and sibling control inside bar) closes open popup
      volumeBtn.click();
      expect(volumePopup.style.display).toBe('flex');
      document.body.click();
      expect(volumePopup.style.display).toBe('none');

      volumeBtn.click();
      expect(volumePopup.style.display).toBe('flex');
      seekBar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(volumePopup.style.display).toBe('none');

      // 3. Escape closes popup WITHOUT closing viewer window; Escape when closed DOES close viewer window
      volumeBtn.click();
      expect(volumePopup.style.display).toBe('flex');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(volumePopup.style.display).toBe('none');
      expect(closeWindowMock).not.toHaveBeenCalled();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(closeWindowMock).toHaveBeenCalledTimes(1);

      // 4. Popup mouse events do not propagate to document.body / viewer panning handlers
      volumeBtn.click();
      const bodyBubbleSpy = vi.fn();
      document.body.addEventListener('mousedown', bodyBubbleSpy);
      document.body.addEventListener('click', bodyBubbleSpy);
      volumePopup.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      volumePopup.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(bodyBubbleSpy).not.toHaveBeenCalled();
      expect(volumePopup.style.display).toBe('flex');
      document.body.removeEventListener('mousedown', bodyBubbleSpy);
      document.body.removeEventListener('click', bodyBubbleSpy);

      // 5. Slider & mute update active media + 3-state bar speaker icon (normal -> zero -> muted)
      volumeSlider.value = '0';
      volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
      expect(audio.volume).toBe(0);
      expect(localStorage.getItem('viewerVolume')).toBe('0');
      expect(volumeBtn.querySelector('polygon')).not.toBeNull();
      expect(volumeBtn.querySelector('path')).toBeNull();
      expect(volumeBtn.querySelector('line')).toBeNull();

      volumeSlider.value = '0.6';
      volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
      expect(audio.volume).toBeCloseTo(0.6, 2);
      expect(volumeBtn.querySelector('path')).not.toBeNull();
      expect(volumeBtn.querySelector('line')).toBeNull();

      muteBtn.click();
      expect(audio.muted).toBe(true);
      expect(localStorage.getItem('viewerMuted')).toBe('true');
      expect(volumeBtn.querySelector('line')).not.toBeNull();
      expect(volumePopup.style.display).toBe('flex');

      // 6. Navigating to another file automatically closes the open popup
      viewerState.currentIndex = 1;
      await loadImage();
      expect(volumePopup.style.display).toBe('none');
      expect(container.classList.contains('volume-popup-open')).toBe(false);
    });

    it('uses Chromium 109 compatible rotated slider CSS matching seekbar style, nowrap time display, and removes #video-volume-bar', () => {
      const css = fs.readFileSync(path.resolve(process.cwd(), 'src/viewer/viewer.css'), 'utf8');
      expect(css).not.toContain('#video-volume-bar');
      expect(css).toContain('#video-controls-actions');
      expect(css).toContain('#video-volume-popup');
      expect(css).toContain('#video-volume-slider-wrapper');
      expect(css).toMatch(/#video-time-display\s*\{[^}]*white-space:\s*nowrap/s);
      expect(css).toMatch(/#video-volume-slider\s*\{[^}]*-webkit-appearance:\s*none/s);
      expect(css).toMatch(/#video-volume-slider\s*\{[^}]*transform:\s*rotate\(-90deg\)/s);
      expect(css).not.toMatch(/-webkit-appearance:\s*slider-vertical/);
      expect(css).not.toMatch(/writing-mode:\s*vertical-lr/);
    });
  });
});
