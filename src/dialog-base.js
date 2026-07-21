/**
 * 共通ダイアログの DOM シェルを生成します。
 * @returns {{ overlay: HTMLDivElement, dialog: HTMLDivElement, cleanup: () => void, bindEscape: (resolve: Function, value: *) => void }}
 */
export function createDialogShell() {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog-box';
  overlay.appendChild(dialog);

  let keydownHandler = null;

  const cleanup = () => {
    if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler);
      keydownHandler = null;
    }
    overlay.classList.remove('show');
    setTimeout(() => {
      if (document.body.contains(overlay)) {
        document.body.removeChild(overlay);
      }
    }, 200);
  };

  const bindEscape = (resolve, value) => {
    keydownHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
        resolve(value);
      }
    };
    document.addEventListener('keydown', keydownHandler);
  };

  return { overlay, dialog, cleanup, bindEscape };
}

/**
 * ダイアログ用ボタン行を生成します。
 * @param {Array<{ label: string, className: string, value: * }>} buttons
 * @param {{ wrap?: boolean, focusIndex?: number }} [options]
 */
export function createDialogButtons(buttons, options = {}) {
  const buttonsDiv = document.createElement('div');
  buttonsDiv.className = options.wrap ? 'dialog-buttons dialog-buttons--wrap' : 'dialog-buttons';

  const elements = buttons.map(({ label, className }, index) => {
    const btn = document.createElement('button');
    btn.className = className;
    btn.textContent = label;
    buttonsDiv.appendChild(btn);
    if (options.focusIndex === index) btn.focus();
    return btn;
  });

  return {
    buttonsDiv,
    bind(resolve, cleanup) {
      buttons.forEach(({ value }, i) => {
        elements[i].addEventListener('click', () => {
          cleanup();
          resolve(value);
        });
      });
    }
  };
}

/**
 * メッセージ要素を生成します。
 * @param {string} message
 * @param {{ html?: boolean, className?: string }} [options]
 */
export function createDialogMessage(message, options = {}) {
  const messageEl = document.createElement('div');
  messageEl.className = options.className || 'dialog-message';
  if (options.html) {
    messageEl.innerHTML = message;
  } else {
    messageEl.textContent = message;
  }
  return messageEl;
}

/**
 * ダイアログを表示して結果を返します。
 * @param {{ message?: string, messageHtml?: string, messageClassName?: string, extraNodes?: HTMLElement[], buttons: Array<{ label: string, className: string, value: * }>, buttonsWrap?: boolean, escapeValue: *, focusIndex?: number }} config
 */
export function showAppDialog(config) {
  return new Promise((resolve) => {
    const { overlay, dialog, cleanup, bindEscape } = createDialogShell();

    if (config.messageHtml) {
      dialog.appendChild(createDialogMessage(config.messageHtml, { html: true, className: config.messageClassName }));
    } else if (config.message) {
      dialog.appendChild(createDialogMessage(config.message, { className: config.messageClassName }));
    }

    if (config.extraNodes) {
      for (const node of config.extraNodes) dialog.appendChild(node);
    }

    const { buttonsDiv, bind } = createDialogButtons(config.buttons, {
      wrap: config.buttonsWrap,
      focusIndex: config.focusIndex ?? 0
    });
    dialog.appendChild(buttonsDiv);

    bindEscape(resolve, config.escapeValue);
    bind(resolve, cleanup);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('show');
    });
  });
}
