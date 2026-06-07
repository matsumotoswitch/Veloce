import { appState } from './renderer-state.js';
import { applyGlowEffect as glowElement } from './utils.js';
import { validateFilename, INVALID_FILENAME_RE } from './path-utils.js';
import { showAppDialog } from './dialog-base.js';
import { extractMetadataFields, parsePromptTags, formatRequestType } from './metadata-format.js';

const CHUNK_SIZE = 100;

export function formatSize(bytes) {
  if (bytes === undefined || bytes === null) return '-';
  return bytes.toLocaleString();
}

export function formatDate(timestamp) {
  if (!timestamp) return '-';
  // Rust側のUnixタイムスタンプ(秒)とJSのミリ秒の違いを吸収
  const ms = timestamp < 1000000000000 ? timestamp * 1000 : timestamp;
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}/${MM}/${dd} ${hh}:${mm}:${ss}`;
}

/**
 * メイン画面のUIとDOM操作を管理するクラス
 */
class UIManager {
  static ICONS = {
    DRIVE: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>`,
    FOLDER: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="none" fill="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
    FOLDER_OPEN: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`,
    FLAME: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/></svg>`,
    CHEVRON_LEFT: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" fill="none"/></svg>`,
    CHEVRON_RIGHT: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" fill="none"/></svg>`,
    CHEVRON_UP: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6" fill="none"/></svg>`,
    CHEVRON_DOWN: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" fill="none"/></svg>`,
    SORT_ASC: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 4px; vertical-align: middle;"><path d="m18 15-6-6-6 6" fill="none"/></svg>`,
    SORT_DESC: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 4px; vertical-align: middle;"><path d="m6 9 6 6 6-6" fill="none"/></svg>`,
    ERASER: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"></path><path d="M22 21H7"></path><path d="m5 11 9 9"></path></svg>`,
    COPY: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
    CLIPBOARD: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clipboard"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`,
    FOLDER_PLUS: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path><line x1="12" y1="10" x2="12" y2="16"></line><line x1="9" y1="13" x2="15" y2="13"></line></svg>`,
    EDIT: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`,
    TRASH: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>`,
    FILE_PLUS: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>`,
    FOLDER_PEN: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11.5V5a2 2 0 0 1 2-2h3.9c.7 0 1.3.3 1.7.9l.8 1.2c.4.6 1 .9 1.7.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9.5"/><path d="M11.378 13.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/></svg>`,
    FOLDER_X: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="m9.5 10.5 5 5"/><path d="m14.5 10.5-5 5"/></svg>`,
    FILE_PEN: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z"/></svg>`,
    FILE_X: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="m14.5 12.5-5 5"/><path d="m9.5 12.5 5 5"/></svg>`,
    X: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
    X_CIRCLE: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-circle"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`,
    ARROW_RIGHT_TO_LINE: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-right-to-line"><path d="M17 12H3"/><path d="m11 18 6-6-6-6"/><path d="M21 5v14"/></svg>`,
    STAR: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
    SORT: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="15" y1="18" x2="9" y2="18"></line><line x1="18" y1="11" x2="6" y2="11"></line><line x1="21" y1="4" x2="3" y2="4"></line></svg>`,
    FAV_STAR: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
    FAV_HEART: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`,
    FAV_CROWN: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/></svg>`,
    FAV_GEM: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 3 8 9l4 13 4-13-2.5-6"/><path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"/><path d="M2 9h20"/></svg>`,
    FAV_LAYERS: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>`,
    FAV_SUN: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`,
    FAV_MOON: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>`,
    FAV_FLOWER: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 16.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 1 1 4.5 4.5 4.5 4.5 0 1 1-4.5 4.5"/><path d="M12 7.5V9"/><path d="M7.5 12H9"/><path d="M16.5 12H15"/><path d="M12 16.5V15"/><path d="m8 8 1.88 1.88"/><path d="M14.12 9.88 16 8"/><path d="m8 16 1.88-1.88"/><path d="M14.12 14.12 16 16"/></svg>`,
    FAV_SWORDS: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/></svg>`,
    FAV_SHIELD_HALF: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 22V2"/></svg>`,
    FAV_CROSSHAIR: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/></svg>`,
    FAV_WAND_SPARKLES: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>`,
    FAV_BOT: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`,
    FAV_PAW_PRINT: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/></svg>`,
    FAV_GHOST: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg>`,
    FAV_SKULL: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="12" r="1"/></svg>`,
    FAV_BOOK_HEART: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M8.62 9.8A2.25 2.25 0 1 1 12 6.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a.998.998 0 0 1-1.507 0z"/></svg>`,
    FAV_BEER: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 11h1a3 3 0 0 1 0 6h-1"/><path d="M9 12v6"/><path d="M13 12v6"/><path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"/><path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/></svg>`,
    FAV_UTENSILS: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`,
    FAV_COFFEE: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/></svg>`,
    FAV_MIC_VOCAL: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12"/><path d="M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5"/><circle cx="16" cy="7" r="5"/></svg>`,
    FAV_MUSIC: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
    FAV_ANCHOR: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6v16"/><path d="m19 13 2-1a9 9 0 0 1-18 0l2 1"/><path d="M9 11h6"/><circle cx="12" cy="4" r="2"/></svg>`,
    FAV_CHESS_KNIGHT: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M16.5 18c1-2 2.5-5 2.5-9a7 7 0 0 0-7-7H6.635a1 1 0 0 0-.768 1.64L7 5l-2.32 5.802a2 2 0 0 0 .95 2.526l2.87 1.456"/><path d="m15 5 1.425-1.425"/><path d="m17 8 1.53-1.53"/><path d="M9.713 12.185 7 18"/></svg>`,
    CHECK: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    WINDOW_MINIMIZE: `<svg viewBox="0 0 10 10" width="12" height="12"><line x1="1" y1="5.5" x2="9" y2="5.5" stroke="currentColor" stroke-width="1"/></svg>`,
    WINDOW_MAXIMIZE: `<svg viewBox="0 0 10 10" width="12" height="12"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/></svg>`,
    WINDOW_RESTORE: `<svg viewBox="0 0 10 10" width="12" height="12"><rect x="1.5" y="3.5" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1"/><polyline points="3.5,3.5 3.5,1.5 8.5,1.5 8.5,6.5 6.5,6.5" fill="none" stroke="currentColor" stroke-width="1"/></svg>`,
    WINDOW_CLOSE: `<svg viewBox="0 0 10 10" width="12" height="12"><path d="M1.5,1.5 L8.5,8.5 M8.5,1.5 L1.5,8.5" stroke="currentColor" stroke-width="1"/></svg>`,
    RELOAD: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-refresh-cw"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`
  };

  /**
   * コピーボタンのHTMLを生成します。
   * @param {string} text コピー対象のテキスト
   * @returns {string} ボタンのHTML
   */
  static createCopyButtonHTML(text) {
    if (!text || text === '-') return '';
    const escaped = String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<span class="diff-copy-btn" title="コピー" data-copy-text="${escaped}">
        ${UIManager.ICONS.COPY}
      </span>`;
  }

  /**
   * @param {AppState} state - アプリケーション状態のインスタンス
   */
  constructor(state) {
    this.state = state;
    // 頻繁に操作するDOM要素はここで取得しておく
    /**
     * @type {{
     *   fileListBody: HTMLElement,
     *   thumbnailGrid: HTMLElement,
     *   dirTree: HTMLElement,
     *   thumbnailSizeSlider: HTMLInputElement,
     *   resizerLeft: HTMLElement,
     *   resizerRight: HTMLElement,
     *   resizerCenter: HTMLElement,
     *   searchBar: HTMLInputElement,
     *   searchClearBtn: HTMLElement,
     *   openCacheBtn: HTMLElement,
     *   clearCacheBtn: HTMLElement
     * }}
     */
    this.elements = {
      fileListBody: document.getElementById('file-list-body'),
      thumbnailGrid: document.getElementById('center-bottom'),
      dirTree: document.getElementById('dir-tree'),
      thumbnailSizeSlider: document.getElementById('thumbnail-size-slider'),
      resizerLeft: document.getElementById('resizer-left'),
      resizerRight: document.getElementById('resizer-right'),
      resizerCenter: document.getElementById('resizer-center'),
      searchBar: document.getElementById('search-bar'),
      searchClearBtn: document.getElementById('search-clear-btn'),
      openCacheBtn: document.getElementById('open-cache-btn'),
      clearCacheBtn: document.getElementById('clear-cache-btn')
    };
    this.toastContainer = document.getElementById('toast-container');
    this.initCustomTooltip();

    // スクロール時にツールチップを強制的に隠す
    window.addEventListener('scroll', () => this.hideCustomTooltip(), true);
  }

  // タブのスクロール状態をチェックし、グラデーションの表示/非表示を切り替える
  updateTabScrollState() {
    const container = document.getElementById('tab-container');
    const newTabBtn = document.getElementById('new-tab-btn');
    if (!container || !newTabBtn) return;

    const scrollRight = container.scrollWidth - container.clientWidth - container.scrollLeft;
    if (container.scrollWidth > container.clientWidth && scrollRight > 2) {
      newTabBtn.classList.add('is-overflowing');
    } else {
      newTabBtn.classList.remove('is-overflowing');
    }
  }

  renderTabs() {
    const container = document.getElementById('tab-container');
    if (!container) return;

    if (!this.state.tabs || this.state.tabs.length === 0) return;
    const newTabBtn = document.getElementById('new-tab-btn');

    // 「＋」ボタンへのドラッグ＆ドロップ対応（一番後ろへ移動）
    if (newTabBtn && !newTabBtn.dataset.dragInitialized) {
      newTabBtn.dataset.dragInitialized = 'true';
      newTabBtn.addEventListener('dragover', (e) => {
        if (!Array.from(e.dataTransfer.types).includes('application/json-tab')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const container = document.getElementById('tab-container');
        if (container) {
          container.querySelectorAll('.tab-item').forEach(item => {
            if (item !== newTabBtn) {
              item.classList.remove('drag-over-left', 'drag-over-right');
              item.style.zIndex = '';
            }
          });
        }
        newTabBtn.classList.add('drag-over-left');
      });
      newTabBtn.addEventListener('dragleave', (e) => {
        if (!Array.from(e.dataTransfer.types).includes('application/json-tab')) return;
        newTabBtn.classList.remove('drag-over-left');
      });
      newTabBtn.addEventListener('drop', (e) => {
        if (!Array.from(e.dataTransfer.types).includes('application/json-tab')) return;
        e.preventDefault();
        newTabBtn.classList.remove('drag-over-left');
        const fromIndexStr = e.dataTransfer.getData('application/json-tab');
        if (fromIndexStr && window.onTabMove) window.onTabMove(parseInt(fromIndexStr, 10), this.state.tabs.length - 1, true);
      });
    }

    // DOMの再生成を防ぎ、既存のタブ要素を再利用してアニメーションが途切れないようにする
    // 削除アニメーション中のタブ（.tab-fade-out）は再利用対象から除外する
    const existingTabs = Array.from(container.querySelectorAll('.tab-item:not(#new-tab-btn):not(.tab-fade-out)'));
    const tabCount = this.state.tabs.length;

    if (existingTabs.length > tabCount) {
      for (let i = tabCount; i < existingTabs.length; i++) {
        existingTabs[i].remove();
      }
      existingTabs.length = tabCount;
    }

    this.state.tabs.forEach((tab, index) => {
      let tabEl = existingTabs[index];

      if (!tabEl) {
        tabEl = document.createElement('div');
        tabEl.className = 'tab-item';
        tabEl.draggable = true;

        const label = document.createElement('span');
        label.className = 'tab-label';
        tabEl.appendChild(label);
        
        tabEl.addEventListener('mouseenter', (e) => {
          const currentTab = this.state.tabs[parseInt(tabEl.dataset.index, 10)];
          if (currentTab) this.showCustomTooltip(`${currentTab.name}\n${currentTab.path}`, e.clientX, e.clientY);
        });
        tabEl.addEventListener('mousemove', (e) => {
          const currentTab = this.state.tabs[parseInt(tabEl.dataset.index, 10)];
          if (currentTab) this.showCustomTooltip(`${currentTab.name}\n${currentTab.path}`, e.clientX, e.clientY);
        });
        tabEl.addEventListener('mouseleave', () => {
          this.hideCustomTooltip();
        });

        const closeBtn = document.createElement('span');
        closeBtn.className = 'tab-close-btn';
        closeBtn.innerHTML = `<svg viewBox="0 0 10 10" width="8" height="8"><path d="M1,1 L9,9 M9,1 L1,9" stroke="currentColor" stroke-width="1.5"/></svg>`;
        closeBtn.addEventListener('mouseenter', (e) => {
          e.stopPropagation();
          this.showCustomTooltip('タブを閉じる', e.clientX, e.clientY);
        });
        closeBtn.addEventListener('mousemove', (e) => {
          e.stopPropagation();
          this.showCustomTooltip('タブを閉じる', e.clientX, e.clientY);
        });
        closeBtn.addEventListener('mouseleave', (e) => {
          e.stopPropagation();
          this.hideCustomTooltip();
        });
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.hideCustomTooltip();
          if (window.onTabClose) window.onTabClose(parseInt(tabEl.dataset.index, 10));
        });
        tabEl.appendChild(closeBtn);

        tabEl.addEventListener('click', () => {
          if (window.onTabClick) window.onTabClick(parseInt(tabEl.dataset.index, 10));
        });
        
        tabEl.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
        
        tabEl.addEventListener('auxclick', (e) => {
          if (e.button === 1) { 
            e.stopPropagation();
            if (window.onTabClose) window.onTabClose(parseInt(tabEl.dataset.index, 10));
          }
        });

        tabEl.addEventListener('contextmenu', (e) => {
          if (window.onTabContextMenu) window.onTabContextMenu(e, parseInt(tabEl.dataset.index, 10));
        });

        tabEl.addEventListener('dragstart', (e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('application/json-tab', tabEl.dataset.index);
          setTimeout(() => { tabEl.style.opacity = '0.5'; }, 0); 
        });
        tabEl.addEventListener('dragend', (e) => {
          tabEl.style.opacity = '1';
          const container = document.getElementById('tab-container');
          if (container) {
            container.querySelectorAll('.tab-item').forEach(item => item.classList.remove('drag-over-left', 'drag-over-right'));
          }
        });
        tabEl.addEventListener('dragover', (e) => {
          if (!Array.from(e.dataTransfer.types).includes('application/json-tab')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          
          const container = document.getElementById('tab-container');
          if (container) {
            container.querySelectorAll('.tab-item').forEach(item => {
              if (item !== tabEl) {
                item.classList.remove('drag-over-left', 'drag-over-right');
                item.style.zIndex = '';
              }
            });
          }
          const rect = tabEl.getBoundingClientRect();
          const midX = rect.left + rect.width / 2;
          if (e.clientX < midX) {
            tabEl.classList.add('drag-over-left');
            tabEl.classList.remove('drag-over-right');
          } else {
            tabEl.classList.add('drag-over-right');
            tabEl.classList.remove('drag-over-left');
          }
          tabEl.style.zIndex = '3'; // ドロップインジケーターが他のタブやボタンに隠れないように最前面へ
        });
        tabEl.addEventListener('dragleave', (e) => {
          if (!Array.from(e.dataTransfer.types).includes('application/json-tab')) return;
          tabEl.classList.remove('drag-over-left', 'drag-over-right');
          tabEl.style.zIndex = '';
        });
        tabEl.addEventListener('drop', (e) => {
          if (!Array.from(e.dataTransfer.types).includes('application/json-tab')) return;
          e.preventDefault();
          tabEl.classList.remove('drag-over-left', 'drag-over-right');
          tabEl.style.zIndex = '';
          const fromIndexStr = e.dataTransfer.getData('application/json-tab');
          if (!fromIndexStr) return;
          const rect = tabEl.getBoundingClientRect();
          const midX = rect.left + rect.width / 2;
          if (window.onTabMove) window.onTabMove(parseInt(fromIndexStr, 10), parseInt(tabEl.dataset.index, 10), e.clientX >= midX);
        });

        if (newTabBtn) {
          container.insertBefore(tabEl, newTabBtn);
        } else {
          container.appendChild(tabEl);
        }
      }

      // --- 状態の更新 ---
      if (tab.isNew) {
        tabEl.classList.remove('tab-fade-in');
        void tabEl.offsetWidth; // リフローを強制してアニメーションを再トリガー
        tabEl.classList.add('tab-fade-in');
        tab.isNew = false;
      }

      // 再利用されたDOMに削除アニメーションのクラスやスタイルが残っていればリセット
      tabEl.classList.remove('tab-fade-out');
      tabEl.style.width = '';
      tabEl.style.minWidth = '';

      tabEl.dataset.index = index;

      if (index === this.state.activeTabIndex) {
        tabEl.classList.add('active');
      } else {
        tabEl.classList.remove('active');
      }

      const label = tabEl.querySelector('.tab-label');
      if (label && label.textContent !== tab.name) {
        label.textContent = tab.name;
      }
    });

    requestAnimationFrame(() => {
      this.updateTabScrollState();
    });
  }

  initCustomTooltip() {
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'custom-tooltip';
    document.body.appendChild(this.tooltipEl);
    this.isTooltipVisible = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
  }

  showCustomTooltip(text, x, y) {
    const tabMenu = document.getElementById('tab-list-menu');
    // タブ一覧メニューが開いている時はツールチップを出さず、メニューも消さない
    if (tabMenu && tabMenu.style.display === 'block') {
      return;
    }

    const ctxMenu = document.getElementById('context-menu');
    // コンテキストメニューが開いている時はツールチップを出さず、メニューも消さない
    if (ctxMenu && ctxMenu.style.display === 'block') {
      return;
    }

    this.isTooltipVisible = true;
    this.lastMouseX = x;
    this.lastMouseY = y;
    if (this.tooltipEl.textContent !== text) {
      this.tooltipEl.textContent = text;
    }

    // 前回の未実行のアニメーションフレームがあればキャンセル（重複実行による負荷を防止）
    if (this.tooltipRafId) {
      cancelAnimationFrame(this.tooltipRafId);
    }

    // DOMにテキストが反映された後にサイズを取得して位置を調整する
    this.tooltipRafId = requestAnimationFrame(() => {
      this.tooltipRafId = null; // 実行時にIDをクリア
      const rect = this.tooltipEl.getBoundingClientRect();
      let posX = x + 15;
      let posY = y + 15;

      // 画面外にはみ出さないよう調整
      if (posX + rect.width > window.innerWidth) posX = window.innerWidth - rect.width - 10;
      if (posY + rect.height > window.innerHeight) posY = window.innerHeight - rect.height - 10;

      this.tooltipEl.style.left = `${posX}px`;
      this.tooltipEl.style.top = `${posY}px`;
      this.tooltipEl.classList.add('show');
    });
  }

  hideCustomTooltip() {
    this.isTooltipVisible = false;
    
    if (this.tooltipRafId) {
      cancelAnimationFrame(this.tooltipRafId);
      this.tooltipRafId = null;
    }

    if (this.tooltipEl) {
      this.tooltipEl.classList.remove('show');
    }
  }

  /**
   * トースト通知を画面に表示します。
   * @param {string} message - 表示するメッセージ
   * @param {number} [duration=3000] - 表示する時間(ミリ秒)。0の場合は自動で消えません。
   * @param {string|null} [id=null] - トーストの一意なID。既存のトーストを更新する場合に使用。
   * @param {string} [type='info'] - トーストの種類 ('info', 'success', 'warning', 'error')
   */
  showToast(message, duration = 3000, id = null, type = 'info') {
    if (!this.toastContainer) {
      let container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
      }
      this.toastContainer = container;
    }

    let toast = id ? document.getElementById(`toast-${id}`) : null;

    if (toast) {
      toast.textContent = message;
      // Reset type classes
      toast.classList.remove('success', 'error', 'warning');
    } else {
      toast = document.createElement('div');
      toast.className = 'toast-message';
      if (id) toast.id = `toast-${id}`;
      toast.textContent = message;
      this.toastContainer.appendChild(toast);
    }

    if (type !== 'info') {
      toast.classList.add(type);
    }

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    if (toast.timeoutId) {
      clearTimeout(toast.timeoutId);
    }

    if (duration > 0) {
      toast.timeoutId = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
          if (toast.parentElement) toast.remove();
        }, 300);
      }, duration);
    }
  }

  /**
   * カスタムプロンプトダイアログを表示します。
   * @param {string} message 
   * @param {string} defaultValue 
   * @param {boolean} selectBaseNameOnly 
   * @returns {Promise<string|null>}
   */
  showPrompt(message, defaultValue = '', selectBaseNameOnly = false) {
    return new Promise((resolve) => {
      // ファイルリネーム時の拡張子保護用
      const originalExt = (selectBaseNameOnly && defaultValue.lastIndexOf('.') > 0)
        ? defaultValue.slice(defaultValue.lastIndexOf('.'))
        : '';

      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'dialog-box';

      const messageEl = document.createElement('div');
      messageEl.className = 'dialog-message has-input';
      messageEl.textContent = message;

      const inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.className = 'dialog-input';
      inputEl.value = defaultValue;
      inputEl.spellcheck = false;

      const warningEl = document.createElement('div');
      warningEl.className = 'dialog-warning';

      const inputContainer = document.createElement('div');
      inputContainer.className = 'dialog-input-group';
      inputContainer.appendChild(inputEl);
      inputContainer.appendChild(warningEl);

      const buttonsDiv = document.createElement('div');
      buttonsDiv.className = 'dialog-buttons';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'dialog-btn cancel';
      cancelBtn.textContent = 'キャンセル';

      const okBtn = document.createElement('button');
      okBtn.className = 'dialog-btn primary';
      okBtn.textContent = 'OK';

      buttonsDiv.appendChild(cancelBtn);
      buttonsDiv.appendChild(okBtn);

      dialog.appendChild(messageEl);
      dialog.appendChild(inputContainer);
      dialog.appendChild(buttonsDiv);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const cleanup = () => {
        if (document.body.contains(overlay)) {
          document.body.removeChild(overlay);
        }
      };

      const validateInput = () => {
        const result = validateFilename(inputEl.value);
        if (!result.valid) {
          warningEl.textContent = result.message;
          warningEl.classList.add('show');
          inputEl.classList.toggle('error', INVALID_FILENAME_RE.test(inputEl.value));
          okBtn.disabled = true;
        } else {
          warningEl.classList.remove('show');
          inputEl.classList.remove('error');
          okBtn.disabled = false;
        }
      };

      inputEl.addEventListener('input', validateInput);
      validateInput();

      inputEl.focus();
      if (selectBaseNameOnly && defaultValue.lastIndexOf('.') > 0) {
        inputEl.setSelectionRange(0, defaultValue.lastIndexOf('.'));
      } else {
        inputEl.select();
      }

      const finishPrompt = () => {
        if (!okBtn.disabled) {
          cleanup();
          let finalValue = inputEl.value;

          /**
           * ファイル名の変更において、誤って拡張子を変更または削除してしまうことを防ぐ保護機構。
           * selectBaseNameOnly が有効な場合は、変更後の値に元の拡張子を強制的に補完します。
           */
          if (selectBaseNameOnly && originalExt) {
            if (!finalValue.toLowerCase().endsWith(originalExt.toLowerCase())) {
              if (finalValue.includes('.')) {
                // 別の拡張子に変更された場合は、元の拡張子で上書きする
                finalValue = finalValue.slice(0, finalValue.lastIndexOf('.')) + originalExt;
              } else {
                // 拡張子が完全に削除された場合は補完する
                finalValue += originalExt;
              }
            }
          }

          resolve(finalValue);
        }
      };

      okBtn.addEventListener('click', finishPrompt);

      cancelBtn.addEventListener('click', () => {
        cleanup();
        resolve(null);
      });

      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finishPrompt();
        } else if (e.key === 'Escape') {
          cleanup();
          resolve(null);
        }
      });
    });
  }

  /**
   * 同名ファイルの競合時の処理を選択するダイアログを表示します。
   * @param {number} conflictCount 
   * @param {string} actionStr 
   * @returns {Promise<'overwrite'|'skip'|'cancel'>}
   */
  showConflictDialog(conflictCount, actionStr) {
    return showAppDialog({
      messageHtml: `宛先に同じ名前のファイルが <strong>${conflictCount}件</strong> 存在します。<br>どのように処理しますか？`,
      buttons: [
        { label: 'キャンセル', className: 'dialog-btn cancel', value: 'cancel' },
        { label: '重複をスキップ', className: 'dialog-btn primary', value: 'skip' },
        { label: `上書きして${actionStr}`, className: 'dialog-btn danger', value: 'overwrite' }
      ],
      buttonsWrap: true,
      escapeValue: 'cancel',
      focusIndex: 1
    });
  }

  /**
   * 存在しないフォルダのタブに切り替えようとした際のダイアログを表示します。
   * @param {string} path
   * @param {boolean} canCloseTab
   * @returns {Promise<'close'|'cancel'|'ok'>}
   */
  showMissingFolderDialog(path, canCloseTab) {
    const folderName = path.split('\\').pop() || path.split('/').pop() || path;
    const pathEl = document.createElement('div');
    pathEl.className = 'dialog-path';
    pathEl.textContent = path;

    const buttons = [
      { label: canCloseTab ? 'キャンセル' : 'OK', className: 'dialog-btn cancel', value: canCloseTab ? 'cancel' : 'ok' }
    ];
    if (canCloseTab) {
      buttons.push({ label: 'タブを閉じる', className: 'dialog-btn danger', value: 'close' });
    }

    return showAppDialog({
      messageHtml: `フォルダ「<strong>${folderName}</strong>」は存在しません。${canCloseTab ? '<br>このタブを閉じますか？' : ''}`,
      extraNodes: [pathEl],
      buttons,
      escapeValue: canCloseTab ? 'cancel' : 'ok',
      focusIndex: 0
    });
  }

  /**
   * カスタム確認ダイアログを表示します。
   * @param {string} message 
   * @returns {Promise<boolean>}
   */
  showConfirm(message) {
    return showAppDialog({
      message,
      buttons: [
        { label: 'キャンセル', className: 'dialog-btn cancel', value: false },
        { label: '削除', className: 'dialog-btn danger', value: true }
      ],
      escapeValue: false,
      focusIndex: 0
    });
  }

  /**
   * アイコンや要素を発光させます。
   * @param {HTMLElement} el 対象の要素
   */
  applyGlowEffect(el) {
    glowElement(el);
  }

  /**
   * リストとサムネイルグリッドの選択状態を表すUIを一括で更新します。
   */
  updateSelectionUI() {
    if (!this.elements.fileListBody || !this.elements.thumbnailGrid) {
      this.elements.fileListBody = document.getElementById('file-list-body');
      this.elements.thumbnailGrid = document.getElementById('center-bottom');
      if (!this.elements.fileListBody || !this.elements.thumbnailGrid) return;
    }

    // 全要素をループするのではなく、既に選択されている要素のクラスを外す
    const currentSelectedRows = this.elements.fileListBody.querySelectorAll('.selected');
    for (let i = 0; i < currentSelectedRows.length; i++) currentSelectedRows[i].classList.remove('selected');
    
    const currentSelectedThumbs = this.elements.thumbnailGrid.querySelectorAll('.selected');
    for (let i = 0; i < currentSelectedThumbs.length; i++) currentSelectedThumbs[i].classList.remove('selected');

    // 新たに選択された要素のみにクラスを付与する
    for (const i of this.state.selection) {
      const row = this.elements.fileListBody.querySelector(`tr[data-index="${i}"]`);
      if (row) row.classList.add('selected');
      
      // 仮想スクロール対応: DOMの順番ではなく、data-index属性を使って対象の画像を探す
      const thumb = this.elements.thumbnailGrid.querySelector(`.thumbnail-item[data-index="${i}"]`);
      if (thumb) thumb.classList.add('selected');
    }
  }

  /**
   * パネル（左右ペイン）の表示・非表示や幅を CSS 変数に反映してレイアウトを更新します。
   */
  applyLayout() {
    const root = document.documentElement;
    const lWidth = this.state.layout.leftVisible ? `${this.state.layout.leftWidth}px` : '0px';
    const rWidth = this.state.layout.rightVisible ? `${this.state.layout.rightWidth}px` : '0px';
    
    root.style.setProperty('--left-width', lWidth);
    root.style.setProperty('--right-width', rWidth);

    const lTopHeight = this.state.layout.leftTopVisible ? `${this.state.layout.leftTopHeight}px` : '0px';
    root.style.setProperty('--left-top-height', lTopHeight);

    const rTopHeight = this.state.layout.rightTopVisible ? `${this.state.layout.rightTopHeight}px` : '0px';
    root.style.setProperty('--right-top-height', rTopHeight);
  }

  /**
   * 2つの画像ファイルの全メタデータを比較表示します。
   * 全項目をプロンプトと同じテキストボックス形式で左右に並べて表示します。
   */
  showDiffModal(file1, file2, meta1 = {}, meta2 = {}) {
    const modal = document.getElementById('diff-modal');
    const container = document.getElementById('diff-container');
    if (!modal || !container) return;

    const parse = parsePromptTags;

    const d1 = extractMetadataFields(file1, meta1);
    const d2 = extractMetadataFields(file2, meta2);

    const renderSideBySideSection = (title, text1, text2, isParam = false, subLabel1 = null, subLabel2 = null) => {
      const v1 = text1 ?? '-';
      const v2 = text2 ?? '-';
      if (v1 === '-' && v2 === '-') return ''; 

      const tags1 = isParam ? [String(v1)] : parse(String(v1));
      const tags2 = isParam ? [String(v2)] : parse(String(v2));
      const set1 = new Set(tags1);
      const set2 = new Set(tags2);

      // 単純な文字列比較ではなく、パース・整理されたタグ配列の中身で比較する
      // これにより「末尾のスペース」や「余分なカンマ」だけの違いを無視できます
      const hasDiff = tags1.join(',') !== tags2.join(',');
      const titleClass = hasDiff ? 'has-diff' : '';

      const renderTags = (tags, otherSet, mode) => {
        if (tags.length === 0 || tags[0] === '-') return '<span style="opacity:0.3">なし</span>';
        return tags.map(t => {
          let className = 'common';
          if (mode === 'left' && !otherSet.has(t)) className = 'removed';
          if (mode === 'right' && !otherSet.has(t)) className = 'added';
          return `<span class="diff-tag ${className}">${t}</span>`;
        }).join('');
      };

      const boxClass = isParam ? "prompt-look param-box" : "prompt-look";

      const getSubLabelHtml = (sub) => {
        if (!sub || sub === 'Text to Image') return '';
        const labels = sub.split(' + ');
        const spans = labels.map(lbl => {
          let color = 'var(--text-color)';
          let opacity = '1';
          if (lbl.includes('Inpainting')) {
            color = '#4a9eff';
          } else if (lbl.includes('Vibe Transfer')) {
            color = '#d27aff';
          } else if (lbl.includes('Character Reference')) {
            color = '#ff9a4a';
          } else if (lbl.includes('Image to Image') || lbl.includes('Img2Img')) {
            color = '#4ade80';
          }
          return `<span style="font-size: 0.85em; color: ${color}; opacity: ${opacity}; font-weight: normal;">[${lbl}]</span>`;
        });
        return `<span style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">${spans.join('')}</span>`;
      };

      let sub1Html = getSubLabelHtml(subLabel1);
      let sub2Html = getSubLabelHtml(subLabel2);

      return `
        <div class="diff-columns">
          <div class="diff-column">
            <div class="diff-section">
              <h3 class="${titleClass}" style="display: flex; justify-content: space-between; align-items: center; user-select: none;">
                <span style="display: flex; align-items: center; gap: 8px;">
                  <span>${title}</span>
                  ${sub1Html}
                </span>
                ${UIManager.createCopyButtonHTML(v1)}
              </h3>
              <div class="${boxClass}">${renderTags(tags1, set2, 'left')}</div>
            </div>
          </div>
          <div class="diff-column">
            <div class="diff-section">
              <h3 class="${titleClass}" style="display: flex; justify-content: space-between; align-items: center; user-select: none;">
                <span style="display: flex; align-items: center; gap: 8px;">
                  <span>${title}</span>
                  ${sub2Html}
                </span>
                ${UIManager.createCopyButtonHTML(v2)}
              </h3>
              <div class="${boxClass}">${renderTags(tags2, set1, 'right')}</div>
            </div>
          </div>
        </div>
      `;
    };

    let contentHtml = '';
    contentHtml += renderSideBySideSection(
      'モデル / バージョン', 
      d1.source, 
      d2.source, 
      true,
      d1.requestType ? formatRequestType(d1.requestType) : null,
      d2.requestType ? formatRequestType(d2.requestType) : null
    );
    
    contentHtml += renderSideBySideSection('プロンプト', d1.prompt, d2.prompt);
    contentHtml += renderSideBySideSection('除外したい要素', d1.negativePrompt, d2.negativePrompt);

    const maxChars = Math.max(d1.chars.length, d2.chars.length);
    for (let i = 0; i < maxChars; i++) {
      const c1 = d1.chars[i] || { prompt: '', uc: '' };
      const c2 = d2.chars[i] || { prompt: '', uc: '' };
      contentHtml += renderSideBySideSection(`キャラクター ${i + 1} プロンプト`, c1.prompt, c2.prompt);
      contentHtml += renderSideBySideSection(`キャラクター ${i + 1} 除外したい要素`, c1.uc, c2.uc);
    }

    contentHtml += renderSideBySideSection('画像サイズ', d1.params.resolution, d2.params.resolution, true);
    contentHtml += renderSideBySideSection('シード値', d1.params.seed, d2.params.seed, true);
    contentHtml += renderSideBySideSection('ステップ', d1.params.steps, d2.params.steps, true);
    contentHtml += renderSideBySideSection('サンプラー', d1.params.sampler, d2.params.sampler, true);
    contentHtml += renderSideBySideSection('プロンプトガイダンス', d1.params.scale, d2.params.scale, true);
    contentHtml += renderSideBySideSection('プロンプトガイダンスの再調整', d1.params.cfg_rescale, d2.params.cfg_rescale, true);
    contentHtml += renderSideBySideSection('除外したい要素の強さ', d1.params.uncond_scale, d2.params.uncond_scale, true);
    contentHtml += renderSideBySideSection('生成パラメータ (Raw)', d1.params.rawParameters, d2.params.rawParameters);

    const src1 = window.veloceAPI.convertFileSrc(file1.path);
    const src2 = window.veloceAPI.convertFileSrc(file2.path);

    const headerHtml = `
      <div style="display: flex; gap: 15px; margin-bottom: 15px;">
        <div style="flex: 1; display: flex; flex-direction: column;">
          <div class="diff-thumbnail-container" style="margin-top: 0;">
            <img src="${src1}" class="diff-thumbnail" decoding="async">
          </div>
        </div>
        <div style="flex: 1; display: flex; flex-direction: column;">
          <div class="diff-thumbnail-container" style="margin-top: 0;">
            <img src="${src2}" class="diff-thumbnail" decoding="async">
          </div>
        </div>
      </div>
    `;

    container.innerHTML = headerHtml + contentHtml;

    container.querySelectorAll('.diff-copy-btn').forEach(btn => {
      btn.removeAttribute('title');
      btn.addEventListener('mouseenter', (e) => {
        this.showCustomTooltip('コピー', e.clientX, e.clientY);
      });
      btn.addEventListener('mousemove', (e) => {
        this.showCustomTooltip('コピー', e.clientX, e.clientY);
      });
      btn.addEventListener('mouseleave', () => {
        this.hideCustomTooltip();
      });
      btn.addEventListener('click', async (e) => {
        const target = e.currentTarget;
        const text = target.getAttribute('data-copy-text');
        if (text && text !== '-') {
          try {
            await navigator.clipboard.writeText(text);
            this.showToast("クリップボードにコピーしました", 3000, null, 'success');
            this.applyGlowEffect(target);
            this.hideCustomTooltip();
          } catch (err) {}
        }
      });
    });

    /**
     * Diff画面のドラッグ選択コピー時のフォーマット調整:
     * タグ単位で視覚的に分割されているテキストを選択してコピーする際、
     * クリップボードには自動的にカンマ区切りの文字列として格納します。
     * これによりプロンプトとしての再利用性を確保します。
     */
    container.querySelectorAll('.prompt-look').forEach(lookDiv => {
      lookDiv.addEventListener('copy', (e) => {
        const selection = window.getSelection();
        if (selection.isCollapsed) return;

        const clone = selection.getRangeAt(0).cloneContents();
        const tempDiv = document.createElement('div');
        tempDiv.appendChild(clone);

        const tags = tempDiv.querySelectorAll('.diff-tag');
        tags.forEach(tag => {
          tag.textContent = tag.textContent + ", ";
        });

        let copiedText = tempDiv.textContent;
        copiedText = copiedText.replace(/,\s*$/, '').trim();

        e.clipboardData.setData('text/plain', copiedText);
        e.preventDefault();
      });
    });

    modal.style.display = 'flex';

    // モーダルが表示されてレイアウトが計算された後にスクロールをリセットする
    requestAnimationFrame(() => {
      if (container.parentElement) {
        container.parentElement.scrollTop = 0;
      }
      container.scrollTop = 0;
      
      const diffModal = document.getElementById('diff-modal');
      if (diffModal) diffModal.scrollTop = 0;
    });
  }

  /**
   * ファイルリストとサムネイルグリッドの描画を非同期で行います。
   */
  async renderAll(resetScroll = false) {
    if (!this.elements.fileListBody || !this.elements.thumbnailGrid) {
      this.elements.fileListBody = document.getElementById('file-list-body');
      this.elements.thumbnailGrid = document.getElementById('center-bottom');
    }

    const renderId = ++this.state.currentRenderId;

    // 既存の画像の監視をすべて停止
    if (this.state.thumbnailObserver) {
        this.state.thumbnailObserver.disconnect();
    }

    if (this.elements.fileListBody) this.elements.fileListBody.innerHTML = '';
    
    // フォルダ選択時と同様に、タブ切り替え時等も以前のサムネイル表示を確実にクリアする
    if (this.elements.thumbnailGrid) {
      const content = this.elements.thumbnailGrid.querySelector('.virtual-content');
      if (content) content.innerHTML = '';
      const spacer = this.elements.thumbnailGrid.querySelector('.virtual-spacer');
      if (spacer) spacer.style.height = '0px';
    }

    const fileListContainer = document.getElementById('center-top');
    if (resetScroll) {
      if (fileListContainer) fileListContainer.scrollTop = 0;
      if (this.elements.thumbnailGrid) this.elements.thumbnailGrid.scrollTop = 0;
    }

    if (typeof this.updateVirtualList === 'function') {
      this.updateVirtualList(true);
    }

    if (typeof this.updateVirtualGrid === 'function') {
      this.updateVirtualGrid(true);
    }

    // バックグラウンド生成の再スタート
    if (!this.state.isPreloadRunning) {
      this.state.isPreloadRunning = true;
      if (typeof window.processNextTask === 'function') {
        setTimeout(window.processNextTask, 50);
      }
    }
  }

  async updateVirtualList(force = false) {
    if (!this.elements.fileListBody) return;
    const container = document.getElementById('center-top');
    const tbody = this.elements.fileListBody;

    if (!this._listScrollAttached && container) {
      container.addEventListener('scroll', () => {
        if (this._listScrollRaf) cancelAnimationFrame(this._listScrollRaf);
        this._listScrollRaf = requestAnimationFrame(() => this.updateVirtualList());
      }, { passive: true });
      this._listResizeObserver = new ResizeObserver(() => {
        if (this._listResizeRaf) cancelAnimationFrame(this._listResizeRaf);
        this._listResizeRaf = requestAnimationFrame(() => this.updateVirtualList(true));
      });
      this._listResizeObserver.observe(container);
      this._listScrollAttached = true;
    }

    if (appState.totalCount === 0) {
      tbody.innerHTML = '';
      this.lastListStartIndex = -1;
      this.lastListEndIndex = -1;
      return;
    }

    // <tr>の概算高さ（CSSのpaddingやborderを含む）
    const rowHeight = 28; 
    const totalRows = appState.totalCount;
    
    const scrollTop = container.scrollTop;
    const containerHeight = container.clientHeight || window.innerHeight;

    const startRow = Math.floor(Math.max(0, scrollTop) / rowHeight);
    const safeStartRow = Math.max(0, startRow - 5);
    const endRow = Math.min(totalRows - 1, startRow + Math.ceil(containerHeight / rowHeight) + 5);

    if (!force && this.lastListStartIndex === safeStartRow && this.lastListEndIndex === endRow) {
      return;
    }

    if (appState.dragState && appState.dragState.isAppDragging) {
      return;
    }

    this.lastListStartIndex = safeStartRow;
    this.lastListEndIndex = endRow;

    const topSpacerHeight = safeStartRow * rowHeight;
    const bottomSpacerHeight = (totalRows - 1 - endRow) * rowHeight;

    const fragment = document.createDocumentFragment();

    if (topSpacerHeight > 0) {
      const tr = document.createElement('tr');
      tr.style.height = `${topSpacerHeight}px`;
      tr.innerHTML = `<td colspan="6" style="padding: 0; border: none;"></td>`;
      fragment.appendChild(tr);
    }

    const items = await window.veloceAPI.getItems(safeStartRow, endRow - safeStartRow + 1);

    for (let i = safeStartRow; i <= endRow; i++) {
      const file = items[i - safeStartRow];
      if (!file) continue;
      const isSelected = appState.selection.has(i);
      const tr = document.createElement('tr');
      if (isSelected) tr.classList.add('selected');
      tr.dataset.index = i;
      tr.style.height = `${rowHeight}px`;
      tr.innerHTML = `
        <td>${file.name}</td>
        <td>${file.ext}</td>
        <td style="text-align: right;">${file.width ? file.width.toLocaleString() : '-'}</td>
        <td style="text-align: right;">${file.height ? file.height.toLocaleString() : '-'}</td>
        <td style="text-align: right;">${formatSize(file.size)}</td>
        <td>${formatDate(file.mtime)}</td>
      `;
      tr.draggable = true;
      fragment.appendChild(tr);
    }

    if (bottomSpacerHeight > 0) {
      const tr = document.createElement('tr');
      tr.style.height = `${bottomSpacerHeight}px`;
      tr.innerHTML = `<td colspan="6" style="padding: 0; border: none;"></td>`;
      fragment.appendChild(tr);
    }

    tbody.innerHTML = '';
    tbody.appendChild(fragment);
  }

  async updateVirtualGrid(force = false) {
    if (!this.elements.thumbnailGrid) return;
    const container = this.elements.thumbnailGrid;

    // 仮想スクロール用の初期化
    let content = container.querySelector('.virtual-content');
    let spacer = container.querySelector('.virtual-spacer');

    if (!content || !spacer) {
      container.innerHTML = `
        <div class="virtual-spacer" style="width: 1px; visibility: hidden; pointer-events: none;"></div>
        <div class="virtual-content" style="position: absolute; top: 0; left: 0; right: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--thumbnail-size), 1fr)); gap: 8px; padding: 0 8px; justify-content: center;"></div>
      `;
      content = container.querySelector('.virtual-content');
      spacer = container.querySelector('.virtual-spacer');

      container.style.position = 'relative';
      container.addEventListener('scroll', () => {
        if (this._gridScrollRaf) cancelAnimationFrame(this._gridScrollRaf);
        this._gridScrollRaf = requestAnimationFrame(() => this.updateVirtualGrid());
      }, { passive: true });
      this._gridResizeObserver = new ResizeObserver(() => {
        if (this._gridResizeRaf) cancelAnimationFrame(this._gridResizeRaf);
        this._gridResizeRaf = requestAnimationFrame(() => this.updateVirtualGrid(true));
      });
      this._gridResizeObserver.observe(container);
    }

    if (appState.totalCount === 0) {
      content.innerHTML = '';
      spacer.style.height = '0px';
      this.lastGridStartIndex = -1;
      this.lastGridEndIndex = -1;
      return;
    }

    const itemSize = parseFloat(this.elements.thumbnailSizeSlider?.value) || 120;
    const gap = 8;
    const padding = 8;
    const width = container.clientWidth - (padding * 2);

    // カラム数と行数の計算
    const cols = Math.max(1, Math.floor((width + gap) / (itemSize + gap)));
    const rows = Math.ceil(appState.totalCount / cols);
    const rowHeight = itemSize + gap;
    const totalHeight = rows * rowHeight + (padding * 2);

    spacer.style.height = `${totalHeight}px`;

    const scrollTop = container.scrollTop;
    const containerHeight = container.clientHeight || window.innerHeight;

    // 表示すべき行の計算 (上下に2行ずつのバッファ)
    const startRow = Math.floor(Math.max(0, scrollTop - padding) / rowHeight);
    const safeStartRow = Math.max(0, startRow - 2);
    const endRow = Math.min(rows - 1, startRow + Math.ceil(containerHeight / rowHeight) + 2);

    const startIndex = safeStartRow * cols;
    const endIndex = Math.min(appState.totalCount - 1, ((endRow + 1) * cols) - 1);

    // スクロール位置が変わっていなければスキップ
    if (!force && this.lastGridStartIndex === startIndex && this.lastGridEndIndex === endIndex) {
      return;
    }

    // ドラッグ中にDOMを再構築すると、ドラッグ元の要素が消滅して操作が強制キャンセルされるのを防ぐ
    if (appState.dragState && appState.dragState.isAppDragging) {
      return;
    }

    this.lastGridStartIndex = startIndex;
    this.lastGridEndIndex = endIndex;

    // コンテンツ領域をスクロール位置に合わせて移動 (Win8.1等のちらつき防止のため translate3d でハードウェアアクセラレーションを強制)
    const offsetY = (safeStartRow * rowHeight) + padding;
    content.style.transform = `translate3d(0, ${offsetY}px, 0)`;

    const items = await window.veloceAPI.getItems(startIndex, endIndex - startIndex + 1);

    // DOMの再構築
    content.innerHTML = '';
    const fragment = document.createDocumentFragment();

    for (let i = startIndex; i <= endIndex; i++) {
      const file = items[i - startIndex];
      if (!file) continue;

      const isSelected = appState.selection.has(i);
      const img = document.createElement('img');
      if (isSelected) img.classList.add('selected');
      img.decoding = "async";
      img.dataset.filepath = file.path;
      img.dataset.index = i;
      img.className = 'thumbnail-item';
      img.style.objectFit = 'contain';
      img.style.width = '100%';
      img.style.height = `${itemSize}px`;
      img.draggable = true;

      // 仮想スクロールでは常に表示領域内となるため直接フラグを立てる
      img.dataset.isVisible = 'true';

      if (appState.thumbnailUrls.has(file.path)) {
          img.src = appState.thumbnailUrls.get(file.path);
          if (typeof window.markThumbnailCompleted === 'function') window.markThumbnailCompleted(file.path);
      } else {
          img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
          if (!appState.pendingThumbnails.has(file.path)) {
            appState.pendingThumbnails.add(file.path);
            appState.thumbnailRequestQueue.push({ filePath: file.path, requestRenderId: appState.currentRenderId || Date.now() });
          }
      }
      fragment.appendChild(img);
    }
    content.appendChild(fragment);

    // 画像読み込みタスクをキック
    if (typeof window.processNextTask === 'function') window.processNextTask();
  }
}

