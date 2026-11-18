import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Startup Performance & Non-blocking Initialization Architecture', () => {
  const rootDir = path.resolve(__dirname, '..');
  const mainRsPath = path.join(rootDir, 'src-tauri', 'src', 'main.rs');

  it('ensures init_db does not execute synchronous full-table scan UPDATE on metadata_source', () => {
    const mainRs = fs.readFileSync(mainRsPath, 'utf-8');
    const initDbMatch = mainRs.match(/fn init_db\(\)[\s\S]*?\n\}/);
    expect(initDbMatch).not.toBeNull();
    const initDbCode = initDbMatch[0];

    // 起動時の数秒単位のブロッキングを防ぐため、metadata_source に対するフルスキャン UPDATE が存在しないこと
    expect(initDbCode).not.toContain("UPDATE cache SET metadata_source = '' WHERE metadata_source != ''");
  });

  it('ensures viewer_pool_0 is spawned once on directory-loaded without transparent flag or setup contention', () => {
    const mainRs = fs.readFileSync(mainRsPath, 'utf-8');
    const viewerRs = fs.readFileSync(path.join(rootDir, 'src-tauri', 'src', 'viewer.rs'), 'utf-8');
    const setupBlock = mainRs.match(/\.setup\(move \|app\| \{[\s\S]*?Ok\(\(\)\)\s*\}\)/);
    expect(setupBlock).not.toBeNull();
    const setupCode = setupBlock[0];

    // setup 内では viewer_pool_0 を直接ビルドしないこと（メインウィンドウ初期化との競合回避）
    expect(setupCode).not.toMatch(/WindowBuilder::new\([\s\S]*?"viewer_pool_0"/);

    // directory-loaded 通知後に spawn_viewer_pool_once を呼ぶこと
    expect(mainRs).toContain('spawn_viewer_pool_once');

    // spawn_viewer_pool_once は AtomicBool による一度だけ生成と、transparent なしの非表示ビルドを行うこと
    const spawnBlock = viewerRs.match(/pub fn spawn_viewer_pool_once[\s\S]*?\n\}/);
    expect(spawnBlock).not.toBeNull();
    expect(spawnBlock[0]).toContain('viewer_pool_spawned');
    expect(spawnBlock[0]).toContain('compare_exchange');
    expect(spawnBlock[0]).toContain('"viewer_pool_0"');
    expect(spawnBlock[0]).toContain('.visible(false)');
    expect(spawnBlock[0]).not.toContain('.transparent(true)');
  });
});
