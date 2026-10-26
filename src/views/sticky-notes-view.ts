import {
	Component,
	ItemView,
	MarkdownRenderer,
	Notice,
	setIcon,
	setTooltip,
	TFile,
	WorkspaceLeaf,
} from 'obsidian';
import type MyPlugin from '../main';
import {
	htmlToMarkdown,
	markdownToEditorHtml,
	normalizeEditorBlocks,
	normalizeEditorInlineTags,
} from '../services/editor-markdown';
import { parseStickyNotes } from '../services/note-parser';
import {
	appendStickyNote,
	updateStickyNoteInContent,
} from '../services/note-serializer';
import type { StickyNote } from '../types/note';

export const VIEW_TYPE_STICKY_NOTES = 'onenote-sticky-notes';

/** 程序自身窗口操作后，落地窗口事件（resize 等）的静默期（毫秒）。 */
const PROGRAMMATIC_WINDOW_OP_MS = 350;
/** 程序设置窗口后等待 IPC 落地再做最终校验的延迟（毫秒）。 */
const WINDOW_OP_SETTLE_MS = 120;
/** Electron 探测失败后的冷却期（毫秒），期间复用 null 不再重复探测。 */
const ELECTRON_PROBE_COOLDOWN_MS = 10000;

/**
 * 桌面端尝试取当前 popout 的 Electron BrowserWindow：setBounds 能一次
 * 原子调用同时设置位置和尺寸，无 moveTo/resizeTo 两段式 IPC 的中间瞬态
 * （表现为点击吸附时宽度"跳一下"）。新版 Electron 移除了 electron.remote，
 * 依次尝试 @electron/remote、electron.remote、window.electron.remote。
 * 探测失败返回 null（10 秒冷却，成功后按 window 缓存），调用方回退到
 * moveTo + 预补偿 resizeTo。
 */
const electronWindowCache = new WeakMap<Window, ElectronBrowserWindowLike>();
let electronProbeFailedAt = 0;

interface ElectronBrowserWindowLike {
	setBounds(bounds: {
		x: number;
		y: number;
		width: number;
		height: number;
	}): void;
}

/**
 * 桌面端尝试取当前 popout 的 Electron BrowserWindow：setBounds 能一次
 * 原子调用同时设置位置和尺寸，无 moveTo/resizeTo 两段式 IPC 的中间瞬态
 * （表现为点击吸附时宽度"跳一下"）。新版 Electron 移除了 electron.remote，
 * 依次尝试 @electron/remote、electron.remote、window.electron.remote。
 * 探测失败返回 null（10 秒冷却，期间走回退路径）。
 */
function resolveElectronWindow(win: Window): ElectronBrowserWindowLike | null {
	try {
		const candidate = win as unknown as {
			electron?: unknown;
			require?: (module: string) => unknown;
		};
		const modules: unknown[] = [];
		if (typeof candidate.require === 'function') {
			try {
				modules.push(candidate.require('@electron/remote'));
			} catch {
				/* 应用未打包该模块 */
			}
			try {
				modules.push(candidate.require('electron'));
			} catch {
				/* 渲染进程 require 不可用 */
			}
		}
		if (candidate.electron) {
			modules.push(candidate.electron);
		}
		for (const mod of modules) {
			const viaRemote = (
				mod as {
					remote?: { getCurrentWindow?: () => ElectronBrowserWindowLike | null };
				} | null
			)?.remote?.getCurrentWindow?.();
			if (viaRemote) {
				return viaRemote;
			}
			const viaDirect = (
				mod as {
					getCurrentWindow?: () => ElectronBrowserWindowLike | null;
				} | null
			)?.getCurrentWindow?.();
			if (viaDirect) {
				return viaDirect;
			}
		}
		return null;
	} catch {
		return null;
	}
}

function getElectronWindow(win: Window): ElectronBrowserWindowLike | null {
	const cached = electronWindowCache.get(win);
	if (cached) return cached;
	if (
		electronProbeFailedAt > 0 &&
		Date.now() - electronProbeFailedAt < ELECTRON_PROBE_COOLDOWN_MS
	) {
		return null;
	}
	const resolved = resolveElectronWindow(win);
	if (resolved) {
		electronWindowCache.set(win, resolved);
	} else {
		electronProbeFailedAt = Date.now();
	}
	return resolved;
}

