export const INVALID_FILENAME_RE = /[\\/:*?"<>|]/;

/**
 * ファイル名・フォルダ名の妥当性を検証します。
 * @param {string} name
 * @param {string} [targetType='名前'] 対象の種別名（'ファイル名'、'フォルダ名'等）
 * @returns {{ valid: boolean, message: string }}
 */
export function validateFilename(name, targetType = '名前') {
  if (!name || name.trim() === '') {
    return { valid: false, message: `${targetType}を入力してください。` };
  }
  if (INVALID_FILENAME_RE.test(name)) {
    const prefix = targetType === '名前' ? '' : `${targetType}に`;
    return { valid: false, message: `${prefix}以下の文字は使用できません: \\ / : * ? " < > |` };
  }
  return { valid: true, message: '' };
}

/**
 * 指定されたパスのフォルダが存在するかを確認します。
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function checkPathExists(path) {
  if (!path || path === 'PC') return true;
  if (!window.veloceAPI?.pathExists) return true;
  try {
    return await window.veloceAPI.pathExists(path);
  } catch (e) {
    console.warn('Failed to check path existence:', e);
    return true;
  }
}


/**
 * 指定されたディレクトリパスの親ディレクトリパスを算出します。
 * ドライブルート（C:\ 等）、POSIXルート（/）、UNC共有ルート（\\server\share）、
 * 仮想パス（PC, smart://...）など、親ディレクトリが存在しない場合は null を返します。
 *
 * Windows ドライブ直下のサブフォルダ（例: C:\Users）の親は末尾バックスラッシュ付きの
 * ドライブルート（C:\）とし、それ以外の階層（例: C:\Users\Photos）の親は末尾区切り文字を
 * 持たないパス（C:\Users）として正規化します。
 *
 * @param {string} path 対象ディレクトリパス
 * @returns {string|null} 親ディレクトリパス（移動不可の場合は null）
 */
export function getParentDirectory(path) {
  if (typeof path !== 'string') return null;
  const raw = path.trim();
  if (!raw || raw === 'PC' || raw.startsWith('smart://')) {
    return null;
  }

  // 1. UNC パス (\\server\share\...)
  if (raw.startsWith('\\\\')) {
    const trimmed = raw.replace(/\\+$/g, '');
    const parts = trimmed.slice(2).split('\\').filter(Boolean);
    // \\server または \\server\share は共有ルートのため親なし
    if (parts.length <= 2) {
      return null;
    }
    return '\\\\' + parts.slice(0, -1).join('\\');
  }

  // 2. Windows ドライブパス (C:\..., C:/..., C:)
  if (/^[A-Za-z]:([\\/]|$)/.test(raw)) {
    const normalized = raw.replace(/\//g, '\\');
    const driveRoot = normalized.slice(0, 2) + '\\';
    const rest = normalized.slice(2).replace(/^\\+|\\+$/g, '');
    if (!rest) {
      return null;
    }
    const segments = rest.split('\\').filter(Boolean);
    if (segments.length <= 1) {
      return driveRoot;
    }
    return driveRoot + segments.slice(0, -1).join('\\');
  }

  // 3. POSIX パス (/a/b 等)
  if (raw.startsWith('/')) {
    const trimmed = raw.replace(/\/+$/g, '');
    if (!trimmed) {
      return null;
    }
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash <= 0) {
      return '/';
    }
    return trimmed.slice(0, lastSlash);
  }

  return null;
}
