import { UIManager, ICON_SVGS, COLORS } from './renderer-ui.js';

/**
 * お気に入りまたはパスから表示名・アイコン・色を解決します。
 * @param {object|null} fav - お気に入りオブジェクト
 * @param {string|null} path - フォルダパス（お気に入りがない場合）
 * @returns {{ displayName: string, iconHtml: string, iconColor: string }}
 */
export function resolvePathDisplay(fav, path) {
  if (fav) {
    let iconHtml = '';
    let iconColor = 'var(--glow-gold)';

    if (fav.icon && ICON_SVGS[fav.icon]) {
      iconHtml = ICON_SVGS[fav.icon];
      const c = COLORS.find(entry => entry.id === (fav.color || 'default'));
      iconColor = c ? c.hex : 'var(--glow-gold)';
    } else {
      const iconKey = fav.icon && fav.icon.startsWith('FAV_') ? fav.icon : 'FAV_STAR';
      iconHtml = UIManager.ICONS[iconKey] || UIManager.ICONS.FAV_STAR;
    }

    return { displayName: fav.name, iconHtml, iconColor };
  }

  const displayName = path
    ? (path.split(/[/\\]/).filter(Boolean).pop() || path)
    : '';

  return {
    displayName,
    iconHtml: UIManager.ICONS.FOLDER,
    iconColor: '#4da8da'
  };
}
