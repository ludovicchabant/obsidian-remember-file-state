import {
	App,
	PluginSettingTab,
	Setting
} from 'obsidian';

import RememberFileStatePlugin from './main';

export interface RememberFileStatePluginSettings {
	rememberMaxFiles: number;
}

export const DEFAULT_SETTINGS: RememberFileStatePluginSettings = {
	// Matches the number of files Obsidian remembers the undo/redo 
	// history for by default (at least as of 0.13.17).
	rememberMaxFiles: 20 
}

export class RememberFileStatePluginSettingTab extends PluginSettingTab {
	plugin: RememberFileStatePlugin;

	constructor(app: App, plugin: RememberFileStatePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Remember files')
			.setDesc('How many files to remember at most')
			.addText(text => text
				.setValue(this.plugin.settings.rememberMaxFiles?.toString())
				.onChange(async (value: string) => {
					const intValue = parseInt(value);
					if (!isNaN(intValue)) {
						this.plugin.settings.rememberMaxFiles = intValue;
						await this.plugin.saveSettings();
					}
				}));
	}
}
