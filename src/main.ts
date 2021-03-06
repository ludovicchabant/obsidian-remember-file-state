import {
	App,
	Editor,
	MarkdownView,
	Modal,
	OpenViewState,
	Plugin,
	TAbstractFile,
	TFile,
	View,
	WorkspaceLeaf
} from 'obsidian';

import {
	EditorView
} from '@codemirror/view';

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

declare var app: App;

// Interface for CM6 editor view
interface EditorWithCM6 extends Editor {
	cm: EditorView
};

// View with unique ID
interface ViewWithID extends View {
	__uniqueId: number
};

// Scroll info interface
interface ScrollInfo {
	top: number, left: number
};

interface StateData {
	selection: EditorSelection,
	scrollInfo: ScrollInfo
};

// Interface for a file state.
interface RememberedFileState {
	path: string;
	lastSavedTime: number;
	stateData: StateData;
}

// Interface for all currently remembered file states.
interface RememberFileStatePluginData {
	rememberedFiles: Record<string, RememberedFileState>;
}

// Default empty list of remembered file states.
const DEFAULT_DATA: RememberFileStatePluginData = {
	rememberedFiles: {}
};

// Simple warning message.
class WarningModal extends Modal {
	title: string = "";
	message: string = "";

	constructor(app: App, title: string, message: string) {
		super(app)
		this.title = title;
		this.message = message;
	}
	onOpen() {
		this.contentEl.createEl('h2', {text: this.title});
		this.contentEl.createEl('p', {text: this.message});
	}
};

export default class RememberFileStatePlugin extends Plugin {
	settings: RememberFileStatePluginSettings;
	data: RememberFileStatePluginData;

	// Don't restore state on the next file being opened.
	private _suppressNextFileOpen: boolean = false;
	// Next unique ID to identify views without keeping references to them.
	private _nextUniqueViewId: number = 0;

	// Remember last open file in each view.
	private _lastOpenFiles: Record<string, string> = {};

	// Functions to unregister any monkey-patched view hooks on plugin unload.
	private _viewUninstallers: Record<string, Function> = {};
	// Functions to unregister any global callbacks on plugin unload.
	private _globalUninstallers: Function[] = [];

	async onload() {
		console.log("Loading RememberFileState plugin");

		await this.loadSettings();

		this.data = Object.assign({}, DEFAULT_DATA);

		this.registerEvent(this.app.workspace.on('file-open', this.onFileOpen));
		this.registerEvent(this.app.vault.on('rename', this.onFileRename));
		this.registerEvent(this.app.vault.on('delete', this.onFileDelete));

		this.app.workspace.getLeavesOfType("markdown").forEach(
			(leaf: WorkspaceLeaf) => { this.registerOnUnloadFile(leaf.view as MarkdownView); });

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

		if ((this.app.vault as any).getConfig('legacyEditor') !== false) {
			new WarningModal(
				this.app,
				"Legacy Editor Not Supported",
				"The 'Remember File State' plugin works only with the new editor. Please turn off 'Legacy Editor' in the options."
			).open();
		}
	}

	onunload() {
		// Run view uninstallers on all current views.
		var numViews: number = 0;
		this.app.workspace.getLeavesOfType("markdown").forEach(
			(leaf: WorkspaceLeaf) => {
				const filePath = (leaf.view as MarkdownView).file.path;
				const viewId = this.getUniqueViewId(leaf.view as ViewWithID);
				if (viewId != undefined) {
					var uninstaller = this._viewUninstallers[viewId];
					if (uninstaller) {
						console.debug(`Uninstalling hooks for view ${viewId}`, filePath);
						uninstaller(leaf.view);
						++numViews;
					} else {
						console.debug("Found markdown view without an uninstaller!", filePath);
					}
					// Clear the ID so we don't get confused if the plugin
					// is re-enabled later.
					this.clearUniqueViewId(leaf.view as ViewWithID);
				} else {
					console.debug("Found markdown view without an ID!", filePath);
				}
			});
		console.debug(`Unregistered ${numViews} view callbacks`);
		this._viewUninstallers = {};
		this._lastOpenFiles = {};

		// Run global unhooks.
		this._globalUninstallers.forEach((cb) => cb());
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private readonly registerOnUnloadFile = function(view: MarkdownView) {
		var filePath = view.file.path;
		var viewId = this.getUniqueViewId(view as unknown as ViewWithID, true);
		if (viewId in this._viewUninstallers) {
			return;
		}

		console.debug(`Registering callback on view ${viewId}`, filePath);
		const _this = this;
		var uninstall = around(view, {
			onUnloadFile: function(next) {
				return async function (unloaded: TFile) {
					_this.rememberFileState(unloaded, this);
					return await next.call(this, unloaded);
				};
			}
		});
		this._viewUninstallers[viewId] = uninstall;

		view.register(() => {
			// Don't hold a reference to this plugin here because this callback
			// will outlive it if it gets deactivated. So let's find it, and
			// do nothing if we don't find it.
			// @ts-ignore
			var plugin: RememberFileStatePlugin = app.plugins.getPlugin("obsidian-remember-file-state");
			if (plugin) {
				console.debug(`Unregistering view ${viewId} callback`, filePath);
				delete plugin._viewUninstallers[viewId];
				delete plugin._lastOpenFiles[viewId];
				uninstall();
			} else {
				console.debug(
					"Plugin obsidian-remember-file-state has been unloaded, ignoring unregister");
			}
		});
	}

	private readonly onFileOpen = async (
		openedFile: TFile
	): Promise<void> => {
		// If `openedFile` is null, it's because the last pane was closed
		// and there is now an empty pane.
		if (openedFile) {
			var activeView: MarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView) {
				this.registerOnUnloadFile(activeView);

				var isRealFileOpen = true;
				const viewId = this.getUniqueViewId(activeView as unknown as ViewWithID);
				if (viewId != undefined) {
					const lastOpenFileInView = this._lastOpenFiles[viewId];
					isRealFileOpen = (lastOpenFileInView != openedFile.path);
					this._lastOpenFiles[viewId] = openedFile.path;
				}

				// Don't restore the file state if:
				// - We are suppressing it explicitly (such as if the file was
				//     opened via clicking a hyperlink)
				// - The file is already currently open in another pane
				// - The file was already opened in this pane, and we're just
				//     returning to it.
				if (!this._suppressNextFileOpen &&
					!this.isFileMultiplyOpen(openedFile) &&
				    isRealFileOpen
				   ) {
					try {
						this.restoreFileState(openedFile, activeView);
					} catch (err) {
						console.error("Couldn't restore file state: ", err);
					}
				}
			}
			// else: the file isn't handled by a markdown editor.

			this._suppressNextFileOpen = false;
		}
	}

