import { App, PluginSettingTab, Setting } from 'obsidian';
import type MyPlugin from './main';
import type { StickyNotesSettings } from './types/settings';

export type MyPluginSettings = StickyNotesSettings;

export const DEFAULT_SETTINGS: MyPluginSettings = {
	collectionFile: '',
	popoutWidth: 0,
	popoutHeight: 0,
};

export class StickyNotesSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		const markdownFiles = this.app.vault
			.getMarkdownFiles()
			.sort((left, right) => left.path.localeCompare(right.path));
		const options = Object.fromEntries(
			markdownFiles.map((file) => [file.path, file.path]),
		);

		new Setting(containerEl)
			.setName('便笺集合文件')
			.setDesc('选择一个使用二级标题（##）分隔便笺的 Markdown 文件。')
			.addDropdown((dropdown) => {
				dropdown.addOption('', '未选择');
				dropdown.addOptions(options);
				dropdown.setValue(this.plugin.settings.collectionFile);
				dropdown.onChange(async (value) => {
					this.plugin.settings.collectionFile = value;
					await this.plugin.saveSettings();
					this.plugin.refreshStickyNotesViews();
				});
			});

		new Setting(containerEl)
			.setName('窗口宽度')
			.setDesc('便笺窗口宽度（像素），0 表示按屏幕自动。手动调整窗口后自动更新。')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.setValue(String(this.plugin.settings.popoutWidth));
				text.onChange(async (value) => {
					const width = Number.parseInt(value, 10);
					if (!Number.isFinite(width) || width < 0 || width > 3840) {
						return;
					}
					this.plugin.settings.popoutWidth = width;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('窗口高度')
			.setDesc('便笺窗口高度（像素），0 表示按屏幕自动。手动调整窗口后自动更新。')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.setValue(String(this.plugin.settings.popoutHeight));
				text.onChange(async (value) => {
					const height = Number.parseInt(value, 10);
					if (!Number.isFinite(height) || height < 0 || height > 2160) {
						return;
					}
					this.plugin.settings.popoutHeight = height;
					await this.plugin.saveSettings();
				});
			});
	}
}
