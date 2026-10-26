import { App, Modal } from 'obsidian';

export interface ConfirmModalOptions {
	title: string;
	message: string;
	confirmText: string;
	cancelText: string;
	/** 默认焦点放在取消上，避免误按回车执行破坏性操作。 */
	onConfirm: () => void;
}

/** 破坏性操作的轻量确认框（只用于确认，不做输入）。 */
export class ConfirmModal extends Modal {
	private readonly options: ConfirmModalOptions;

	constructor(app: App, options: ConfirmModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		this.titleEl.setText(this.options.title);
		this.contentEl.createEl('p', { text: this.options.message });

		const actionsEl = this.contentEl.createDiv({
			cls: 'onenote-sticky-notes-confirm-actions',
		});
		const cancelButton = actionsEl.createEl('button', {
			text: this.options.cancelText,
			attr: { type: 'button' },
		});
		cancelButton.addEventListener('click', () => this.close());
		cancelButton.focus();

		const confirmButton = actionsEl.createEl('button', {
			text: this.options.confirmText,
			cls: 'mod-warning',
			attr: { type: 'button' },
		});
		confirmButton.addEventListener('click', () => {
			this.close();
			this.options.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
