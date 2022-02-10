import {
	Editor, 
	MarkdownView,
	OpenViewState,
	Plugin, 
	View
} from 'obsidian';

import {
	EditorState,
	EditorSelection
} from '@codemirror/state';

import {
	around
} from 'monkey-around';

import {
	DEFAULT_SETTINGS,
	RememberFileStatePluginSettings,
	RememberFileStatePluginSettingTab
} from './settings';

// Interface for a file state.
interface RememberedFileState {
	path: string;
	lastSavedTime: number;
	stateData: Object;
}

// Interface for all currently remembered file states.
interface RememberFileStatePluginData {
	rememberedFiles: RememberedFileState[];
}

// Default empty list of remembered file states.
const DEFAULT_DATA: RememberFileStatePluginData = {
	rememberedFiles: []
};

export default class RememberFileStatePlugin extends Plugin {
	settings: RememberFileStatePluginSettings;
	data: RememberFileStatePluginData;

	private _suppressNextFileOpen: boolean = false;

	private _viewUninstallers = {};
	private _globalUninstallers = [];

	async onload() {
		console.log("Loading RememberFileState plugin");

		await this.loadSettings();

		this.data = Object.assign({}, DEFAULT_DATA);

		this.registerEvent(this.app.workspace.on('file-open', this.onFileOpen));
		this.registerEvent(this.app.vault.on('rename', this.onFileRename));
		this.registerEvent(this.app.vault.on('delete', this.onFileDelete));

		this.app.workspace.getLeavesOfType("markdown").forEach(
			(leaf) => { this.registerOnUnloadFile(leaf.view); });

		const _this = this;
		var uninstall = around(this.app.workspace, {
			openLinkText: function(next) {
				return async function(
					linktext: string, sourcePath: string, 
					newLeaf?: boolean, openViewState?: OpenViewState) {
						// When opening a link, we don't want to restore the
						// scroll position/selection/etc because there's a
						// good chance we want to show the file back at the
						// top, or we're going straight to a specific block.
						_this._suppressNextFileOpen = true;
						return await next.call(
							this, linktext, sourcePath, newLeaf, openViewState);
					};
			}
		});
		this._globalUninstallers.push(uninstall);

		this.addSettingTab(new RememberFileStatePluginSettingTab(this.app, this));
	}

	onunload() {
		var uninstallers = Object.values(this._viewUninstallers);
		console.debug(`Unregistering ${uninstallers.length} view callbacks`);
		uninstallers.forEach((cb) => cb());
		this._viewUninstallers = {};

		this._globalUninstallers.forEach((cb) => cb());
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private readonly registerOnUnloadFile = function(view) {
		if (view in this._viewUninstallers) {
			return;
		}

		console.debug("Registering view callback");
		const _this = this;
		var uninstall = around(view, {
			onUnloadFile: function(next) {
				return async function (unloaded: TFile) {
					_this.rememberFileState(unloaded, view);
					return await next.call(this, unloaded);
				};
			}
		});
		this._viewUninstallers[view] = uninstall;

		view.register(() => {
			console.debug("Unregistering view callback");
			delete this._viewUninstallers[view];
			uninstall();
		});
	}

	private readonly onFileOpen = async (
		openedFile: TFile
	): Promise<void> => {
		// If `openedFile` is null, it's because the last pane was closed
		// and there is now an empty pane.
		if (openedFile) {
			var activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			this.registerOnUnloadFile(activeView);

			if (!this._suppressNextFileOpen) {
				this.restoreFileState(openedFile, activeView);
			} else {
				this._suppressNextFileOpen = false;
			}
		}
	}

	private readonly rememberFileState = async (file: TFile, view: View): Promise<void> => {
		const scrollInfo = view.editor.getScrollInfo();
		const stateSelectionJSON = view.editor.cm.state.selection.toJSON();
		const stateData = {'scrollInfo': scrollInfo, 'selection': stateSelectionJSON};

		var existingFile = this.data.rememberedFiles.find(
			curFile => curFile.path == file.path
		);

		if (existingFile) {
			existingFile.lastSavedTime = Date.now();
			existingFile.stateData = stateData;
		} else {
			let newFileState = {
				path: file.path,
				lastSavedTime: Date.now(),
				stateData: stateData
			};
			this.data.rememberedFiles.push(newFileState);

			// If we need to keep the number remembered files under a maximum,
			// do it now.
			this.forgetExcessFiles();
		}
		console.debug("Remember file state for:", file.path);
	}

	private restoreFileState(file: TFile, view: View) {
		const existingFile = this.data.rememberedFiles.find(
			(curFile) => curFile.path === file.path
		);
		if (existingFile) {
			console.debug("Restoring file state for:", file.path);
			const stateData = existingFile.stateData;
			view.editor.scrollTo(stateData.scrollInfo.left, stateData.scrollInfo.top);
			var transaction = view.editor.cm.state.update({
				selection: EditorSelection.fromJSON(stateData.selection)})
			view.editor.cm.dispatch(transaction);
		}
	}

	private forgetExcessFiles() {
		const keepMax = this.settings.rememberMaxFiles;
		if (keepMax <= 0) {
			return;
		}

		this.data.rememberedFiles.sort((a, b) => a.lastSavedTime < b.lastSavedTime);

		if (this.data.rememberedFiles.length > keepMax) {
			this.data.rememberedFiles.splice(keepMax);
		}
	}

	private readonly onFileRename = async (
		file: TAbstractFile,
		oldPath: string,
	): Promise<void> => {
		const existingFile = this.data.rememberedFiles.find(
			(curFile) => curFile.path === oldPath
		);
		if (existingFile) {
			existingFile.path = file.path;
		}
	};

	private readonly onFileDelete = async (
		file: TAbstractFile,
	): Promise<void> => {
		this.data.rememberedFiles = this.data.rememberedFiles.filter(
			(curFile) => curFile.path !== file.path
		);
	};
}

