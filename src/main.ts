import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	App,
	Editor,
	MarkdownView,
	Modal,
	OpenViewState,
	Plugin,
	TAbstractFile,
	TFile,
	Tasks,
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

// Where to save the states database.
const STATE_DB_PATH: string = '.obsidian/plugins/obsidian-remember-file-state/states.json';

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
		// Enable this for troubleshooting.
		const enableLogfile: boolean = false;
		if (enableLogfile) {
			const outLogPath = path.join(os.tmpdir(), 'obsidian-remember-file-state.log');
			this.setupLogFile(outLogPath);
		}

		console.log("RememberFileState: loading plugin");

		await this.loadSettings();

		this.data = Object.assign({}, DEFAULT_DATA);

		await this.readStateDatabase(STATE_DB_PATH);

		this.registerEvent(this.app.workspace.on('file-open', this.onFileOpen, this));
		this.registerEvent(this.app.workspace.on('quit', this.onAppQuit, this));
		this.registerEvent(this.app.vault.on('rename', this.onFileRename, this));
		this.registerEvent(this.app.vault.on('delete', this.onFileDelete, this));

		this.app.workspace.onLayoutReady(() => { this.onLayoutReady(); });

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
		console.log("RememberFileState: unloading plugin");

		// Unregister unload callbacks on all views.
		this.unregisterAllViews();

		// Forget which files are opened in which views.
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

	private readonly onLayoutReady = function() {
		this.app.workspace.getLeavesOfType("markdown").forEach(
			(leaf: WorkspaceLeaf) => { 
				var view = leaf.view as MarkdownView;

				// On startup, assign unique IDs to views and register the
				// unload callback to remember their state.
				this.registerOnUnloadFile(view); 

				// Also remember which file is opened in which view.
				const viewId = this.getUniqueViewId(view as unknown as ViewWithID);
				if (viewId != undefined) {
					this._lastOpenFiles[viewId] = view.file.path;
				}

				// Restore state for each opened pane on startup.
				const existingFile = this.data.rememberedFiles[view.file.path];
				if (existingFile) {
					const savedStateData = existingFile.stateData;
					console.debug("RememberFileState: restoring saved state for:", view.file.path, savedStateData);
					this.restoreState(savedStateData, view);
				}
			});
	}

	private readonly registerOnUnloadFile = function(view: MarkdownView) {
		var filePath = view.file.path;
		var viewId = this.getUniqueViewId(view as unknown as ViewWithID, true);
		if (viewId in this._viewUninstallers) {
			return;
		}

		console.debug(`RememberFileState: registering callback on view ${viewId}`, filePath);
		const _this = this;
		var uninstall = around(view, {
			onUnloadFile: function(next) {
				return async function (unloaded: TFile) {
					_this.rememberFileState(this, unloaded);
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
				console.debug(`RememberFileState: unregistering view ${viewId} callback`, filePath);
				delete plugin._viewUninstallers[viewId];
				delete plugin._lastOpenFiles[viewId];
				uninstall();
			} else {
				console.debug(
					"RememberFileState: plugin was unloaded, ignoring unregister");
			}
		});
	}

	private readonly unregisterAllViews = function() {
		// Run view uninstallers on all current views.
		var numViews: number = 0;
		this.app.workspace.getLeavesOfType("markdown").forEach(
			(leaf: WorkspaceLeaf) => {
				const filePath = (leaf.view as MarkdownView).file.path;
				const viewId = this.getUniqueViewId(leaf.view as ViewWithID);
				if (viewId != undefined) {
					var uninstaller = this._viewUninstallers[viewId];
					if (uninstaller) {
						console.debug(`RememberFileState: uninstalling hooks for view ${viewId}`, filePath);
						uninstaller(leaf.view);
						++numViews;
					} else {
						console.debug("RememberFileState: found markdown view without an uninstaller!", filePath);
					}
					// Clear the ID so we don't get confused if the plugin
					// is re-enabled later.
					this.clearUniqueViewId(leaf.view as ViewWithID);
				} else {
					console.debug("RememberFileState: found markdown view without an ID!", filePath);
				}
			});
		console.debug(`RememberFileState: unregistered ${numViews} view callbacks`);
		this._viewUninstallers = {};
	}

	private readonly onFileOpen = async (
		openedFile: TFile
	): Promise<void> => {
		// If `openedFile` is null, it's because the last pane was closed
		// and there is now an empty pane.
		if (!openedFile) {
			return;
		}

		var shouldSuppressThis: boolean = this._suppressNextFileOpen;
		this._suppressNextFileOpen = false;
		if (shouldSuppressThis) {
			console.debug("RememberFileState: not restoring file state because of explicit suppression");
			return;
		}

		// Check that the file is handled by a markdown editor, which is the
		// only editor we support for now.
		var activeView: MarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			console.debug("RememberFileState: not restoring file state, it's not a markdown view");
			return;
		}

		this.registerOnUnloadFile(activeView);

		// Check if this is a genuine file open, and not returning to pane that
		// already had this file opened in it.
		var isRealFileOpen = true;
		const viewId = this.getUniqueViewId(activeView as unknown as ViewWithID);
		if (viewId != undefined) {
			const lastOpenFileInView = this._lastOpenFiles[viewId];
			isRealFileOpen = (lastOpenFileInView != openedFile.path);
			this._lastOpenFiles[viewId] = openedFile.path;
		}
		if (!isRealFileOpen) {
			console.debug("RememberFileState: not restoring file state, that file was already open in this pane.");
			return;
		}

		// Restore the state!
		try {
			const existingFile = this.data.rememberedFiles[openedFile.path];
			if (existingFile) {
				const savedStateData = existingFile.stateData;
				console.debug("RememberFileState: restoring saved state for:", openedFile.path, savedStateData);
				this.restoreState(savedStateData, activeView);
			} else {
				// If we don't have any saved state for this file, let's see if
				// it's opened in another pane. If so, restore that.
				const otherPaneState = this.findFileStateFromOtherPane(openedFile, activeView);
				if (otherPaneState) {
					console.debug("RememberFileState: restoring other pane state for:", openedFile.path, otherPaneState);
					this.restoreState(otherPaneState, activeView);
				}
			}
		} catch (err) {
			console.error("RememberFileState: couldn't restore file state: ", err);
		}
	}

	private readonly rememberFileState = async (view: MarkdownView, file?: TFile): Promise<void> => {
		const stateData = this.getState(view);

		if (file === undefined) {
			file = view.file;
		}
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

			// If we need to keep the number of remembered files under a maximum,
			// do it now.
			this.forgetExcessFiles();
		}
		console.debug("RememberFileState: remembered state for:", file.path, stateData);
	}

	private readonly getState = function(view: MarkdownView) {
		// Save scrolling position (Obsidian API only gives vertical position).
		const scrollInfo = {top: view.currentMode.getScroll(), left: 0};

		// Save current selection. CodeMirror returns a JSON object (not a 
		// JSON string!) when we call toJSON.
		// If state selection is undefined, we have a legacy editor. Just ignore that part.
		const cm6editor = view.editor as EditorWithCM6;
		const stateSelection: EditorSelection = cm6editor.cm.state.selection;
		const stateSelectionJSON = (stateSelection !== undefined) ? stateSelection.toJSON() : undefined;

		const stateData = {'scrollInfo': scrollInfo, 'selection': stateSelectionJSON};

		return stateData;
	}

	private readonly restoreState = function(stateData: StateData, view: MarkdownView) {
		// Restore scrolling position (Obsidian API only allows setting vertical position).
		view.currentMode.applyScroll(stateData.scrollInfo.top);

		// Restore last known selection, if any.
		if (stateData.selection !== undefined) {
			const cm6editor = view.editor as EditorWithCM6;
			var transaction = cm6editor.cm.state.update({
				selection: EditorSelection.fromJSON(stateData.selection)})
			
			cm6editor.cm.dispatch(transaction);
		}
	}
	
	private readonly findFileStateFromOtherPane = function(file: TFile, activeView: MarkdownView) {
		var otherView = null;
		this.app.workspace.getLeavesOfType("markdown").every(
			(leaf: WorkspaceLeaf) => {
				var curView = leaf.view as MarkdownView;
				if (curView != activeView && 
					curView.file.path == file.path &&
					this.getUniqueViewId(curView) >= 0  // Skip views that have never been activated.
				   ) {
					otherView = curView;
					return false; // Stop iterating leaves.
				}
				return true;
			},
			this // thisArg
		);
		return otherView ? this.getState(otherView) : null;
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

	private readonly onAppQuit = async (tasks: Tasks): Promise<void> => {
		const _this = this;
		tasks.addPromise(
			_this.rememberAllOpenedFileStates()
			.then(() => _this.writeStateDatabase(STATE_DB_PATH)));
	}

	private readonly rememberAllOpenedFileStates = async(): Promise<void> => {
		this.app.workspace.getLeavesOfType("markdown").forEach(
			(leaf: WorkspaceLeaf) => { 
				const view = leaf.view as MarkdownView;
				this.rememberFileState(view);
			}
		);
	}

	private readonly writeStateDatabase = async(path: string): Promise<void> => {
		const fs = this.app.vault.adapter;
		const jsonDb = JSON.stringify(this.data);
		await fs.write(path, jsonDb);
	}

	private readonly readStateDatabase = async(path: string): Promise<void> => {
		const fs = this.app.vault.adapter;
		if (await fs.exists(path)) {
			const jsonDb = await fs.read(path);
			try
			{
				this.data = JSON.parse(jsonDb);
				const numLoaded = Object.keys(this.data.rememberedFiles).length;
				console.debug(`RememberFileState: read ${numLoaded} record from state database.`);
			} catch (err) {
				console.error("RememberFileState: error loading state database:", err);
				console.error(jsonDb);
			}
		}
	}

	private readonly setupLogFile = function(outLogPath: string) {
		console.log("RememberFileState: setting up log file: ", outLogPath);

		const makeWrapper = function(origFunc) {
			return function (data) {
				origFunc.apply(console, arguments);

				var text: string = "";
				for (var i: number = 0; i < arguments.length; i++) {
					if (i > 0) text += " ";
					text += arguments[i].toString();
				}
				text += "\n";
				fs.appendFileSync(outLogPath, text);
			};
		};
		console.log = makeWrapper(console.log);
		console.debug = makeWrapper(console.debug);
		console.info = makeWrapper(console.info);
		console.warn = makeWrapper(console.warn);
		console.error = makeWrapper(console.error);

		const banner: string = "\n\nDebug log start\n===============\n";
		fs.appendFileSync(outLogPath, banner);
	}
}

