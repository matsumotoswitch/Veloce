export const INVALID_FILENAME_RE = /[\\/:*?"<>|]/;

/**
 * ファイル名・フォルダ名の妥当性を検証します。
 * @param {string} name
 * @returns {{ valid: boolean, message: string }}
 */
export function validateFilename(name) {
  if (!name || name.trim() === '') {
    return { valid: false, message: '名前を入力してください。' };
  }
  if (INVALID_FILENAME_RE.test(name)) {
    return { valid: false, message: '以下の文字は使用できません: \\ / : * ? " < > |' };
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