export { UIManager };
export const uiManager = new UIManager(appState);

// --- お気に入りエディタ コンポーネント ---
export const ICON_SVGS = {
  'star': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-star"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>',
  'heart': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-heart"><path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/></svg>',
  'crown': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-crown"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/></svg>',
  'gem': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-gem"><path d="M10.5 3 8 9l4 13 4-13-2.5-6"/><path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"/><path d="M2 9h20"/></svg>',
  'layers': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-layers"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>',
  'sun': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
  'moon': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>',
  'flower': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flower"><circle cx="12" cy="12" r="3"/><path d="M12 16.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 1 1 4.5 4.5 4.5 4.5 0 1 1-4.5 4.5"/><path d="M12 7.5V9"/><path d="M7.5 12H9"/><path d="M16.5 12H15"/><path d="M12 16.5V15"/><path d="m8 8 1.88 1.88"/><path d="M14.12 9.88 16 8"/><path d="m8 16 1.88-1.88"/><path d="M14.12 14.12 16 16"/></svg>',
  'swords': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-swords"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/></svg>',
  'shield-half': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shield-half"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 22V2"/></svg>',
  'crosshair': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-crosshair"><circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/></svg>',
  'wand-sparkles': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-wand-sparkles"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>',
  'bot': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bot"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
  'paw-print': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-paw-print"><circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/></svg>',
  'ghost': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-ghost"><path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg>',
  'skull': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-skull"><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="12" r="1"/></svg>',
  'chess-knight': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chess-knight"><path d="M5 20a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M16.5 18c1-2 2.5-5 2.5-9a7 7 0 0 0-7-7H6.635a1 1 0 0 0-.768 1.64L7 5l-2.32 5.802a2 2 0 0 0 .95 2.526l2.87 1.456"/><path d="m15 5 1.425-1.425"/><path d="m17 8 1.53-1.53"/><path d="M9.713 12.185 7 18"/></svg>',
  'anchor': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-anchor"><path d="M12 6v16"/><path d="m19 13 2-1a9 9 0 0 1-18 0l2 1"/><path d="M9 11h6"/><circle cx="12" cy="4" r="2"/></svg>',
  'mic-vocal': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-mic-vocal"><path d="m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12"/><path d="M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5"/><circle cx="16" cy="7" r="5"/></svg>',
  'music': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-music"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  'book-heart': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-book-heart"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M8.62 9.8A2.25 2.25 0 1 1 12 6.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a.998.998 0 0 1-1.507 0z"/></svg>',
  'utensils': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-utensils"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>',
  'coffee': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-coffee"><path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/></svg>',
  'beer': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-beer"><path d="M17 11h1a3 3 0 0 1 0 6h-1"/><path d="M9 12v6"/><path d="M13 12v6"/><path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"/><path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/></svg>',
};

