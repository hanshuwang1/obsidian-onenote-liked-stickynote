import { Plugin, TFile, WorkspaceLeaf, WorkspaceTabs, WorkspaceWindow } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	MyPluginSettings,
	StickyNotesSettingTab,
} from './settings';
import {
	StickyNotesView,
	VIEW_TYPE_STICKY_NOTES,
} from './views/sticky-notes-view';

const FOREIGN_LEAF_EVICT_DELAY_MS = 250;

export default class MyPlugin extends Plugin {
	settings!: MyPluginSettings;
	private evictTimer: number | null = null;

	async onload() {
		// 必须在工作区恢复（layout-ready）之前注册视图，否则 Obsidian
		// 恢复上次的 popout 标签时找不到本插件视图，会先渲染成空白
		// markdown/普通标签页再切换，表现为"先闪一个普通标签页"。
		this.registerView(
			VIEW_TYPE_STICKY_NOTES,
			(leaf) => new StickyNotesView(leaf, this),
		);
		await this.loadSettings();

		this.addRibbonIcon('sticky-note', '打开便笺', () => {
			void this.activateView();
		});
		this.addCommand({
			id: 'open-sticky-notes',
			name: '打开便笺',
			callback: () => void this.activateView(),
		});
		this.addSettingTab(new StickyNotesSettingTab(this.app, this));

		// Startup hygiene: another plugin's startup "open remembered page"
		// (getLeaf(false).openFile) can drop a markdown tab into our popout's
		// hidden tab header, covering the sticky notes card view. Evict such
		// foreign leaves and restore their file to the main window if needed.
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.scheduleForeignLeafEviction();
			}),
		);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				// 外来标签一旦被激活（覆盖卡片视图的那一刻）立刻清走，
				// 不等 250ms 调度——用户不应看到普通标签页内容。
				if (this.isLeafInStickyPopout(leaf)) {
					void this.evictForeignLeavesFromStickyPopout();
				}
			}),
		);
		this.scheduleForeignLeafEviction();
	}

	async activateView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_STICKY_NOTES,
		)[0];
		const shouldSnap = !existingLeaf;
		const leaf =
			existingLeaf ??
			this.app.workspace.openPopoutLeaf(
				this.buildPopoutInitData(),
			);
		if (!leaf) {
			return;
		}

		await leaf.setViewState({ type: VIEW_TYPE_STICKY_NOTES, active: true });
		this.app.workspace.revealLeaf(leaf);
		void this.evictForeignLeavesFromStickyPopout();
		const view = leaf.view;
		if (shouldSnap && view instanceof StickyNotesView) {
			window.setTimeout(() => {
				view.setDefaultWindowSize();
				view.snapToBottomRight();
			}, 100);
		}
	}

	/**
	 * 官方 openPopoutLeaf 初始化参数：尺寸自适应屏幕（设置 0=自动），
	 * 位置右下角。Obsidian 内部把 size 钳制到 ≥600，精确尺寸由
	 * setDefaultWindowSize 在打开后修正。
	 */
	private buildPopoutInitData(): { x: number; y: number; size: { width: number; height: number } } {
		const { width, height } = StickyNotesView.resolveWindowSize(
			this.settings.popoutWidth,
			this.settings.popoutHeight,
		);
		const margin = 24;
		const availWidth = window.screen?.availWidth > 0 ? window.screen.availWidth : 1920;
		const availHeight = window.screen?.availHeight > 0 ? window.screen.availHeight : 1080;
		return {
			x: Math.round(Math.max(0, availWidth - width - margin)),
			y: Math.round(Math.max(0, availHeight - height - margin)),
			size: { width, height },
		};
	}

	refreshStickyNotesViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_STICKY_NOTES,
		)) {
			const view = leaf.view;
			if (view instanceof StickyNotesView) {
				void view.refresh();
			}
		}
	}

	private scheduleForeignLeafEviction(): void {
		if (this.evictTimer !== null) {
			return;
		}
		this.evictTimer = window.setTimeout(() => {
			this.evictTimer = null;
			void this.evictForeignLeavesFromStickyPopout();
		}, FOREIGN_LEAF_EVICT_DELAY_MS);
	}

	/**
	 * The sticky notes popout hides its tab header (styles.css), so it is
	 * single-purpose: any sibling leaf in its tab group is foreign debris
	 * (e.g. another plugin's startup openFile landing in the popout). Detach
	 * the debris; if it holds the only copy of a markdown file, reopen that
	 * file in the main window first so nothing is lost.
	 */
	/** 判断叶子是否位于便笺 popout 窗口内（非主窗口）。 */
	private isLeafInStickyPopout(leaf: WorkspaceLeaf | null): boolean {
		if (!leaf) return false;
		const container = leaf.getContainer();
		return (
			container instanceof WorkspaceWindow &&
			container.win !== this.app.workspace.rootSplit.win &&
			leaf.view?.getViewType?.() !== VIEW_TYPE_STICKY_NOTES
		);
	}

	private async evictForeignLeavesFromStickyPopout(): Promise<void> {
		const foreignLeaves: WorkspaceLeaf[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_STICKY_NOTES,
		)) {
			const parent = leaf.parent;
			if (!(parent instanceof WorkspaceTabs)) {
				continue;
			}
			const container = leaf.getContainer();
			if (!(container instanceof WorkspaceWindow)) {
				continue;
			}

			const siblings = (parent as unknown as { children?: unknown[] })
				.children;
			if (!Array.isArray(siblings)) {
				continue;
			}
			for (const child of [...siblings]) {
				const sibling = child as WorkspaceLeaf;
				if (
					sibling === leaf ||
					typeof sibling?.detach !== 'function' ||
					sibling.view?.getViewType?.() === VIEW_TYPE_STICKY_NOTES
				) {
					continue;
				}
				foreignLeaves.push(sibling);
			}
		}
		for (const sibling of foreignLeaves) {
			await this.evictForeignLeaf(sibling);
		}
	}

	private async evictForeignLeaf(leaf: WorkspaceLeaf): Promise<void> {
		try {
			const file = (leaf.view as unknown as { file?: TFile | null })
				?.file;
			if (file instanceof TFile && !this.isFileOpenInMainWindow(file)) {
				await this.openFileInMainWindow(file);
			}
			leaf.detach();
		} catch (error) {
			console.error(
				'[onenote-sticky-notes] failed to evict foreign leaf from popout:',
				error,
			);
		}
	}

	private isFileOpenInMainWindow(file: TFile): boolean {
		let openElsewhere = false;
		this.app.workspace.iterateRootLeaves((other) => {
			const otherFile = (other.view as unknown as { file?: TFile | null })
				?.file;
			if (otherFile === file) {
				openElsewhere = true;
			}
		});
		return openElsewhere;
	}

	private async openFileInMainWindow(file: TFile): Promise<void> {
		const rootLeaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateRootLeaves((leaf) => {
			rootLeaves.push(leaf);
		});
		const viewFile = (leaf: WorkspaceLeaf): TFile | null | undefined =>
			(leaf.view as unknown as { file?: TFile | null })?.file;
		// Prefer an empty leaf so no existing tab content is replaced.
		const target =
			rootLeaves.find((leaf) => leaf.view?.getViewType?.() === 'empty') ??
			rootLeaves.find(
				(leaf) =>
					leaf.view?.getViewType?.() === 'markdown' && !viewFile(leaf),
			) ??
			rootLeaves[0];
		if (!target) {
			return;
		}
		await target.openFile(file);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MyPluginSettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	onunload(): void {
		if (this.evictTimer !== null) {
			window.clearTimeout(this.evictTimer);
			this.evictTimer = null;
		}
	}
}
