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

  it('ensures viewer_pool_0 is created with a background delay to avoid WebView2 launch contention', () => {
    const mainRs = fs.readFileSync(mainRsPath, 'utf-8');
    const setupBlock = mainRs.match(/\.setup\(move \|app\| \{[\s\S]*?Ok\(\(\)\)\s*\}\)/);
    expect(setupBlock).not.toBeNull();
    const setupCode = setupBlock[0];

    // viewer_pool_0 がメインウィンドウと同時に同期生成されず、遅延スレッドで生成されること
    expect(setupCode).toContain('viewer_pool_0');
    expect(setupCode).toMatch(/std::thread::spawn\(move \|\| \{[\s\S]*?viewer_pool_0/);
    expect(setupCode).toMatch(/std::thread::sleep\(std::time::Duration::from_millis/);
  });
});