export const COLORS = [
  { id: 'default', hex: '#ececec' },
  { id: 'red',     hex: '#ef4444' },
  { id: 'blue',    hex: '#3b82f6' },
  { id: 'green',   hex: '#22c55e' },
  { id: 'yellow',  hex: '#eab308' },
  { id: 'purple',  hex: '#a855f7' },
  { id: 'pink',    hex: '#ec4899' },
  { id: 'cyan',    hex: '#06b6d4' }
];

export function createFavoriteEditorUI(containerElement, initialIcon = 'star', initialColor = 'default') {
  let selectedIconId = initialIcon;
  let selectedColorId = initialColor;

  containerElement.innerHTML = `
    <div class="favorite-icon-editor">
      <div style="font-size: 14px; margin-bottom: 8px; color: var(--text-color);">アイコンを選択</div>
      <div class="icon-grid" id="favIconGrid"></div>
      
      <div style="font-size: 14px; margin-top: 16px; margin-bottom: 8px; color: var(--text-color);">カラーを選択</div>
      <div class="color-grid" id="favColorGrid"></div>
    </div>
  `;

  const iconGrid = containerElement.querySelector('#favIconGrid');
  const colorGrid = containerElement.querySelector('#favColorGrid');

  Object.entries(ICON_SVGS).forEach(([id, svg]) => {
    const btn = document.createElement('button');
    btn.className = `icon-btn ${id === selectedIconId ? 'active' : ''}`;
    btn.innerHTML = svg;
    btn.dataset.icon = id;
    
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      iconGrid.querySelectorAll('.icon-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedIconId = id;
      updatePreviewColor();
    });
    iconGrid.appendChild(btn);
  });

  COLORS.forEach(color => {
    const btn = document.createElement('button');
    btn.className = `color-btn ${color.id === selectedColorId ? 'active' : ''}`;
    btn.style.backgroundColor = color.hex;
    btn.dataset.color = color.id;
    
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      colorGrid.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedColorId = color.id;
      updatePreviewColor();
    });
    colorGrid.appendChild(btn);
  });

  function updatePreviewColor() {
    iconGrid.querySelectorAll('.icon-btn').forEach(btn => {
      btn.classList.remove('icon-color-default', 'icon-color-red', 'icon-color-blue', 'icon-color-green', 'icon-color-yellow', 'icon-color-purple', 'icon-color-pink', 'icon-color-cyan');
      if (btn.classList.contains('active')) {
        btn.classList.add(`icon-color-${selectedColorId}`);
      }
    });
  }

  updatePreviewColor();

  return () => ({ icon: selectedIconId, color: selectedColorId });
}