export class StickyNotesView extends ItemView {
	private readonly plugin: MyPlugin;
	private searchQuery = '';
	private notes: StickyNote[] = [];
	private collectionFile: TFile | null = null;
	private notesScrollEl: HTMLElement | null = null;
	private refreshVersion = 0;
	private editingCardEl: HTMLElement | null = null;
	private snapButtonEl: HTMLButtonElement | null = null;
	private snapSavedPosition: { left: number; top: number } | null = null;
	private headerDragCleanup: (() => void) | null = null;
	/**
	 * 窗口尺寸的唯一可信来源：手动调整或设置解析时更新，程序操作只
	 * 读不写回。绝不用 win.outerWidth 当"当前尺寸"——读回值经 DPI
	 * 取整可能每次 +1px，写回会形成棘轮式变大。
	 */
	private trackedSize: { width: number; height: number } | null = null;
	/** resizeTo 请求值与实际结果的固定偏差（DPI 取整等）。积分式累积
	 * 学习：每次校验把新误差累加进来，完美落地不清零，避免补偿量
	 * 在"有/无"之间振荡（表现为点吸附时尺寸跳一下再恢复）。 */
	private resizeDrift: { width: number; height: number } = {
		width: 0,
		height: 0,
	};
	/** 该时间戳之前收到的 resize 事件都是程序自身操作，不当作手动调整。 */
	private programmaticOpUntil = 0;
	/** 窗口尺寸校验的序号：新校验使旧校验定时器作废，防止堆积误判。 */
	private boundsVerifySeq = 0;
	/** 标题栏拖动进行中：此期间跳过尺寸校验，避免逐帧校正打架。 */
	private isDraggingWindow = false;
	private sizeCaptureTimer: number | null = null;
	private sizePersistTimer: number | null = null;
	private sizeTimerWin: Window | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_STICKY_NOTES;
	}

	getDisplayText(): string {
		return 'Sticky Notes';
	}

	getIcon(): string {
		return 'sticky-note';
	}

	async onOpen(): Promise<void> {
		this.containerEl.addClass('onenote-sticky-notes-container');
		this.containerEl.ownerDocument.body.addClass('onenote-sticky-notes-popout');
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file.path === this.plugin.settings.collectionFile) {
					void this.refresh();
				}
			}),
		);
		this.setupWindowResizeTracking();
		await this.refresh();
	}

	onClose(): Promise<void> {
		this.headerDragCleanup?.();
		this.headerDragCleanup = null;
		if (this.sizeCaptureTimer !== null && this.sizeTimerWin) {
			this.sizeTimerWin.clearTimeout(this.sizeCaptureTimer);
			this.sizeCaptureTimer = null;
		}
		if (this.sizePersistTimer !== null && this.sizeTimerWin) {
			this.sizeTimerWin.clearTimeout(this.sizePersistTimer);
			this.sizePersistTimer = null;
		}
		this.containerEl.ownerDocument.body.removeClass('onenote-sticky-notes-popout');
		this.containerEl.ownerDocument.body.removeClass('is-snapped');
		return Promise.resolve();
	}

	async refresh(): Promise<void> {
		const refreshVersion = ++this.refreshVersion;

		const filePath = this.plugin.settings.collectionFile;
		if (!filePath) {
			this.contentEl.empty();
			this.contentEl.addClass('onenote-sticky-notes-view');
			this.renderMessage('请先在插件设置中选择便笺集合文件。');
			return;
		}

		const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
		if (!(abstractFile instanceof TFile)) {
			this.contentEl.empty();
			this.contentEl.addClass('onenote-sticky-notes-view');
			this.renderMessage(`找不到便笺文件：${filePath}`);
			return;
		}

		const notes = parseStickyNotes(
			await this.app.vault.read(abstractFile),
			abstractFile.path,
		);
		if (refreshVersion !== this.refreshVersion) {
			return;
		}

		this.contentEl.empty();
		this.contentEl.addClass('onenote-sticky-notes-view');
		this.editingCardEl = null;
		this.notes = notes;
		this.collectionFile = abstractFile;
		this.editingCardEl = null;
		this.notesScrollEl = null;
		this.renderHeader(abstractFile.path, notes.length, abstractFile);
		this.renderNotes(notes, abstractFile);
	}

	private formatModifiedTime(timestamp: number): string {
		return new Intl.DateTimeFormat('zh-CN', {
			month: 'numeric',
			day: 'numeric',
		}).format(timestamp);
	}

	private formatShortPath(filePath: string): string {
		const segments = filePath.split('/');
		if (segments.length <= 2) {
			return filePath;
		}
		return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
	}

	private renderHeader(filePath: string, noteCount: number, file: TFile): void {
		const headerEl = this.contentEl.createDiv({ cls: 'onenote-sticky-notes-header' });
		const titleEl = headerEl.createDiv({ cls: 'onenote-sticky-notes-header-title' });
		titleEl.createEl('h2', { text: '最近的笔记' });
		titleEl.createEl('span', {
			text: `${noteCount} 条 · ${this.formatShortPath(filePath)}`,
			cls: 'onenote-sticky-notes-file-label',
		});

		const actionsEl = headerEl.createDiv({ cls: 'onenote-sticky-notes-actions' });
		const searchButton = actionsEl.createEl('button', {
			cls: 'onenote-sticky-notes-icon-button',
			attr: { type: 'button', 'aria-label': '搜索便笺' },
		});
		setIcon(searchButton, 'search');
		setTooltip(searchButton, '搜索便笺');

		const newButton = actionsEl.createEl('button', {
			cls: 'onenote-sticky-notes-icon-button onenote-sticky-notes-new-button',
			attr: { type: 'button', 'aria-label': '新建便笺' },
		});
		setIcon(newButton, 'plus');
		setTooltip(newButton, '新建便笺');
		newButton.addEventListener('click', () => void this.createNote(file));

		const snapButton = actionsEl.createEl('button', {
			cls: 'onenote-sticky-notes-icon-button onenote-sticky-notes-snap-button',
			text: '>',
			attr: { type: 'button', 'aria-label': '吸附右下角', 'aria-pressed': 'false' },
		});
		setTooltip(snapButton, '吸附右下角');
		this.snapButtonEl = snapButton;
		this.updateSnapButtonState();
		snapButton.addEventListener('click', () => this.toggleSnap());

		const searchEl = headerEl.createEl('input', {
			cls: 'onenote-sticky-notes-search',
			attr: { type: 'search', placeholder: '搜索便笺' },
		});
		searchEl.value = this.searchQuery;
		searchEl.toggleClass('is-visible', this.searchQuery.length > 0);
		searchButton.addEventListener('click', () => {
			const isVisible = !searchEl.hasClass('is-visible');
			searchEl.toggleClass('is-visible', isVisible);
			if (isVisible) {
				searchEl.focus();
			} else {
				searchEl.value = '';
				this.searchQuery = '';
				this.replaceResults();
			}
		});
		searchEl.addEventListener('input', () => {
			this.searchQuery = searchEl.value;
			this.replaceResults();
		});
		this.setupHeaderDrag(headerEl);
	}

	/**
	 * JS 指针拖动兜底：首选 styles.css 的原生 drag 区（标题栏 + 本插件
	 * 头部，交互子元素 no-drag）。原生 drag 区会吞掉区域内指针事件，
	 * 因此这套兜底只在原生 drag 区不可用的环境里才会收到事件并接管。
	 * 吸附后锁定不可拖动。主窗口（非 popout）内不启用——会拖动整个主窗。
	 */
	private setupHeaderDrag(headerEl: HTMLElement): void {
		this.headerDragCleanup?.();
		const win = this.leaf.getContainer().win;
		if (win === this.app.workspace.rootSplit.win) {
			// 运行在主窗口内：原生标题栏已可拖动窗口，无需 JS 兜底
			return;
		}
		const isInteractiveTarget = (target: EventTarget | null): boolean =>
			target instanceof Element &&
			!!target.closest(
				'button, input, .onenote-sticky-note-card, [contenteditable], .view-header',
			);

		const onPointerDown = (event: PointerEvent) => {
			if (this.snapSavedPosition) return;
			if (event.button !== 0) return;
			if (isInteractiveTarget(event.target)) return;
			event.preventDefault();
			const startX = event.screenX;
			const startY = event.screenY;
			const startWinX = win.screenX;
			const startWinY = win.screenY;
			// 尺寸恒用 trackedSize（仅首次未初始化时实测校准一次）
			const startSize = this.trackedSize ?? {
				width: win.outerWidth,
				height: win.outerHeight,
			};
			this.trackedSize = { ...startSize };
			this.isDraggingWindow = true;
			let pointerId: number | null = null;
			let raf = 0;
			let pendingX = 0;
			let pendingY = 0;
			let appliedX = 0;
			let appliedY = 0;
			// 绝对坐标 moveTo：每帧直接落到 startWin + 总位移，比增量
			// moveBy 更抗丢帧漂移；appliedX/Y 避免重复移动。
			const applyMove = () => {
				raf = 0;
				if (pendingX === appliedX && pendingY === appliedY) return;
				appliedX = pendingX;
				appliedY = pendingY;
				// 逐帧路径：Electron 可用时 setBounds 原子设位+尺寸；否则
				// 同步 moveTo/resizeTo（不排异步校正任务，避免每帧一个
				// 定时器），pointerup 收尾时统一校正。
				this.applyWindowBounds(
					win,
					startWinX + appliedX,
					startWinY + appliedY,
					startSize,
				);
			};
			const onPointerMove = (moveEvent: PointerEvent) => {
				if (pointerId !== null && moveEvent.pointerId !== pointerId) return;
				pendingX = moveEvent.screenX - startX;
				pendingY = moveEvent.screenY - startY;
				if (raf === 0) {
					raf = win.requestAnimationFrame(applyMove);
				}
			};
			const finish = () => {
				if (pointerId !== null) {
					try { headerEl.releasePointerCapture(pointerId); } catch { /* 已释放 */ }
				}
				win.removeEventListener('pointermove', onPointerMove);
				win.removeEventListener('pointerup', finish);
				win.removeEventListener('pointercancel', finish);
				if (raf !== 0) win.cancelAnimationFrame(raf);
				applyMove();
				this.isDraggingWindow = false;
				// 拖动结束后统一校验一次最终落地尺寸
				this.verifyBoundsLater(win, startSize);
			};
			try {
				headerEl.setPointerCapture(event.pointerId);
				pointerId = event.pointerId;
			} catch {
				pointerId = null;
			}
			win.addEventListener('pointermove', onPointerMove);
			win.addEventListener('pointerup', finish);
			win.addEventListener('pointercancel', finish);
		};
		headerEl.addEventListener('pointerdown', onPointerDown);
		this.headerDragCleanup = () => {
			headerEl.removeEventListener('pointerdown', onPointerDown);
		};
	}

	private replaceResults(): void {
		this.contentEl
			.querySelector('.onenote-sticky-notes-scroll, .onenote-sticky-notes-message')
			?.remove();
		this.editingCardEl = null;
		this.notesScrollEl = null;
		if (this.collectionFile) {
			this.renderNotes(this.notes, this.collectionFile);
		}
	}

	private renderNotes(notes: StickyNote[], file: TFile): void {
		const query = this.searchQuery.trim().toLocaleLowerCase();
		const filteredNotes = query
			? notes.filter((note) =>
				`${note.title}\n${note.body}`.toLocaleLowerCase().includes(query),
			)
			: notes;

		if (filteredNotes.length === 0) {
			this.renderMessage(query ? '没有匹配的便笺。' : '文件中还没有二级标题便笺。');
			return;
		}

		const scrollEl =
			this.notesScrollEl ??
			this.contentEl.createDiv({ cls: 'onenote-sticky-notes-scroll' });
		scrollEl.empty();
		this.notesScrollEl = scrollEl;

		const listEl = scrollEl.createDiv({ cls: 'onenote-sticky-notes-list' });
		const newestFirst = [...filteredNotes].sort(
			(left, right) => right.index - left.index,
		);
		for (const note of newestFirst) {
			void this.renderCard(listEl, note, file);
		}
	}

	private async renderCard(
		containerEl: HTMLElement,
		note: StickyNote,
		file: TFile,
	): Promise<void> {
		const cardEl = containerEl.createDiv({ cls: 'onenote-sticky-note-card' });
		await this.renderStaticCard(cardEl, note, file);
	}

	private async renderStaticCard(
		cardEl: HTMLElement,
		note: StickyNote,
		file: TFile,
	): Promise<void> {
		cardEl.empty();
		cardEl.removeClass('onenote-sticky-note-card-editing');
		cardEl.createDiv({ cls: 'onenote-sticky-note-card-bar' });

		const metaEl = cardEl.createDiv({ cls: 'onenote-sticky-note-card-meta' });
		metaEl.createEl('h3', { text: note.title });
		metaEl.createEl('time', {
			text: this.formatModifiedTime(file.stat.mtime),
			cls: 'onenote-sticky-note-card-date',
		});

		const bodyEl = cardEl.createDiv({ cls: 'onenote-sticky-note-card-body' });
		const component = new Component();
		this.addChild(component);
		await MarkdownRenderer.renderMarkdown(
			note.body || '（空便笺）',
			bodyEl,
			file.path,
			component,
		);
		cardEl.onclick = (event) => {
			const target = event.target as HTMLElement;
			if (target.closest('button, input, textarea, [contenteditable="true"]')) {
				return;
			}
			void this.renderEditor(cardEl, note, file);
		};
	}

	private async renderEditor(
		cardEl: HTMLElement,
		note: StickyNote,
		file: TFile,
	): Promise<void> {
		if (this.editingCardEl && this.editingCardEl !== cardEl) {
			const previousCard = this.editingCardEl;
			const previousNote = previousCard.dataset.noteId
				? this.notes.find((item) => item.id === previousCard.dataset.noteId)
				: undefined;
			if (previousNote && this.collectionFile) {
				await this.renderStaticCard(previousCard, previousNote, this.collectionFile);
			}
		}

		this.editingCardEl = cardEl;
		cardEl.dataset.noteId = note.id;
		cardEl.empty();
		cardEl.addClass('onenote-sticky-note-card-editing');
		cardEl.createDiv({ cls: 'onenote-sticky-note-card-bar' });

		const titleInput = cardEl.createEl('input', {
			cls: 'onenote-sticky-note-editor-title',
			attr: { type: 'text', placeholder: '便笺标题' },
		});
		titleInput.value = note.title;

		const bodyInput = cardEl.createDiv({
			cls: 'onenote-sticky-note-editor-body',
			attr: {
				contenteditable: 'true',
				role: 'textbox',
				'aria-label': '便笺正文',
				'data-placeholder': '写下便笺内容...',
			},
		});
		// 确定性渲染：与保存序列化严格互逆，保证 round-trip 不丢换行。
		// （此前复用 MarkdownRenderer，其 DOM 形状不受控。）
		markdownToEditorHtml(note.body, bodyInput);
		this.normalizeEditorInlineTags(bodyInput);
		this.placeCaretAtEnd(bodyInput);
		bodyInput.focus();
		const toolbarEl = cardEl.createDiv({ cls: 'onenote-sticky-note-editor-toolbar' });
		const formatButtons = new Map<string, HTMLButtonElement>();
		formatButtons.set(
			'bold',
			this.addFormatButton(toolbarEl, 'B', '加粗', bodyInput, 'bold'),
		);
		formatButtons.set(
			'italic',
			this.addFormatButton(toolbarEl, 'I', '斜体', bodyInput, 'italic'),
		);
		formatButtons.set(
			'underline',
			this.addFormatButton(toolbarEl, 'U', '下划线', bodyInput, 'underline'),
		);
		formatButtons.set(
			'strikeThrough',
			this.addFormatButton(toolbarEl, 'S', '删除线', bodyInput, 'strikeThrough'),
		);
		formatButtons.set('insertUnorderedList', this.addListButton(toolbarEl, bodyInput));
		const updateToolbarState = () =>
			this.updateToolbarState(bodyInput, formatButtons);
		bodyInput.addEventListener('input', updateToolbarState);
		bodyInput.addEventListener('keyup', updateToolbarState);
		bodyInput.addEventListener('mouseup', updateToolbarState);
		bodyInput.addEventListener('focus', updateToolbarState);
		this.registerDomEvent(bodyInput.ownerDocument, 'selectionchange', updateToolbarState);
		updateToolbarState();
		toolbarEl.createDiv({
			cls: 'onenote-sticky-note-editor-divider',
			attr: { 'aria-hidden': 'true' },
		});
		const cancelButton = toolbarEl.createEl('button', {
			text: '×',
			cls: 'onenote-sticky-note-action-button',
			attr: { type: 'button', 'aria-label': '取消编辑' },
		});
		const saveButton = toolbarEl.createEl('button', {
			text: '✓',
			cls: 'mod-cta onenote-sticky-note-action-button',
			attr: { type: 'button', 'aria-label': '保存便笺' },
		});
		cancelButton.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.refresh();
		});
		saveButton.addEventListener('click', (event) => {
			event.stopPropagation();
			this.normalizeEditorBlocks(bodyInput);
			void this.saveNote(
				file,
				note,
				titleInput.value,
				this.htmlToMarkdown(bodyInput),
				);
		});
	}

	private placeCaretAtEnd(element: HTMLElement): void {
		const selection = element.ownerDocument.getSelection();
		if (!selection) {
			return;
		}
		const walker = element.ownerDocument.createTreeWalker(
			element,
			NodeFilter.SHOW_TEXT,
		);
		let lastTextNode = walker.nextNode() as Text | null;
		while (walker.nextNode()) {
			lastTextNode = walker.currentNode as Text;
		}
		if (!lastTextNode) {
			element.focus();
			return;
		}
		const range = element.ownerDocument.createRange();
		range.setStart(lastTextNode, lastTextNode.textContent?.length ?? 0);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
	}

	/**
	 * 把编辑器内裸文本/行内节点规范化为 <p> 块：Chromium 的 contenteditable 在空容器中
	 * 输入产生裸文本，回车产生嵌套 <div>，均会导致序列化丢换行、"整行"定位失效。
	 * 实现见 services/editor-markdown.ts。
	 */
	private normalizeEditorBlocks(root: HTMLElement): void {
		normalizeEditorBlocks(root);
	}

	/**
	 * 把 Obsidian markdown 渲染器产出的行内标签归一（del→s 等），实现见
	 * services/editor-markdown.ts。
	 */
	private normalizeEditorInlineTags(root: HTMLElement): void {
		normalizeEditorInlineTags(root);
	}

	private addFormatButton(
		toolbarEl: HTMLElement,
		label: string,
		title: string,
		input: HTMLElement,
		command: string,
	): HTMLButtonElement {
		const button = toolbarEl.createEl('button', {
			text: label,
			cls: 'onenote-sticky-note-format-button',
			attr: { type: 'button', 'aria-label': title },
		});
		button.addEventListener('mousedown', (event) => event.preventDefault());
		button.addEventListener('click', (event) => {
			event.stopPropagation();
			this.toggleLineFormat(input, command);
		});
		return button;
	}

	private addListButton(toolbarEl: HTMLElement, input: HTMLElement): HTMLButtonElement {
		const button = toolbarEl.createEl('button', {
			text: '≡',
			cls: 'onenote-sticky-note-format-button',
			attr: { type: 'button', 'aria-label': '项目符号列表' },
		});
		button.addEventListener('mousedown', (event) => event.preventDefault());
		button.addEventListener('click', (event) => {
			event.stopPropagation();
			this.toggleLineFormat(input, 'insertUnorderedList');
		});
		return button;
	}

	private toggleLineFormat(input: HTMLElement, command: string): void {
		const lineElement = this.getCurrentLineElement(input);
		const selection = input.ownerDocument.getSelection();
		if (!lineElement || !selection) {
			return;
		}

		const caretOffset = this.getTextOffset(input, selection.anchorNode, selection.anchorOffset);
		const lineRange = input.ownerDocument.createRange();
		lineRange.selectNodeContents(lineElement);
		selection.removeAllRanges();
		selection.addRange(lineRange);
		input.ownerDocument.execCommand(command);
		this.restoreCaret(input, caretOffset);
		this.updateToolbarState(input, this.getFormatButtons(input));
	}

	private getFormatButtons(input: HTMLElement): Map<string, HTMLButtonElement> {
		const buttons = new Map<string, HTMLButtonElement>();
		const toolbar = input.parentElement?.querySelector('.onenote-sticky-note-editor-toolbar');
		if (!toolbar) {
			return buttons;
		}
		const formatButtons = toolbar.querySelectorAll<HTMLButtonElement>(
			'.onenote-sticky-note-format-button',
		);
		const formats = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList'];
		formatButtons.forEach((button, index) => {
			const format = formats[index];
			if (format) {
				buttons.set(format, button);
			}
		});
		return buttons;
	}

	private getCurrentLineElement(input: HTMLElement): HTMLElement | null {
		const selection = input.ownerDocument.getSelection();
		const anchorNode = selection?.anchorNode;
		const anchorElement = anchorNode instanceof HTMLElement
			? anchorNode
			: anchorNode?.parentElement;
		if (!anchorElement || !input.contains(anchorElement)) {
			return null;
		}

		return (
			anchorElement.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, div') ??
			input
		);
	}

	private getTextOffset(lineElement: HTMLElement, node: Node | null, offset: number): number {
		if (!node || !lineElement.contains(node)) {
			return 0;
		}
		const range = lineElement.ownerDocument.createRange();
		range.selectNodeContents(lineElement);
		range.setEnd(node, offset);
		return range.toString().length;
	}

	private restoreCaret(lineElement: HTMLElement, offset: number): void {
		const selection = lineElement.ownerDocument.getSelection();
		if (!selection) {
			return;
		}
		const walker = lineElement.ownerDocument.createTreeWalker(
			lineElement,
			NodeFilter.SHOW_TEXT,
		);
		let remaining = offset;
		let textNode = walker.nextNode();
		while (textNode) {
			const length = textNode.textContent?.length ?? 0;
			if (remaining <= length) {
				const range = lineElement.ownerDocument.createRange();
				range.setStart(textNode, remaining);
				range.collapse(true);
				selection.removeAllRanges();
				selection.addRange(range);
				return;
			}
			remaining -= length;
			textNode = walker.nextNode();
		}
	}

	private updateToolbarState(
		input: HTMLElement,
		buttons: Map<string, HTMLButtonElement>,
	): void {
		const selection = input.ownerDocument.getSelection();
		const anchorNode = selection?.anchorNode;
		const anchorElement = anchorNode instanceof HTMLElement
			? anchorNode
			: anchorNode?.parentElement;
		const insideEditor = !!anchorElement && input.contains(anchorElement);

		const activeFormats = new Set<string>();
		const lineElement = insideEditor ? this.getCurrentLineElement(input) : null;
		if (lineElement) {
			if (this.lineHasFormat(lineElement, 'strong, b')) activeFormats.add('bold');
			if (this.lineHasFormat(lineElement, 'em, i')) activeFormats.add('italic');
			if (this.lineHasFormat(lineElement, 'u')) activeFormats.add('underline');
			if (this.lineHasFormat(lineElement, 'del, s, strike')) activeFormats.add('strikeThrough');
			if (lineElement.closest('li')) activeFormats.add('insertUnorderedList');
		}

		for (const [format, button] of buttons) {
			button.toggleClass('is-active', activeFormats.has(format));
			button.setAttr('aria-pressed', activeFormats.has(format) ? 'true' : 'false');
		}
	}

	private lineHasFormat(lineElement: HTMLElement, selector: string): boolean {
		const textWalker = lineElement.ownerDocument.createTreeWalker(
			lineElement,
			NodeFilter.SHOW_TEXT,
		);
		let hasText = false;
		let textNode = textWalker.nextNode();
		while (textNode) {
			if ((textNode.textContent ?? '').length > 0) {
				hasText = true;
				const parent = textNode.parentElement;
				if (!parent?.closest(selector)) {
					return false;
				}
			}
			textNode = textWalker.nextNode();
		}
		return hasText;
	}

	/**
	 * 编辑器 DOM → Markdown（含硬换行处理），实现见 services/editor-markdown.ts。
	 */
	private htmlToMarkdown(element: HTMLElement): string {
		return htmlToMarkdown(element);
	}

	private async saveNote(
		file: TFile,
		note: StickyNote,
		title: string,
		body: string,
	): Promise<void> {
		try {
			await this.app.vault.process(file, (content) =>
				updateStickyNoteInContent(content, note.index, title, body),
			);
			await this.refresh();
		} catch (error) {
			console.error(error);
			new Notice('保存便笺失败。');
		}
	}

	private async createNote(file: TFile): Promise<void> {
		const now = new Date();
		const pad = (value: number) => String(value).padStart(2, '0');
		const title = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
		try {
			await this.app.vault.process(file, (content) =>
				appendStickyNote(content, title),
			);
			await this.refresh();
		} catch (error) {
			console.error(error);
			new Notice('新建便笺失败。');
		}
	}

	/**
	 * 统一的窗口位置+尺寸设置：先更新 trackedSize（可信值），再尝试
	 * Electron setBounds 原子调用；失败回退 moveTo + 预补偿 resizeTo。
	 * 无论哪条路径都标记"程序操作窗口"，让 resize 追踪器忽略本次
	 * 事件，并在稍后校验一次最终落地尺寸。
	 */
	private applyWindowBounds(
		win: Window,
		x: number,
		y: number,
		size: { width: number; height: number },
	): void {
		this.trackedSize = { ...size };
		this.programmaticOpUntil = Date.now() + PROGRAMMATIC_WINDOW_OP_MS;
		const targetX = Math.round(x);
		const targetY = Math.round(y);
		const electronWindow = getElectronWindow(win);
		if (electronWindow) {
			try {
				electronWindow.setBounds({
					x: targetX,
					y: targetY,
					width: size.width,
					height: size.height,
				});
				this.verifyBoundsLater(win, size);
				return;
			} catch {
				/* setBounds 抛错则走回退路径 */
			}
		}
		win.moveTo(targetX, targetY);
		this.resizeWindowTo(win, size.width, size.height);
		this.verifyBoundsLater(win, size);
	}

	/** resizeTo 预补偿：扣除历史实测偏差，让实际结果落在目标值上。 */
	private resizeWindowTo(win: Window, width: number, height: number): void {
		win.resizeTo(width - this.resizeDrift.width, height - this.resizeDrift.height);
	}

	/**
	 * 程序设置窗口后延迟实测一次落地结果：发现偏差就积分式累积到
	 * resizeDrift（下次预补偿）并补一次校正，确保最终尺寸精确等于
	 * 目标。防抖：新校验使旧校验作废；拖动进行中跳过；偏差过大视为
	 * 外部干扰（最小尺寸钳制、其他程序改窗口），不学习只重发。
	 */
	private verifyBoundsLater(win: Window, size: { width: number; height: number }): void {
		const seq = ++this.boundsVerifySeq;
		win.setTimeout(() => {
			if (seq !== this.boundsVerifySeq) return;
			if (this.isDraggingWindow) return;
			if (win.closed || !this.trackedSize) return;
			const driftWidth = win.outerWidth - size.width;
			const driftHeight = win.outerHeight - size.height;
			if (driftWidth === 0 && driftHeight === 0) return;
			const learnDrift = Math.abs(driftWidth) <= 4 && Math.abs(driftHeight) <= 4;
			if (learnDrift) {
				this.resizeDrift = {
					width: this.resizeDrift.width + driftWidth,
					height: this.resizeDrift.height + driftHeight,
				};
			}
			this.programmaticOpUntil = Date.now() + PROGRAMMATIC_WINDOW_OP_MS;
			this.resizeWindowTo(win, size.width, size.height);
		}, WINDOW_OP_SETTLE_MS);
	}

	/**
	 * 监听窗口 resize：用户手动调整时把实测尺寸写入 trackedSize 并
	 * 节流持久化到插件设置（下次打开保持该尺寸）。程序自身操作
	 * （programmaticOpUntil 时间戳内）不当作手动调整。
	 */
	private setupWindowResizeTracking(): void {
		const win = this.leaf.getContainer().win;
		if (win === this.app.workspace.rootSplit.win) return;
		this.sizeTimerWin = win;
		const onResize = () => {
			if (Date.now() < this.programmaticOpUntil) return;
			if (win.closed) return;
			if (this.sizeCaptureTimer !== null) {
				win.clearTimeout(this.sizeCaptureTimer);
			}
			this.sizeCaptureTimer = win.setTimeout(() => {
				this.sizeCaptureTimer = null;
				if (win.closed) return;
				this.trackedSize = { width: win.outerWidth, height: win.outerHeight };
				this.schedulePersistWindowSize();
			}, 250);
		};
		win.addEventListener('resize', onResize);
		this.register(() => win.removeEventListener('resize', onResize));
	}

	/** 手动调整的尺寸节流写入设置，下次打开便笺窗口即保持该尺寸。 */
	private schedulePersistWindowSize(): void {
		if (!this.trackedSize) return;
		const win = this.sizeTimerWin ?? this.leaf.getContainer().win;
		if (this.sizePersistTimer !== null && win) {
			win.clearTimeout(this.sizePersistTimer);
		}
		if (!win || win.closed) return;
		this.sizePersistTimer = win.setTimeout(() => {
			this.sizePersistTimer = null;
			const size = this.trackedSize;
			if (!size) return;
			this.plugin.settings.popoutWidth = size.width;
			this.plugin.settings.popoutHeight = size.height;
			void this.plugin.saveSettings();
		}, 1000);
	}

	/**
	 * 吸附开关：吸附前记住当前位置，取消时恢复位置、尺寸恒用
	 * trackedSize（吸附/取消/拖动间穿梭也绝不改变窗口尺寸）。
	 */
	toggleSnap(): void {
		const win = this.leaf.getContainer().win;
		if (this.snapSavedPosition) {
			const { left, top } = this.snapSavedPosition;
			this.snapSavedPosition = null;
			this.applyWindowBounds(win, left, top, this.getTargetSize());
		} else {
			this.snapSavedPosition = {
				left: win.screenX,
				top: win.screenY,
			};
			this.snapToBottomRight();
		}
		this.updateSnapButtonState();
	}

	/**
	 * 解析窗口尺寸：设置值为 0 表示"自动"，按工作区比例自适应并
	 * 钳制在合理范围；正值直接使用。
	 */
	static resolveWindowSize(widthSetting: number, heightSetting: number): {
		width: number;
		height: number;
	} {
		if (widthSetting > 0 && heightSetting > 0) {
			return { width: widthSetting, height: heightSetting };
		}
		const availWidth =
			window.screen?.availWidth > 0 ? window.screen.availWidth : 1920;
		const availHeight =
			window.screen?.availHeight > 0 ? window.screen.availHeight : 1080;
		const autoWidth = Math.round(
			Math.min(560, Math.max(320, availWidth * 0.22)),
		);
		const autoHeight = Math.round(
			Math.min(840, Math.max(480, availHeight * 0.55)),
		);
		const width = widthSetting > 0 ? widthSetting : autoWidth;
		const height = heightSetting > 0 ? heightSetting : autoHeight;
		return { width, height };
	}

	setDefaultWindowSize(): void {
		this.applyWindowBounds(
			this.leaf.getContainer().win,
			this.leaf.getContainer().win.screenX,
			this.leaf.getContainer().win.screenY,
			this.getTargetSize(),
		);
	}

	/**
	 * 当前应使用的窗口尺寸：优先手动调整记下的 trackedSize，否则按
	 * 设置解析（0 = 自动按屏幕比例）。
	 */
	getTargetSize(): { width: number; height: number } {
		if (this.trackedSize) return { ...this.trackedSize };
		return StickyNotesView.resolveWindowSize(
			this.plugin.settings.popoutWidth,
			this.plugin.settings.popoutHeight,
		);
	}

	snapToBottomRight(): void {
		const win = this.leaf.getContainer().win;
		const screen = win.screen as Screen & {
			availLeft?: number;
			availTop?: number;
		};
		const margin = 24;
		const { width, height } = this.getTargetSize();
		const screenLeft = screen.availLeft ?? 0;
		const screenTop = screen.availTop ?? 0;
		const left = screenLeft + screen.availWidth - width - margin;
		const top = screenTop + screen.availHeight - height - margin;
		this.applyWindowBounds(win, Math.max(screenLeft, left), Math.max(screenTop, top), {
			width,
			height,
		});
	}

	private updateSnapButtonState(): void {
		this.snapButtonEl?.toggleClass('is-active', this.snapSavedPosition !== null);
		this.snapButtonEl?.setAttr(
			'aria-pressed',
			this.snapSavedPosition !== null ? 'true' : 'false',
		);
		this.containerEl.ownerDocument.body.toggleClass(
			'is-snapped',
			this.snapSavedPosition !== null,
		);
	}

	private renderMessage(message: string): void {
		this.contentEl.createDiv({
			text: message,
			cls: 'onenote-sticky-notes-message',
		});
	}
}
