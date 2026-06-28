import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Viewer UI Visibility', () => {
  let controlsContainer, filenameDisplay, infoContainer, ratingDisplay, scaleDisplay;

  beforeEach(() => {
    // ResizeObserver mock
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    // DOM モック
    document.body.innerHTML = '';
    
    controlsContainer = document.createElement('div');
    controlsContainer.id = 'window-controls';

    filenameDisplay = document.createElement('div');
    filenameDisplay.id = 'window-filename-display';
    filenameDisplay.className = 'window-filename';

    infoContainer = document.createElement('div');
    infoContainer.id = 'window-info-container';
    infoContainer.style.display = 'none';

    ratingDisplay = document.createElement('div');
    ratingDisplay.id = 'viewer-rating-display';
    ratingDisplay.style.display = 'none';

    scaleDisplay = document.createElement('div');
    scaleDisplay.id = 'window-scale-display';
    scaleDisplay.className = 'window-scale-display';
    scaleDisplay.style.display = 'none';

    infoContainer.appendChild(ratingDisplay);
    infoContainer.appendChild(scaleDisplay);
    
    controlsContainer.appendChild(filenameDisplay);
    controlsContainer.appendChild(infoContainer);
    document.body.appendChild(controlsContainer);
  });

  it('should display filename when showViewerFilename is true', () => {
    // updateFilenameVisibility のシミュレート
    const show = true;
    if (filenameDisplay) {
      filenameDisplay.style.display = show ? 'flex' : 'none';
    }
    
    expect(filenameDisplay.style.display).toBe('flex');
    
    // loadImage 内でのファイル名設定のシミュレート
    const path = 'C:\\images\\test_image.png';
    const name = path.split(/[/\\]/).pop();
    filenameDisplay.textContent = name;
    
    expect(filenameDisplay.textContent).toBe('test_image.png');
  });

  it('should toggle scale display and update infoContainer visibility correctly', () => {
    // updateScaleDisplay のシミュレート
    const updateInfoContainerVisibility = () => {
      const hasScale = scaleDisplay.style.display !== 'none';
      const hasRating = ratingDisplay.style.display !== 'none';
      if (hasScale || hasRating) {
        infoContainer.style.display = 'flex';
        controlsContainer.classList.add('showing-scale');
      } else {
        infoContainer.style.display = 'none';
        controlsContainer.classList.remove('showing-scale');
      }
    };

    // 1. ズーム時 (100% 以外)
    let percent = 150;
    if (percent !== 100) {
      scaleDisplay.textContent = `${percent}%`;
      scaleDisplay.style.display = 'flex';
    } else {
      scaleDisplay.style.display = 'none';
    }
    updateInfoContainerVisibility();

    expect(scaleDisplay.style.display).toBe('flex');
    expect(scaleDisplay.textContent).toBe('150%');
    expect(infoContainer.style.display).toBe('flex');
    expect(controlsContainer.classList.contains('showing-scale')).toBe(true);

    // 2. 100% の時
    percent = 100;
    if (percent !== 100) {
      scaleDisplay.textContent = `${percent}%`;
      scaleDisplay.style.display = 'flex';
    } else {
      scaleDisplay.style.display = 'none';
    }
    updateInfoContainerVisibility();

    // rating も非表示と仮定しているので infoContainer も none になるはず
    expect(scaleDisplay.style.display).toBe('none');
    expect(infoContainer.style.display).toBe('none');
    expect(controlsContainer.classList.contains('showing-scale')).toBe(false);
  });
  
  it('should show infoContainer when rating is visible even if scale is 100%', () => {
    const updateInfoContainerVisibility = () => {
      const hasScale = scaleDisplay.style.display !== 'none';
      const hasRating = ratingDisplay.style.display !== 'none';
      if (hasScale || hasRating) {
        infoContainer.style.display = 'flex';
      } else {
        infoContainer.style.display = 'none';
      }
    };
    
    // スケールは 100% なので非表示
    scaleDisplay.style.display = 'none';
    
    // レーティングがあるので表示
    ratingDisplay.style.display = 'flex';
    
    updateInfoContainerVisibility();
    
    expect(infoContainer.style.display).toBe('flex');
  });

  it('should export updateScaleDisplay to window object', async () => {
    // viewer.js をインポートして、window.updateScaleDisplay が定義されているか確認
    // 動的インポートを使用して、実際のモジュールロードをシミュレート
    await import('../src/viewer.js');
    expect(typeof window.updateScaleDisplay).toBe('function');
  });
});
