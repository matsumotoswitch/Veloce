import { UIManager, ICON_SVGS, COLORS } from './renderer-ui.js';

/**
 * お気に入りまたはパスから表示名・アイコン・色を解決します。
 * @param {object|null} fav - お気に入りオブジェクト
 * @param {string|null} path - フォルダパス（お気に入りがない場合）
 * @returns {{ displayName: string, iconHtml: string, iconClass: string }}
 */
export function resolvePathDisplay(fav, path) {
  if (fav) {
    let iconHtml = '';
    let iconClass = 'icon-color-default';

    if (fav.icon && ICON_SVGS[fav.icon]) {
      iconHtml = ICON_SVGS[fav.icon];
      iconClass = `icon-color-${fav.color || 'default'}`;
    } else {
      const iconKey = fav.icon && fav.icon.startsWith('FAV_') ? fav.icon : 'FAV_STAR';
      iconHtml = UIManager.ICONS[iconKey] || UIManager.ICONS.FAV_STAR;
      if (fav.color) {
        iconClass = `icon-color-${fav.color}`;
      } else {
        iconClass = 'icon-color-default'; // Use CSS to handle fallback if needed
      }
    }

    return { displayName: fav.name, iconHtml, iconClass };
  }

  const displayName = path
    ? (path.split(/[/\\]/).filter(Boolean).pop() || path)
    : '';

  return {
    displayName,
    iconHtml: UIManager.ICONS.FOLDER,
    iconClass: 'icon-color-cyan'
  };
}