	private readonly rememberFileState = async (file: TFile, view: MarkdownView): Promise<void> => {
		const scrollInfo = view.editor.getScrollInfo();
		const cm6editor = view.editor as EditorWithCM6;
		const stateSelection: EditorSelection = cm6editor.cm.state.selection;
		if (stateSelection == undefined) {
			// Legacy editor is in use, let's ignore
			return;
		}
		const stateSelectionJSON = stateSelection.toJSON();
		const stateData = {'scrollInfo': scrollInfo, 'selection': stateSelectionJSON};

		var existingFile = this.data.rememberedFiles[file.path];
		if (existingFile) {
			existingFile.lastSavedTime = Date.now();
			existingFile.stateData = stateData;
		} else {
			let newFileState = {
				path: file.path,
				lastSavedTime: Date.now(),
				stateData: stateData
			};
			this.data.rememberedFiles[file.path] = newFileState;

			// If we need to keep the number remembered files under a maximum,
			// do it now.
			this.forgetExcessFiles();
		}
		console.debug("Remember file state for:", file.path);
	}

	private readonly restoreFileState = function(file: TFile, view: MarkdownView) {
		const existingFile = this.data.rememberedFiles[file.path];
		if (existingFile) {
			console.debug("Restoring file state for:", file.path);
			const stateData = existingFile.stateData;
			view.editor.scrollTo(stateData.scrollInfo.left, stateData.scrollInfo.top);
			const cm6editor = view.editor as EditorWithCM6;
			var transaction = cm6editor.cm.state.update({
				selection: EditorSelection.fromJSON(stateData.selection)})
			
			cm6editor.cm.dispatch(transaction);
		}
	}
	
	private readonly isFileMultiplyOpen = function(file: TFile) {
		var numFound: number = 0;
		this.app.workspace.getLeavesOfType("markdown").forEach(
			(leaf: WorkspaceLeaf) => {
				const filePath = (leaf.view as MarkdownView).file.path;
				if (filePath == file.path) {
					++numFound;
				}
			});
		return numFound >= 2;
	}

	private readonly forgetExcessFiles = function() {
		const keepMax = this.settings.rememberMaxFiles;
		if (keepMax <= 0) {
			return;
		}

		// Sort newer files first, older files last.
		var filesData: RememberedFileState[] = Object.values(this.data.rememberedFiles);
		filesData.sort((a, b) => {
			if (a.lastSavedTime > b.lastSavedTime) return -1; // a before b
			if (a.lastSavedTime < b.lastSavedTime) return 1;  // b before a
			return 0;
		});

		// Remove older files past the limit.
		for (var i = keepMax; i < filesData.length; ++i) {
			var fileData = filesData[i];
			delete this.data.rememberedFiles[fileData.path];
		}
	}

	private readonly getUniqueViewId = function(view: ViewWithID, autocreateId: boolean = false) {
		if (view.__uniqueId == undefined) {
			if (!autocreateId) {
				return -1;
			}
			view.__uniqueId = (this._nextUniqueViewId++);
			return view.__uniqueId;
		}
		return view.__uniqueId;
	}

	private readonly clearUniqueViewId = function(view: ViewWithID) {
		delete view["__uniqueId"];
	}

	private readonly onFileRename = async (
		file: TAbstractFile,
		oldPath: string,
	): Promise<void> => {
		const existingFile: RememberedFileState = this.data.rememberedFiles[oldPath];
		if (existingFile) {
			existingFile.path = file.path;
			delete this.data.rememberedFiles[oldPath];
			this.data.rememberedFiles[file.path] = existingFile;
		}
	};

	private readonly onFileDelete = async (
		file: TAbstractFile,
	): Promise<void> => {
		delete this.data.rememberedFiles[file.path];
	};
}

