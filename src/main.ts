"use strict";

import {
	TFolder,
	Notice,
	MarkdownView,
	normalizePath,
	MetadataCache,
	TFile,
	Vault,
	FileManager,
	requireApiVersion,
	Modal,
	moment,
	addIcon,
	setIcon,
	Menu,
	App,
	type PluginManifest,
} from "obsidian";
import { Platform } from "obsidian";

/** Internal Obsidian App properties not exposed in the public API */
interface ObsidianApp {
	appId: string;
	reloadRelay?: () => Promise<void>;
	plugins: {
		disablePlugin(id: string): Promise<void>;
		enablePlugin(id: string): Promise<void>;
	};
	setting: {
		open(): Promise<void>;
		openTabById(id: string): Promise<void>;
	};
	internalPlugins?: {
		plugins?: {
			webviewer?: {
				enabled: boolean;
				instance?: {
					options: Record<string, unknown>;
				};
			};
		};
	};
	commands: {
		commands: Record<string, unknown>;
		editorCommands: Record<string, unknown>;
	};
	hotkeyManager: {
		removeDefaultHotkeys(id: string): boolean;
	};
}
import { relative } from "path-browserify";
import { SharedFolder } from "./SharedFolder";
import type { SharedFolderSettings } from "./SharedFolder";
import type { ShareScope } from "./vaultScope";
import { LiveViewManager } from "./LiveViews";

import { SharedFolders } from "./SharedFolder";
import { FolderNavigationDecorations } from "./ui/FolderNav";
import { LiveSettingsTab } from "./ui/SettingsTab";
import { LoginManager, type LoginSettings } from "./LoginManager";
import {
	curryLog,
	setDebugging,
	RelayInstances,
	initializeLogger,
	flushLogs,
} from "./debug";
import { getPatcher, Patcher } from "./Patcher";
import { LiveTokenStore } from "./LiveTokenStore";
import NetworkStatus from "./NetworkStatus";
import { RelayManager } from "./RelayManager";
import { DefaultTimeProvider, type TimeProvider } from "./TimeProvider";
import { auditTeardown } from "./observable/Observable";
import { Plugin } from "obsidian";

import {
	DifferencesView,
	VIEW_TYPE_DIFFERENCES,
} from "./differ/differencesView";
import { FeatureFlagDefaults, flag, type FeatureFlags } from "./flags";
import { FeatureFlagManager, withFlag } from "./flagManager";
import { PostOffice } from "./observable/Postie";
import { BackgroundSync } from "./BackgroundSync";
import { FeatureFlagToggleModal } from "./ui/FeatureFlagModal";
import { DebugModal } from "./ui/DebugModal";
import { NamespacedSettings, Settings } from "./SettingsStorage";
import { ObsidianFileAdapter, ObsidianNotifier } from "./debugObsididan";
import { IndexedDBAnalysisModal } from "./ui/IndexedDBAnalysisModal";

import { SyncSettingsManager } from "./SyncSettings";
import { ContentAddressedFileStore, isSyncFile } from "./SyncFile";
import { isDocument } from "./Document";
import { EndpointManager, type EndpointSettings } from "./EndpointManager";
import {
	DEFAULT_RELAY_ONPREM_SETTINGS,
	KNAP_SERVER_ID,
	type RelayOnPremSettings,
	type RelayOnPremServer,
	migrateRelayOnPremSettings,
	getDefaultServer,
} from "./RelayOnPremConfig";
import { RelayOnPremTokenProvider } from "./auth/RelayOnPremTokenProvider";
import {
	oauthDeepLinkReceiver,
	OAUTH_CALLBACK_ACTION,
} from "./auth/OAuthDeepLinkReceiver";
import type { IAuthProvider } from "./auth/IAuthProvider";
import { RelayOnPremShareClient, type FolderItem } from "./RelayOnPremShareClient";
import { RelayOnPremShareClientManager, type ShareWithServer } from "./RelayOnPremShareClientManager";
// ShareManagementModal only imports main.ts for its type, which erases at
// compile time, so there is no runtime cycle for a plain import to trip over.
// It was being pulled in with require() at three call sites instead.
import { ShareManagementModal } from "./ui/ShareManagementModal";
import { LocalStorage } from "./LocalStorage";

interface DebugSettings {
	debugging: boolean;
}

const DEFAULT_DEBUG_SETTINGS: DebugSettings = {
	debugging: false,
};

interface RelaySettings extends FeatureFlags, DebugSettings {
	sharedFolders: SharedFolderSettings[];
	endpoints: EndpointSettings;
	relayOnPrem: RelayOnPremSettings;
}

const DEFAULT_SETTINGS: RelaySettings = {
	sharedFolders: [],
	endpoints: {},
	relayOnPrem: DEFAULT_RELAY_ONPREM_SETTINGS,
	...FeatureFlagDefaults,
	...DEFAULT_DEBUG_SETTINGS,
};

declare const GIT_TAG: string;

// relay-onprem control-plane URLs are runtime/per-server config (multi-server,
// user-editable), not a build-time constant — unlike the EndpointManager's
// System-3 API_URL/AUTH_URL, there is no fixed default to bake in at build time.
function healthUrlForServer(server?: RelayOnPremServer): string {
	if (!server?.controlPlaneUrl) {
		return "";
	}
	return `${server.controlPlaneUrl.replace(/\/+$/, "")}/v1/health?version=${GIT_TAG}`;
}

export default class Live extends Plugin {
	appId!: string;
	webviewerPatched = false;
	openModals: Modal[] = [];
	loadTime?: number;
	sharedFolders!: SharedFolders;
	vault!: Vault;
	notifier!: ObsidianNotifier;
	loginManager!: LoginManager;
	timeProvider!: TimeProvider;
	fileManager!: FileManager;
	tokenStore!: LiveTokenStore;
	interceptedUrls: Array<string | RegExp> = [];
	networkStatus!: NetworkStatus;
	backgroundSync!: BackgroundSync;
	folderNavDecorations!: FolderNavigationDecorations;
	relayManager!: RelayManager;
	settingsTab!: LiveSettingsTab;
	settings!: Settings<RelaySettings>;
	private featureSettings!: NamespacedSettings<FeatureFlags>;
	private debugSettings!: NamespacedSettings<DebugSettings>;
	private folderSettings!: NamespacedSettings<SharedFolderSettings[]>;
	public loginSettings!: NamespacedSettings<LoginSettings>;
	public endpointSettings!: NamespacedSettings<EndpointSettings>;
	public relayOnPremSettings!: NamespacedSettings<RelayOnPremSettings>;
	public shareClient?: RelayOnPremShareClient;
	public shareClientManager?: RelayOnPremShareClientManager;
	public webSyncManager?: import("./WebSyncManager").WebSyncManager;
	public inboundFileDownloader?: import("./InboundFileDownloader").InboundFileDownloader;
	public inboundSyncPoller?: import("./InboundSyncPoller").InboundSyncPoller;
	debug!: (...args: unknown[]) => void;
	log!: (...args: unknown[]) => void;
	warn!: (...args: unknown[]) => void;
	error!: (...args: unknown[]) => void;
	private _liveViews!: LiveViewManager;
	fileDiffMergeWarningKey = "file-diff-merge-warning";
	version = GIT_TAG;
	hashStore!: ContentAddressedFileStore;

	enableDebugging(save?: boolean) {
		setDebugging(true);
		console.warn("RelayInstances", RelayInstances);
		if (save) {
			void this.debugSettings.update((settings) => ({
				...settings,
				debugging: true,
			}));
		}
	}

	disableDebugging(save?: boolean) {
		setDebugging(false);
		if (save) {
			void this.debugSettings.update((settings) => ({
				...settings,
				debugging: false,
			}));
		}
	}

	toggleDebugging(save?: boolean): boolean {
		const setTo = !this.debugSettings.get().debugging;
		setDebugging(setTo);
		if (save) {
			void this.debugSettings.update((settings) => ({
				...settings,
				debugging: setTo,
			}));
		}
		return setTo;
	}

	buildApiUrl(path: string) {
		return this.loginManager.getEndpointManager().getApiUrl() + path;
	}

	/**
	 * Validate custom endpoints on startup if configured
	 */
	private async validateEndpointsOnStartup(
		endpointManager: EndpointManager,
	): Promise<void> {
		const settings = this.endpointSettings.get();

		// Skip if no active tenant configured
		if (!settings.activeTenantId || !settings.tenants?.length) {
			this.log("No active enterprise tenant configured, using defaults");
			return;
		}

		const activeTenant = settings.tenants.find(
			(t) => t.id === settings.activeTenantId,
		);
		if (!activeTenant) {
			this.log("Active tenant not found, using defaults");
			return;
		}

		this.log("Enterprise tenant configured, validating on startup...", {
			tenantId: activeTenant.id,
			tenantUrl: activeTenant.tenantUrl,
			tenantName: activeTenant.name,
		});

		try {
			// Use shorter timeout for startup validation to avoid blocking startup
			const result = await endpointManager.validateAndSetEndpoints(5000);

			if (result.success) {
				// Clear any previous validation errors on successful startup validation
				await this.endpointSettings.update((current) => ({
					...current,
					_lastValidationError: undefined,
					_lastValidationAttempt: undefined,
				}));
				this.log("✓ Enterprise tenant validated and applied on startup", {
					licenseInfo: result.licenseInfo,
				});
			} else {
				this.error(
					"❌ Enterprise tenant validation failed on startup",
					result.error,
				);
				// Store the error for display in settings
				await this.endpointSettings.update((current) => ({
					...current,
					_lastValidationError: result.error,
					_lastValidationAttempt: Date.now(),
				}));
				new Notice(
					`❌ Custom endpoints failed validation: ${result.error}`,
					8000,
				);
			}
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			this.error("Startup endpoint validation error:", errorMessage);
			// Store the error for display in settings
			await this.endpointSettings.update((current) => ({
				...current,
				_lastValidationError: errorMessage,
				_lastValidationAttempt: Date.now(),
			}));
			new Notice(`❌ Endpoint validation error: ${errorMessage}`, 8000);
		}
	}
	async onload() {
		this.appId = (this.app as unknown as ObsidianApp).appId;
		const start = moment.now();
		RelayInstances.set(this, "plugin");
		this.timeProvider = new DefaultTimeProvider();
		this.register(() => {
			this.timeProvider.destroy();
		});

		const logFilePath = normalizePath(
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/relay.log`,
		);

		initializeLogger(
			new ObsidianFileAdapter(this.app.vault),
			this.timeProvider,
			logFilePath,
			{
				maxFileSize: 5 * 1024 * 1024, // 5MB
				maxBackups: 3,
				disableConsole: false, // Disable console logging
			},
		);
		this.notifier = new ObsidianNotifier();

		this.debug = curryLog("[Knap Sync]", "debug");
		this.log = curryLog("[Knap Sync]", "log");
		this.warn = curryLog("[Knap Sync]", "warn");
		this.error = curryLog("[Knap Sync]", "error");

		this.settings = new Settings<RelaySettings>(this, DEFAULT_SETTINGS);
		await this.settings.load();

		// Migrate relay-onprem settings from legacy single-server format to multi-server
		const rawRelayOnPremSettings = this.settings.get().relayOnPrem;
		const migration = migrateRelayOnPremSettings(rawRelayOnPremSettings);
		if (migration.changed) {
			await this.settings.update((settings) => ({
				...settings,
				relayOnPrem: migration.settings,
			}));
		}
		// If an existing server was adopted as the well-known Knap server, migrate
		// its localStorage auth key
		// and update all shared folder settings that reference the old server ID
		if (migration.renamedServerId) {
			const oldId = migration.renamedServerId;
			// Must match RelayOnPremAuthStore.getStorageKey()'s format, which is
			// keyed by appId (stable across vault renames), not vault display name.
			const prefix = "knap-sync_onprem_auth_";
			const oldKey = `${prefix}${this.appId}_${oldId}`;
			const newKey = `${prefix}${this.appId}_${KNAP_SERVER_ID}`;
			try {
				const oldData = window.localStorage.getItem(oldKey);
				if (oldData && !window.localStorage.getItem(newKey)) {
					window.localStorage.setItem(newKey, oldData);
					window.localStorage.removeItem(oldKey);
				}
			} catch {
				// localStorage may not be available during startup
			}
			// Migrate onpremServerId in shared folder settings
			const currentSettings = this.settings.get();
			const folders = currentSettings.sharedFolders;
			if (folders?.length) {
				let folderChanged = false;
				const updated = folders.map((f) => {
					if (f.onpremServerId === oldId) {
						folderChanged = true;
						return { ...f, onpremServerId: KNAP_SERVER_ID };
					}
					return f;
				});
				if (folderChanged) {
					await this.settings.update((s) => ({ ...s, sharedFolders: updated }));
				}
			}
		}

		const settingsBase = this.settings as unknown as Settings<unknown>;
		this.featureSettings = new NamespacedSettings(settingsBase, "(enable*)");
		this.debugSettings = new NamespacedSettings(settingsBase, "(debugging)");
		this.folderSettings = new NamespacedSettings(
			settingsBase,
			"sharedFolders",
		);
		this.loginSettings = new NamespacedSettings(settingsBase, "login");
		this.endpointSettings = new NamespacedSettings(settingsBase, "endpoints");
		this.relayOnPremSettings = new NamespacedSettings(settingsBase, "relayOnPrem");

		const flagManager = FeatureFlagManager.getInstance();
		flagManager.setSettings(this.featureSettings);

		this.settingsTab = new LiveSettingsTab(this.app, this);

		// Our own ribbon icon: a note kept in step with a server
		addIcon("knap-sync", `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 44.4a32 32 0 0 1 63 0"/><path d="M87.3 31.2 81.5 44.4 71.5 34"/><path d="M81.5 55.6a32 32 0 0 1-63 0"/><path d="M12.7 68.8 18.5 55.6 28.5 66"/><circle cx="50" cy="50" r="7" fill="currentColor" stroke="none"/></svg>`);
		this.addRibbonIcon("knap-sync", "Knap Sync", () => {
			void this.openSettings();
		});

		this.register(
			this.debugSettings.subscribe((settings) => {
				if (settings.debugging) {
					this.enableDebugging();
					this.removeCommand("enable-debugging");
					this.addCommand({
						id: "toggle-feature-flags",
						name: "Show feature flags",
						callback: () => {
							const modal = new FeatureFlagToggleModal(this.app, () => {
								void this.reload();
							});
							this.openModals.push(modal);
							modal.open();
						},
					});
					this.addCommand({
						id: "show-debug-info",
						name: "Show debug info",
						callback: () => {
							const modal = new DebugModal(this.app, this);
							this.openModals.push(modal);
							modal.open();
						},
					});
					this.addCommand({
						id: "analyze-indexeddb",
						name: "Analyze database",
						callback: () => {
							const modal = new IndexedDBAnalysisModal(this.app, this);
							this.openModals.push(modal);
							modal.open();
						},
					});
					this.addCommand({
						id: "disable-debugging",
						name: "Disable debugging",
						callback: () => {
							this.disableDebugging(true);
						},
					});
				} else {
					this.removeCommand("toggle-feature-flags");
					this.removeCommand("show-debug-info");
					this.removeCommand("disable-debugging");
					this.addCommand({
						id: "enable-debugging",
						name: "Enable debugging",
						callback: () => {
							this.enableDebugging(true);
						},
					});
				}
			}),
		);

		// Store app reference for reload function (avoid window.app per Obsidian guidelines)
		const appRef = this.app as unknown as ObsidianApp;
		appRef.reloadRelay = async () => {
			await appRef.plugins.disablePlugin("knap-sync");
			await appRef.plugins.enablePlugin("knap-sync");
		};

		this.addCommand({
			id: "reload",
			name: "Reload plugin",
			callback: async () => await (this.app as unknown as ObsidianApp).reloadRelay?.(),
		});

		this.addCommand({
			id: "open-settings",
			name: "Open settings",
			callback: () => {
				void this.openSettings();
			},
		});


		this.vault = this.app.vault;
		const vaultName = this.vault.getName();
		this.fileManager = this.app.fileManager;

		this.hashStore = new ContentAddressedFileStore(this.appId);

		// Initialize and validate endpoints before creating LoginManager
		const endpointManager = new EndpointManager(this.endpointSettings);
		await this.validateEndpointsOnStartup(endpointManager);

		this.loginManager = new LoginManager(
			this.vault.getName(),
			this.appId,
			this.openSettings.bind(this),
			this.timeProvider,
			this.patchWebviewer.bind(this),
			this.loginSettings,
			endpointManager,
			this.relayOnPremSettings.get(),
			this.relayOnPremSettings,
		);
		this.relayManager = new RelayManager(this.loginManager);
		this.sharedFolders = new SharedFolders(
			this.relayManager,
			this.vault,
			this._createSharedFolder.bind(this),
			this.folderSettings,
		);

		// Initialize relay-onprem token provider and share client if enabled
		const relayOnPremSettings = this.relayOnPremSettings.get();
		let relayOnPremTokenProvider: RelayOnPremTokenProvider | undefined;
		const defaultServer = getDefaultServer(relayOnPremSettings);
		// TR-32: tracks which URL relayOnPremTokenProvider is currently pointed
		// at, so the settings subscription below can detect when the default
		// server's controlPlaneUrl changes (the provider is otherwise long-lived
		// and never re-reads settings on its own).
		let tokenProviderControlPlaneUrl = defaultServer?.controlPlaneUrl;

		if (relayOnPremSettings.enabled && defaultServer) {
			// Lazy auth provider — defers to loginManager at call time.
			// Needed because OAuth auth provider may not be available at plugin load.
			const lazyAuthProvider: IAuthProvider = {
				isLoggedIn: () => this.loginManager.getAuthProvider()?.isLoggedIn() ?? false,
				getCurrentUser: () => this.loginManager.getAuthProvider()?.getCurrentUser(),
				getToken: () => this.loginManager.getAuthProvider()?.getToken(),
				getValidToken: async () => {
					const provider = this.loginManager.getAuthProvider();
					return provider ? await provider.getValidToken() : undefined;
				},
				loginWithPassword: () => Promise.reject(new Error("Use loginManager directly")),
				loginWithOAuth2: () => Promise.reject(new Error("Use loginManager directly")),
				refreshToken: () => {
				const provider = this.loginManager.getAuthProvider();
				if (!provider) return Promise.reject(new Error("No auth provider available"));
				return provider.refreshToken();
			},
				logout: () => Promise.reject(new Error("Use loginManager directly")),
				isTokenValid: () => this.loginManager.getAuthProvider()?.isTokenValid() ?? false,
			};

			relayOnPremTokenProvider = new RelayOnPremTokenProvider({
				controlPlaneUrl: defaultServer.controlPlaneUrl,
				authProvider: lazyAuthProvider,
			});

			// Initialize share client for relay-onprem mode (backward compatibility)
			this.shareClient = new RelayOnPremShareClient(
				defaultServer.controlPlaneUrl,
				async () => {
					const provider = this.loginManager.getAuthProvider();
					return provider ? await provider.getValidToken() : undefined;
				},
			);
		}

		// Wait for auth restoration before using auth state
		await this.loginManager.waitForRestore();

		// Initialize multi-server share client manager
		if (relayOnPremSettings.enabled && relayOnPremSettings.servers.length > 0) {
			const multiServerAuthManager = this.loginManager.getMultiServerAuthManager();
			if (multiServerAuthManager) {
				this.shareClientManager = new RelayOnPremShareClientManager(
					multiServerAuthManager,
					relayOnPremSettings.servers,
				);
			}
		}

		// Initialize WebSyncManager for auto-sync (v1.8.1)
		if (this.shareClientManager) {
			const { WebSyncManager } = await import("./WebSyncManager");
			this.webSyncManager = new WebSyncManager(
				this.vault,
				this.shareClientManager
			);
		}

		// Initialize InboundFileDownloader for sync-artifact inbound sync (v1.9)
		if (this.vault && this.shareClientManager && this.webSyncManager) {
			const { InboundFileDownloader } = await import("./InboundFileDownloader");
			// Persisted across restarts (TR-02, #307f52bf) — see InboundFileDownloader's
			// constructor doc for why an in-memory-only manifest is unsafe.
			const hashManifestStore = new LocalStorage<Record<string, string>>(
				"InboundSyncHashManifest/" + vaultName,
				this.app,
			);
			this.inboundFileDownloader = new InboundFileDownloader(
				this.vault,
				this.shareClientManager,
				this.webSyncManager,
				hashManifestStore,
				// Where a share lives here, which for a vault share is the
				// root, whatever name it carries on the server.
				(shareId: string) => {
					const folder = this.sharedFolders.find(
						(f) => f.guid === shareId && f.isVaultScope,
					);
					return folder ? "" : undefined;
				},
			);
		}

		// Initialize InboundSyncPoller (v1.9)
		if (this.shareClientManager && this.webSyncManager && this.inboundFileDownloader) {
			const { InboundSyncPoller } = await import("./InboundSyncPoller");
			// Persisted across restarts (TR-02, #307f52bf) — see InboundSyncPoller's
			// constructor doc for why an in-memory-only watermark is unsafe.
			const lastUpdatedAtStore = new LocalStorage<string>(
				"InboundSyncLastUpdatedAt/" + vaultName,
				this.app,
			);
			this.inboundSyncPoller = new InboundSyncPoller(
				this.timeProvider,
				this.shareClientManager,
				this.webSyncManager,
				this.inboundFileDownloader,
				undefined,
				lastUpdatedAtStore,
			);
		}

		// Add status bar item for Relay On-Prem (v1.8.2)
		if (relayOnPremSettings.enabled) {
			this.addRelayStatusBarItem();
		}

		this.tokenStore = new LiveTokenStore(
			this.loginManager,
			this.timeProvider,
			vaultName,
			3,
			relayOnPremTokenProvider,
			this.app,
		);

		this.networkStatus = new NetworkStatus(
			this.timeProvider,
			healthUrlForServer(defaultServer),
		);

		this.backgroundSync = new BackgroundSync(
			this.loginManager,
			this.timeProvider,
			this.sharedFolders,
		);

		if (!this.loginManager.setup()) {
			// In relay-onprem mode, setup() returns false because auth is handled
			// asynchronously via waitForRestore(). Only show notice for non-relay-onprem.
			if (!this.loginManager.isRelayOnPremMode()) {
				new Notice("Please sign in to use relay");
			}
		}

		this.app.workspace.onLayoutReady(() => {
			this.sharedFolders.load();
			this._liveViews = new LiveViewManager(
				this.app,
				this.sharedFolders,
				this.loginManager,
				this.networkStatus,
			);

			// NOTE: Extensions list should be loaded once and then mutated.
			// this.app.workspace.updateOptions(); must be called to apply changes.
			this.registerEditorExtension(this._liveViews.extensions);

			this.register(
				this.loginManager.on(() => {
					if (this.loginManager.loggedIn) {
						this._onLogin();
					} else {
						this._onLogout();
					}
				}),
			);

			// If user is already logged in after auth restore, trigger login flow now.
			// This handles the case where auth restored before onLayoutReady fired,
			// so the login listener missed the state change notification.
			if (this.loginManager.loggedIn) {
				this._onLogin();
			}

			this.tokenStore.start();

			// Sync shareClientManager when relay-onprem settings change
			let prevServerIds = new Set(
				this.relayOnPremSettings.get().servers?.map((s: RelayOnPremServer) => s.id) || []
			);
			this.register(
				this.relayOnPremSettings.subscribe((settings) => {
					const currentServers = settings.servers || [];
					const currentIds = new Set(currentServers.map((s: RelayOnPremServer) => s.id));

					// New servers added
					for (const server of currentServers) {
						if (!prevServerIds.has(server.id)) {
							void this.ensureShareClientManager();
							this.shareClientManager?.addServer(server);
						}
					}
					// Removed servers
					for (const id of prevServerIds) {
						if (!currentIds.has(id)) {
							this.shareClientManager?.removeServer(id);
						}
					}
					// Updated servers (URL or name changed)
					for (const server of currentServers) {
						if (prevServerIds.has(server.id) && this.shareClientManager) {
							this.shareClientManager.updateServer(server);
						}
					}
					prevServerIds = currentIds;

					// TR-32: relayOnPremTokenProvider is created once at load and
					// held for the plugin's lifetime by tokenStore — the loop above
					// only keeps shareClientManager in sync, so a default-server URL
					// edit left /tokens/relay requests going to the old host until
					// Obsidian restarted. Re-point it whenever the resolved default
					// server's URL changes.
					const newDefaultServer = getDefaultServer(settings);
					if (
						newDefaultServer &&
						newDefaultServer.controlPlaneUrl !== tokenProviderControlPlaneUrl
					) {
						if (relayOnPremTokenProvider) {
							relayOnPremTokenProvider.updateControlPlaneUrl(newDefaultServer.controlPlaneUrl);
						}
						// TR-26: networkStatus's health-check URL is derived from the
						// same default-server controlPlaneUrl — re-point it too, or a
						// server-URL edit leaves offline/online detection pointed at
						// the old (or no) host until Obsidian restarts.
						this.networkStatus.updateUrl(healthUrlForServer(newDefaultServer));
						tokenProviderControlPlaneUrl = newDefaultServer.controlPlaneUrl;
					}
				})
			);

			if (!Platform.isIosApp) {
				// We can't run network status on iOS or it will always be offline.
				this.networkStatus.addEventListener("offline", () => {
					this.tokenStore.stop();
					this.sharedFolders.forEach((folder) => folder.disconnect());
					this._liveViews.goOffline();
				});
				this.networkStatus.addEventListener("online", () => {
					this.tokenStore.start();
					this.relayManager.subscribe();
					void this.relayManager.update();
					this._liveViews.goOnline();
				});
				this.networkStatus.start();
			}

			this.registerView(
				VIEW_TYPE_DIFFERENCES,
				(leaf) => new DifferencesView(leaf),
			);

			this.registerEvent(
				this.app.workspace.on("file-menu", (menu, file) => {
					if (file instanceof TFolder) {
						const folder = this.sharedFolders.find(
							(sharedFolder) => sharedFolder.path === file.path,
						);
						if (!folder) {
							// Nothing to offer. A vault syncs whole (ADR-0042), so every
							// folder in it is already syncing and the item that used to
							// sit here would be asking somebody to sync a folder twice.
							// Deleting or renaming a folder is how it stops or moves,
							// the way it works in every other sync.
							return;
						}
						if (folder.relayId) {
							// The item that used to sit here opened upstream's relay
							// screen for a relay id our shares do not have, so it
							// landed on the settings screen by accident. There is one
							// server and nothing to configure about it (ADR-0033).
							menu.addItem((item) => {
								item
									.setTitle("Knap Sync: folder settings")
									.setIcon("settings")
									.onClick(() => {
										if (folder.settings?.onpremServerId && this.loginManager.isRelayOnPremMode()) {
											new ShareManagementModal(this.app, this, folder.settings.onpremServerId, undefined, folder.guid).open();
										} else {
											void this.openSettings(`/shared-folders?id=${folder.guid}`);
										}
									});
							});
							menu.addItem((item) => {
								item
									.setTitle(
										folder.connected ? "Knap Sync: disconnect" : "Knap Sync: connect",
									)
									.setIcon("satellite")
									.onClick(() => {
										if (folder.connected) {
											folder.shouldConnect = false;
											folder.disconnect();
										} else {
											folder.shouldConnect = true;
											void folder.connect();
										}
										void this._liveViews.refresh("folder connection toggle");
									});
							});
						} else {
							menu.addItem((item) => {
								item
									.setTitle("Knap Sync: folder settings")
									.setIcon("settings")
									.onClick(() => {
										if (folder.settings?.onpremServerId && this.loginManager.isRelayOnPremMode()) {
											new ShareManagementModal(this.app, this, folder.settings.onpremServerId, undefined, folder.guid).open();
										} else {
											void this.openSettings(`/shared-folders?id=${folder.guid}`);
										}
									});
							});
						}
						if (folder.relayId && folder.connected) {
							menu.addItem((item) => {
								item
									.setTitle("Knap Sync: sync")
									.setIcon("folder-sync")
									.onClick(async () => {
										void folder.netSync();
										// Also update web_folder_items if share is web-published
										if (this.webSyncManager && this.shareClientManager && folder.guid) {
											try {
												const serverId = folder.settings?.onpremServerId;
												if (serverId) {
													const share = await this.shareClientManager.getShare(serverId, folder.guid);
													if (share?.web_published) {
														await this.webSyncManager.syncFolderStructureToWeb(
															folder.path, serverId, folder.guid
														);
													}
												}
											} catch {
												// Web sync is best-effort, don't block CRDT sync
											}
										}
									});
							});
						}
					} else if (file instanceof TFile) {
						const folder = this.sharedFolders.lookup(file.path);
						const ifile = folder?.getFile(file);
						if (ifile && isSyncFile(ifile)) {
							menu.addItem((item) => {
								item
									.setTitle("Knap Sync: download")
									.setIcon("cloud-download")
									.onClick(async () => {
										await ifile.pull();
										new Notice(`Download complete: ${ifile.name}`);
									});
							});
							if (this.debugSettings.get().debugging) {
								menu.addItem((item) => {
									item
										.setTitle("Knap Sync: verify upload")
										.setIcon("search-check")
										.onClick(async () => {
											const present = await ifile.verifyUpload();
											new Notice(
												`${ifile.name} ${present ? "on server" : "missing from server"}`,
											);
										});
								});
							}
							menu.addItem((item) => {
								item
									.setTitle("Knap Sync: upload")
									.setIcon("cloud-upload")
									.onClick(async () => {
										await ifile.push(true);
										const present = await ifile.verifyUpload();
										new Notice(
											`${present ? "File uploaded:" : "File upload failed:"} ${ifile.name}`,
										);
									});
							});
						}
					}
				}),
			);
			this.setup();
			void this._liveViews.refresh("init");
			this.loadTime = moment.now() - start;

		});
	}

	async reload() {
		await (this.app as unknown as ObsidianApp).reloadRelay?.();
	}

	private _createSharedFolder(
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
		scope: ShareScope = "folder",
	): SharedFolder {
		// Initialize settings with pattern matching syntax
		const folderSettings = new NamespacedSettings<SharedFolderSettings>(
			this.settings as unknown as Settings<unknown>,
			`sharedFolders/[guid=${guid}]`,
		);
		const settings: SharedFolderSettings = { guid: guid, path: path, scope };
		if (relayId) {
			settings["relay"] = relayId;
		}
		void folderSettings.update((current) => {
			return {
				...current,
				path,
				guid,
				...(relayId ? { relay: relayId } : {}),
				...{
					sync: current.sync ? current.sync : SyncSettingsManager.defaultFlags,
				},
			};
		}, true);

		const folder = new SharedFolder(
			this.appId,
			guid,
			path,
			this.loginManager,
			this.vault,
			this.fileManager,
			this.tokenStore,
			this.relayManager,
			this.hashStore,
			this.backgroundSync,
			folderSettings,
			this.app,
			relayId,
			awaitingUpdates,
			scope,
		);
		return folder;
	}

	private async loadRelayOnPremShares() {
		const log = curryLog("[RelayOnPrem]", "log");
		const err = curryLog("[RelayOnPrem]", "error");

		try {
			log("Loading existing shares from control plane...");

			// Use multi-server manager if available, otherwise fall back to single client
			if (this.shareClientManager) {
				// Multi-server mode: load from all servers
				const allShares = await this.shareClientManager.getAllSharesFlat();
				log(`Found ${allShares.length} shares across all servers`);

				for (const share of allShares) {
					if (share.kind === "folder") {
						// Find existing by guid OR by path (settings may have old client-side guid)
						const byGuid = this.sharedFolders.find(
							(sf) => sf.guid === share.id
						);
						const byPath = !byGuid ? this.sharedFolders.find(
							(sf) => sf.path === share.path
						) : undefined;
						const existing = byGuid || byPath;

						if (existing && (existing.guid !== share.id || !existing.relayId)) {
							// Migrate: guid mismatch or missing relayId — recreate
							log(`Migrating SharedFolder ${share.path} (guid: ${existing.guid} → ${share.id})`);
							this.sharedFolders.delete(existing);
							const sharedFolder = this.sharedFolders.new(
								share.path,
								share.id,
								"relay-onprem",
								false
							);
							if (sharedFolder && sharedFolder.settings) {
								sharedFolder.settings.onpremServerId = share.serverId;
							}
						} else if (!existing) {
							// Only auto-create if the folder exists locally in vault
							const vaultFolder = this.app.vault.getAbstractFileByPath(share.path);
							if (vaultFolder && vaultFolder instanceof TFolder) {
								const sharedFolder = this.sharedFolders.new(
									share.path,
									share.id,
									"relay-onprem",
									true
								);
								if (sharedFolder && sharedFolder.settings) {
									sharedFolder.settings.onpremServerId = share.serverId;
								}
								log(`Created SharedFolder for ${share.path} on server ${share.serverId}`);
							} else {
								log(`Share "${share.path}" not connected locally (folder not in vault)`);
							}
						} else if (existing && !existing.connected) {
							// Folder exists with correct guid+relayId but not connected
							log(`Connecting SharedFolder ${share.path}`);
							void existing.connect();
						}
					}

					// Register auto-sync shares (v1.8.1) - supports both doc and folder shares
					if (share.web_published && share.web_sync_mode === "auto") {
						if (this.webSyncManager) {
							this.webSyncManager.registerAutoSyncShare(
								share.path,
								share.id,
								share.serverId,
								share.kind,
								share.web_slug ?? undefined
							);
							log(`Registered auto-sync for ${share.kind} ${share.path} on server ${share.serverId}`);
						}
					}

					// Register all folder shares for inbound polling (v1.9)
					if (share.kind === "folder" && this.inboundSyncPoller) {
						this.inboundSyncPoller.registerShare(share.id, share.serverId);
						log(`Registered inbound poller for folder ${share.path} on server ${share.serverId}`);
					}
				}

				// Deferred initial full-sync for stale auto-sync folder shares (v1.1.18)
				const staleAutoSyncShares = allShares.filter(s => {
					if (!s.web_published || s.kind !== "folder" || s.web_sync_mode !== "auto") return false;
					if (!s.web_content_updated_at) return true;
					return Date.now() - new Date(s.web_content_updated_at).getTime() > 6 * 60 * 60 * 1000;
				});
				if (staleAutoSyncShares.length > 0) {
					log(`Scheduling initial full-sync for ${staleAutoSyncShares.length} stale auto-sync shares`);
					window.setTimeout(() => { void this._initialFullSync(staleAutoSyncShares); }, 15_000);
				}
			} else if (this.shareClient) {
				// Single-server mode (legacy)
				const shares = await this.shareClient.listShares();
				log(`Found ${shares.length} shares`);

				// Get default server ID
				const relayOnPremSettings = this.relayOnPremSettings.get();
				const defaultServerId = relayOnPremSettings.defaultServerId ||
					(relayOnPremSettings.servers.length > 0 ? relayOnPremSettings.servers[0].id : "default");

				for (const share of shares) {
					if (share.kind === "folder") {
						// Find existing by guid OR by path (settings may have old client-side guid)
						const byGuid = this.sharedFolders.find(
							(sf) => sf.guid === share.id
						);
						const byPath = !byGuid ? this.sharedFolders.find(
							(sf) => sf.path === share.path
						) : undefined;
						const existing = byGuid || byPath;

						if (existing && (existing.guid !== share.id || !existing.relayId)) {
							// Migrate: guid mismatch or missing relayId — recreate
							log(`Migrating SharedFolder ${share.path} (guid: ${existing.guid} → ${share.id})`);
							this.sharedFolders.delete(existing);
							const sharedFolder = this.sharedFolders.new(
								share.path,
								share.id,
								"relay-onprem",
								false
							);
							if (sharedFolder && sharedFolder.settings) {
								sharedFolder.settings.onpremServerId = defaultServerId;
							}
						} else if (!existing) {
							// Only auto-create if the folder exists locally in vault
							const vaultFolder = this.app.vault.getAbstractFileByPath(share.path);
							if (vaultFolder && vaultFolder instanceof TFolder) {
								const sharedFolder = this.sharedFolders.new(
									share.path,
									share.id,
									"relay-onprem",
									true
								);
								if (sharedFolder && sharedFolder.settings) {
									sharedFolder.settings.onpremServerId = defaultServerId;
								}
								log(`Created SharedFolder for ${share.path}`);
							} else {
								log(`Share "${share.path}" not connected locally (folder not in vault)`);
							}
						} else if (existing && !existing.connected) {
							// Folder exists with correct guid+relayId but not connected
							log(`Connecting SharedFolder ${share.path}`);
							void existing.connect();
						}
					}

					// Register auto-sync shares (v1.8.1) - supports both doc and folder shares
					if (share.web_published && share.web_sync_mode === "auto") {
						if (this.webSyncManager) {
							this.webSyncManager.registerAutoSyncShare(
								share.path,
								share.id,
								defaultServerId,
								share.kind,
								share.web_slug ?? undefined
							);
							log(`Registered auto-sync for ${share.kind} ${share.path}`);
						}
					}

					// Register all folder shares for inbound polling (v1.9)
					if (share.kind === "folder" && this.inboundSyncPoller) {
						this.inboundSyncPoller.registerShare(share.id, defaultServerId);
						log(`Registered inbound poller for folder ${share.path}`);
					}
				}
			} else {
				log("No share client available, skipping share load");
				return;
			}

			// Start inbound poller after all shares registered (v1.9)
			this.inboundSyncPoller?.start();

			// Refresh visual indicators
			this.folderNavDecorations?.quickRefresh();
			log("Relay-onprem shares loaded");
		} catch (error: unknown) {
			err("Failed to load relay-onprem shares:", error);
		}
	}

	/**
	 * Add status bar item with menu for Relay On-Prem (v1.8.3)
	 */
	private addRelayStatusBarItem() {
		const statusBarItem = this.addStatusBarItem();
		statusBarItem.addClass("relay-onprem-statusbar");
		// Use the same registered knap-sync icon as ribbon
		const iconEl = statusBarItem.createSpan({ cls: "relay-status-icon" });
		setIcon(iconEl, "knap-sync");
		statusBarItem.setAttribute("aria-label", "Knap Sync status");
		statusBarItem.setAttribute("data-tooltip-position", "top");
		statusBarItem.addClass("evc-cursor-pointer");

		statusBarItem.addEventListener("click", (event) => {
			const menu = new Menu();

			// Sync All option
			menu.addItem((item) => {
				item
					.setTitle("Sync all shares")
					.setIcon("refresh-cw")
					.onClick(async () => {
						await this.syncAllShares();
					});
			});

			// Sync Current option
			menu.addItem((item) => {
				item
					.setTitle("Sync current file")
					.setIcon("file-sync")
					.onClick(async () => {
						await this.syncCurrentFile();
					});
			});

			menu.addSeparator();

			// Shares option
			menu.addItem((item) => {
				item
					.setTitle("Manage shares")
					.setIcon("folder-shared")
					.onClick(() => {
						new ShareManagementModal(this.app, this).open();
					});
			});

			// Settings option
			menu.addItem((item) => {
				item
					.setTitle("Settings")
					.setIcon("settings")
					.onClick(() => {
						void this.openSettings("/relay-onprem");
					});
			});

			menu.showAtMouseEvent(event);
		});
	}

	/**
	 * Ensure shareClientManager exists, creating it lazily if needed
	 */
	private async ensureShareClientManager(): Promise<void> {
		if (this.shareClientManager) return;
		const settings = this.relayOnPremSettings.get();
		if (!settings.enabled || settings.servers.length === 0) return;
		const multiServerAuthManager = this.loginManager.getMultiServerAuthManager();
		if (!multiServerAuthManager) return;
		this.shareClientManager = new RelayOnPremShareClientManager(
			multiServerAuthManager,
			settings.servers,
		);
		if (!this.webSyncManager) {
			const { WebSyncManager } = await import("./WebSyncManager");
			this.webSyncManager = new WebSyncManager(this.vault, this.shareClientManager);
		}
	}

	/**
	 * Sync all web-published shares
	 */
	private async syncAllShares() {
		if (!this.shareClientManager) {
			new Notice("No share client available");
			return;
		}

		try {
			new Notice("Syncing all shares...");
			const shares = await this.shareClientManager.getAllSharesFlat();

			// 1. Reconnect CRDT relay for all folder shares
			let relaySynced = 0;
			for (const share of shares) {
				if (share.kind === "folder") {
					const folder = this.sharedFolders.find(sf => sf.guid === share.id);
					if (folder) {
						void folder.connect();
						relaySynced++;
					}
				}
			}

			// 2. Sync web-published shares
			// TR-25-followup (#1d244fb4): pushes content directly via
			// shareClientManager, bypassing WebSyncManager's own syncFile()/
			// syncFolderFile() — wrap in the same echo-guard those use so
			// InboundSyncPoller/InboundFileDownloader don't race this manual
			// push the way TR-25 fixed for the debounced auto-sync path.
			const { withOutboundSyncGuard } = await import("./WebSyncManager");
			let webSynced = 0;
			const webShares = shares.filter(s => s.web_published);
			await withOutboundSyncGuard(this.webSyncManager, async () => {
				for (const share of webShares) {
					try {
						if (share.kind === "doc") {
							const file = this.vault.getAbstractFileByPath(share.path);
							if (file instanceof TFile) {
								const content = await this.vault.read(file);
								await this.shareClientManager!.updateShare(share.serverId, share.id, {
									web_content: content,
								});
								webSynced++;
							}
						} else if (share.kind === "folder") {
							const folderAbs = this.vault.getAbstractFileByPath(share.path);
							if (folderAbs instanceof TFolder) {
								// 1. Build recursive folder items and PATCH structure
								const items = this.getFolderItemsRecursive(folderAbs);
								await this.shareClientManager!.updateShare(share.serverId, share.id, {
									web_folder_items: items,
								});
								// 2. POST content for each doc/canvas
								if (share.web_slug) {
									for (const item of items) {
										if (item.type === "doc" || item.type === "canvas") {
											try {
												const filePath = `${share.path}/${item.path}`;
												const f = this.vault.getAbstractFileByPath(filePath);
												if (f instanceof TFile) {
													const content = await this.vault.read(f);
													await this.shareClientManager!.syncFolderFileContent(
														share.serverId, share.web_slug, item.path, content
													);
													webSynced++;
												}
											} catch { /* skip individual file errors */ }
										}
									}
								}
							}
						}
					} catch (e: unknown) {
						console.error(`Failed to sync ${share.path}:`, e);
					}
				}
			});

			const parts = [];
			if (relaySynced > 0) parts.push(`${relaySynced} relay`);
			if (webSynced > 0) parts.push(`${webSynced} web`);
			new Notice(parts.length > 0 ? `Synced: ${parts.join(", ")}` : "No shares to sync");
		} catch (error: unknown) {
			new Notice(`Sync failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private async _initialFullSync(shares: ShareWithServer[]): Promise<void> {
		if (!this.shareClientManager) return;
		this.log("Running initial full-sync for stale auto-sync shares", shares.length);
		// TR-25-followup (#1d244fb4): same echo-guard as syncAllShares() —
		// this pushes content directly, bypassing WebSyncManager's own
		// syncFile()/syncFolderFile().
		const { withOutboundSyncGuard } = await import("./WebSyncManager");
		await withOutboundSyncGuard(this.webSyncManager, async () => {
			for (const share of shares) {
				try {
					const folderAbs = this.vault.getAbstractFileByPath(share.path);
					if (!(folderAbs instanceof TFolder)) {
						this.log("Folder not in vault, skipping initial full-sync", share.path);
						continue;
					}
					const items = this.getFolderItemsRecursive(folderAbs);
					await this.shareClientManager!.updateShare(share.serverId, share.id, {
						web_folder_items: items,
					});
					if (share.web_slug) {
						let syncedCount = 0;
						for (const item of items) {
							if (item.type === "doc" || item.type === "canvas") {
								try {
									const f = this.vault.getAbstractFileByPath(`${share.path}/${item.path}`);
									if (f instanceof TFile) {
										const content = await this.vault.read(f);
										if (!content) {
											this.log("Skipping empty file in initial full-sync", item.path);
											continue;
										}
										await this.shareClientManager!.syncFolderFileContent(
											share.serverId, share.web_slug, item.path, content
										);
										syncedCount++;
										await new Promise<void>(r => window.setTimeout(r, 200));
									}
								} catch (e: unknown) {
									this.log("Failed to sync file in initial full-sync", item.path, String(e));
								}
							}
						}
						this.log("Initial full-sync done for share", share.path, syncedCount, "of", items.length);
					}
					// Bump web_content_updated_at so the stale check won't re-trigger on next startup
					await this.shareClientManager!.updateShare(share.serverId, share.id, {
						web_content_updated_at: new Date().toISOString(),
					});
				} catch (e: unknown) {
					this.log("Initial full-sync failed for share", share.path, String(e));
				}
			}
		});
	}

	/**
	 * Sync the current active file if it's a web-published share (doc or inside folder share)
	 */
	private async syncCurrentFile() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file");
			return;
		}

		if (!this.shareClientManager) {
			new Notice("No share client available");
			return;
		}

		try {
			const shares = await this.shareClientManager.getAllSharesFlat();

			// TR-25-followup (#1d244fb4): same echo-guard as syncAllShares() —
			// pushes content directly, bypassing WebSyncManager's own
			// syncFile()/syncFolderFile().
			const { withOutboundSyncGuard } = await import("./WebSyncManager");
			await withOutboundSyncGuard(this.webSyncManager, async () => {
				// Check direct doc share match
				const docShare = shares.find(s => s.path === activeFile.path && s.web_published);
				if (docShare) {
					const content = await this.vault.read(activeFile);
					await this.shareClientManager!.updateShare(docShare.serverId, docShare.id, {
						web_content: content,
					});
					new Notice(`Synced ${activeFile.name} to web`);
					return;
				}

				// Check if file is inside a folder share
				const folderShare = shares.find(s =>
					s.kind === "folder" && s.web_published && s.web_slug &&
					activeFile.path.startsWith(s.path + "/")
				);
				if (folderShare && folderShare.web_slug) {
					const content = await this.vault.read(activeFile);
					const relativePath = activeFile.path.substring(folderShare.path.length + 1);
					await this.shareClientManager!.syncFolderFileContent(
						folderShare.serverId, folderShare.web_slug, relativePath, content
					);
					new Notice(`Synced ${activeFile.name} to web`);
					return;
				}

				new Notice("Current file is not in a web-published share");
			});
		} catch (error: unknown) {
			new Notice(`Sync failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	/**
	 * Recursively build folder items for web publishing
	 */
	private getFolderItemsRecursive(folder: TFolder): FolderItem[] {
		const items: FolderItem[] = [];
		const basePath = folder.path;
		const process = (f: TFolder) => {
			for (const child of f.children) {
				const rel = child.path.substring(basePath.length + 1);
				if (child instanceof TFile) {
					if (child.extension === "canvas") {
						items.push({ path: rel, name: child.basename, type: "canvas" });
					} else if (child.extension === "md") {
						items.push({ path: rel, name: child.basename, type: "doc" });
					}
				} else if (child instanceof TFolder) {
					items.push({ path: rel, name: child.name, type: "folder" });
					process(child);
				}
			}
		};
		process(folder);
		return items;
	}

	private _onLogout() {
		this.tokenStore?.clear();
		this.relayManager?.logout();
		void this._liveViews.refresh("logout");
	}

	private _onLogin() {
		this.sharedFolders.load();

		// Load relay-onprem shares after login
		if (this.shareClient || this.shareClientManager) {
			void this.loadRelayOnPremShares();
		}
		this.relayManager?.login();
		void this._liveViews.refresh("login");
	}

	async openSettings(path: string = "/") {
		const setting = (this.app as unknown as ObsidianApp).setting;
		await setting.open();
		await setting.openTabById("knap-sync");
		this.settingsTab.navigateTo(path);
	}

	patchWebviewer(): void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed to preserve `this` reference inside getPatcher callback functions
		const plugin = this;
		try {
			if (this.webviewerPatched) {
				return;
			}

			const webviewer = (this.app as unknown as ObsidianApp).internalPlugins?.plugins?.webviewer;
			if (!webviewer?.instance?.options || !webviewer.enabled) {
				this.warn("Webviewer plugin not found or not initialized");
				return;
			}

			const options = webviewer.instance.options;
			const originalDesc = Object.getOwnPropertyDescriptor(
				options,
				"openExternalURLs",
			);

			if (!originalDesc) {
				this.warn("Could not find openExternalURLs property");
				return;
			}

			// Capture the open-url event in a closure so the getter below can access it
			// without relying on the deprecated window.event global
			let capturedOpenUrlEvent: { type?: string; detail?: { url?: string } } | undefined;
			const openUrlListener = (e: Event) => {
				capturedOpenUrlEvent = e;
			};
			activeWindow.addEventListener("open-url", openUrlListener, true);

			Object.defineProperty(options, "openExternalURLs", {
				get(): boolean | undefined {
					const currentEvent = capturedOpenUrlEvent;
					if (currentEvent?.type === "open-url" && currentEvent?.detail?.url) {
						const url = currentEvent.detail.url;
						for (const pattern of plugin.interceptedUrls) {
							if (
								(typeof pattern === "string" && url.startsWith(pattern)) ||
								(pattern instanceof RegExp && pattern.test(url))
							) {
								plugin.log(
									"Intercepted webviewer, opening in default browser",
									currentEvent.detail.url,
								);
								return false;
							}
						}
					}
					return originalDesc.value as boolean | undefined;
				},
				set(value: boolean) {
					originalDesc.value = value;
				},
				configurable: true,
			});

			this.register(() => {
				window.removeEventListener("open-url", openUrlListener, true);
				Object.defineProperty(options, "openExternalURLs", originalDesc);
			});

			const intercepts = this.loginManager.getWebviewIntercepts();
			intercepts.forEach((intercept) => {
				this.debug("Intercepting Webviewer for URL pattern", intercept.source);
				this.interceptedUrls.push(intercept);
			});

			const apiUrl = this.loginManager.getEndpointManager().getApiUrl();
			const apiRegExp = new RegExp(apiUrl.replace("/", "\\/") + ".*");
			this.debug("Intercepting Webviewer for URL pattern", apiRegExp.source);
			this.interceptedUrls.push(apiRegExp);

			this.webviewerPatched = true;
			this.debug("patched webviewer options");
		} catch (error: unknown) {
			this.error("Failed to patch webviewer:", error);
		}
	}

	setup() {
		this.folderNavDecorations = new FolderNavigationDecorations(
			this.vault,
			this.app.workspace,
			this.sharedFolders,
			this.backgroundSync,
		);
		this.folderNavDecorations.refresh();

		// Load relay-onprem shares if enabled
		if (this.shareClient || this.shareClientManager) {
			void this.loadRelayOnPremShares();
		}

		this.addSettingTab(this.settingsTab);

		const workspaceLog = curryLog("[Live][Workspace]", "log");

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				workspaceLog("file-open");
				void plugin._liveViews.refresh("file-open");
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				workspaceLog("layout-change");
				void this._liveViews.refresh("layout-change");
			}),
		);

		const vaultLog = curryLog("[Knap Sync][Vault]", "log");

		const handlePromiseRejection = (event: PromiseRejectionEvent): void => {
			//event.preventDefault();
		};
		const rejectionListener = (event: PromiseRejectionEvent) =>
			handlePromiseRejection(event);
		activeWindow.addEventListener("unhandledrejection", rejectionListener, true);
		this.register(() =>
			activeWindow.removeEventListener("unhandledrejection", rejectionListener, true),
		);

		this.registerEvent(
			this.app.vault.on("create", (tfile) => {
				// NOTE: this is called on every file at startup...
				const folder = this.sharedFolders.lookup(tfile.path);
				if (folder) {
					// claimAndUploadFile() runs the same upload-claim protection
					// addLocalDocs() has (TR-15-follow-up, #7c14871a) -- this event
					// fires for pre-existing files too, so it can race a second
					// client discovering the SAME brand-new vpath at once, same as
					// the initial-sync path.
					void folder.claimAndUploadFile(tfile);
				}
				// Update web_folder_items for auto-sync folder shares
				if (this.webSyncManager && tfile instanceof TFile) {
					void this.webSyncManager.onFileCreated(tfile);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFolder) {
					const folder = this.sharedFolders.find(
						(folder) => folder.path === file.path,
					);
					if (folder) {
						this.sharedFolders.delete(folder);
						return;
					}
				}
				const folder = this.sharedFolders.lookup(file.path);
				if (folder) {
					vaultLog("Delete", file.path);
					const vpath = folder.getVirtualPath(file.path);
					// A folder goes with everything in it, so everything in it is
					// pending too. Without the children on the list, an inbound
					// event for one of them arriving mid-delete would write the
					// note back to a folder that is on its way out.
					const pending = folder.deleteWithDescendants(vpath);
					pending.forEach((path) => folder.markPendingDelete(path));
					void folder.whenReady().then((folder) => {
						folder.proxy.deleteFile(file.path);
					}).finally(() => {
						pending.forEach((path) => folder.clearPendingDelete(path));
					});
				}
				// Update web_folder_items for auto-sync folder shares
				void this.webSyncManager?.onFileDeleted(file.path);
			}),
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				// TODO this doesn't work for empty folders.
				if (file instanceof TFolder) {
					const sharedFolder = this.sharedFolders.find((folder) => {
						return folder.path == oldPath;
					});
					if (sharedFolder) {
						sharedFolder.move(file.path);
						this.sharedFolders.update();
						return;
					}
				}
				const fromFolder = this.sharedFolders.lookup(oldPath);
				const toFolder = this.sharedFolders.lookup(file.path);
				const folder = fromFolder || toFolder;
				if (fromFolder && toFolder) {
					// between two shared folders
					vaultLog("Rename", file.path, oldPath);
					fromFolder.renameFile(file, oldPath);
					toFolder.renameFile(file, oldPath);
					void this._liveViews.refresh("rename");
					this.folderNavDecorations.quickRefresh();
				} else if (folder) {
					vaultLog("Rename", file.path, oldPath);
					folder.renameFile(file, oldPath);
					void this._liveViews.refresh("rename");
					this.folderNavDecorations.refresh();
				}
				// Update web_folder_items for auto-sync folder shares
				void this.webSyncManager?.onFileRenamed(file.path, oldPath);
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (tfile) => {
				// InboundFileDownloader writes sync-artifact content via
				// vault.adapter.writeBinary(), which still fires this "modify" event
				// (the underlying file-system watcher doesn't distinguish it from a
				// user edit) — without this guard, our own inbound download for an
				// unconnected Document was mistaken for a local edit and enqueued
				// right back out via backgroundSync.enqueueSync(), which reconciles
				// by diffing the vault file against the Y.Doc's CURRENT text
				// (BackgroundSync.ts syncDocumentWebsocket). If a second client's
				// edit had merged into that Y.Doc between the inbound write and this
				// handler firing, the echoed sync would treat the (now-stale)
				// inbound content as the "local edit" and reconcile against it,
				// demoting the second client's genuine edit into a conflict-copy
				// file (TR-01's reconcileWithConflictCopy prevents outright data
				// loss, but this is still a spurious, avoidable conflict).
				// Previously only the web-auto-sync branch below checked this
				// (v1.9); this mirrors the same guard onto the SharedFolder/Document
				// path (U4).
				const isInboundEcho =
					this.inboundFileDownloader?.isInboundWriting(tfile.path) ?? false;

				const folder = this.sharedFolders.lookup(tfile.path);
				if (folder) {
					vaultLog("Modify", tfile.path);
					if (!isInboundEcho) {
						const file = folder.proxy.getFile(tfile);
						if (file && isSyncFile(file)) {
							void file.sync();
						}
						// For Documents (folder share files): if the file has no active
						// WS connection, edits bypass Y.Text entirely (no live CM binding).
						// Enqueue a background sync to push vault content to relay.
						// When connected, LiveCMPluginValue handles sync automatically.
						if (file && isDocument(file) && !file.connected) {
							void folder.backgroundSync.enqueueSync(file);
						}
					}
					// Trigger metadata resolve with the actual TFile (not our Document proxy)
					this.timeProvider.setTimeout(() => {
						this.app.metadataCache.trigger("resolve", tfile);
					}, 500);
				}

				// Handle auto-sync to web (v1.8.1); skip if InboundFileDownloader is writing (echo-loop guard, v1.9)
				if (this.webSyncManager && tfile instanceof TFile && !isInboundEcho) {
					void this.webSyncManager.onFileModified(tfile);
				}
			}),
		);

		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed to preserve `this` reference inside getPatcher callback functions where `this` is rebound
		const plugin = this;

		getPatcher().patch(MarkdownView.prototype, {
			// When this is called, the active editors haven't yet updated.
			onUnloadFile(old: unknown) {
				return function (this: unknown, file: unknown) {
					plugin._liveViews.wipe();
					return (old as (...args: unknown[]) => unknown).call(this, file);
				};
			},
		});

		getPatcher().patch(this.app.vault, {
			process(old: unknown) {
				return function (
					this: unknown,
					tfile: unknown,
					fn: (data: string) => string,
					options: unknown,
				) {
					try {
						const tfileTyped = tfile as { path?: string };
						const folder = tfileTyped.path ? plugin.sharedFolders.lookup(tfileTyped.path) : undefined;
						if (folder) {
							if (!(tfile instanceof TFile)) return;
						const file = folder.proxy.getFile(tfile);
							if (file && isDocument(file)) {
								file.process(fn);
							}
						}
					} catch (e: unknown) {
						plugin.log(e);
					}

					return (old as (...args: unknown[]) => unknown).call(this, tfile, fn, options);
				};
			},
		});

		this.patchWebviewer();

		withFlag(flag.enableNewLinkFormat, () => {
			getPatcher().patch(MetadataCache.prototype, {
				fileToLinktext(next: unknown) {
					const old = next as (
						file: TFile,
						sourcePath: string,
						omitMdExtension?: boolean,
					) => string;
					return function (
						file: TFile,
						sourcePath: string,
						omitMdExtension?: boolean,
					) {
						const folder = plugin.sharedFolders.lookup(file.path);
						if (folder) {
							if (omitMdExtension === void 0) {
								omitMdExtension = true;
							}

							const fileName =
								file.extension === "md" && omitMdExtension
									? file.basename
									: file.name;
							const normalizedFileName = normalizePath(file.name);
							const destinationFiles = (
								plugin.app.metadataCache as unknown as { uniqueFileLookup: Map<string, TFile[]> }
							).uniqueFileLookup.get(normalizedFileName.toLowerCase());

							// If there are no conflicts (unique file), return the fileName
							if (
								destinationFiles &&
								destinationFiles.length === 1 &&
								destinationFiles[0] === file
							) {
								return fileName;
							} else {
								// If there are conflicts, use the relative path
								const filePath =
									file.extension === "md" && omitMdExtension
										? file.path.slice(0, file.path.length - 3)
										: file.path;
								const rpath = relative(sourcePath, filePath);
								if (rpath === "../" + fileName) {
									return "./" + fileName;
								}
								return rpath;
							}
						}
						// @ts-ignore
						return old.call(this, file, sourcePath, omitMdExtension);
					};
				},
			});
		});

		interface Parameters {
			action: string;
			relay?: string;
			id?: string;
			version?: string;
		}

		// The OAuth callback. Registered at load rather than at sign-in,
		// because the browser may come back after Obsidian was restarted and
		// a handler registered per flow would not be there to catch it.
		this.registerObsidianProtocolHandler(OAUTH_CALLBACK_ACTION, (e) => {
			oauthDeepLinkReceiver.handleCallback(e as unknown as Record<string, string>);
		});

		this.registerObsidianProtocolHandler("knap-sync/settings/relays", (e) => {
			const parameters = e as unknown as Parameters;
			const query = new URLSearchParams({ ...parameters }).toString();
			const path = `/${parameters.action.split("/").slice(-1).join("")}?${query}`;
			void this.openSettings(path);
		});

		this.registerObsidianProtocolHandler(
			"knap-sync/settings/shared-folders",
			(e) => {
				const parameters = e as unknown as Parameters;
				const query = new URLSearchParams({ ...parameters }).toString();
				const path = `/${parameters.action.split("/").slice(-1).join("")}?${query}`;
				void this.openSettings(path);
			},
		);

		this.registerObsidianProtocolHandler("knap-sync/billing-ok", (e) => {
			new Notice("Payment successful! Refreshing billing data...");
			// Clear billing cache by refreshing settings
			void this.openSettings();
		});

		this.backgroundSync.start();
	}

	removeCommand(command: string): void {
		// [Polyfill] removeCommand was added in 1.7.2
		if (requireApiVersion("1.7.2")) {
			// @ts-ignore
			super.removeCommand(command);
		} else {
			const appAny = this.app as unknown as ObsidianApp;
			const appCommands = appAny.commands;
			const qualifiedCommand = `knap-sync:${command}`;
			if (
				Object.prototype.hasOwnProperty.call(appCommands.commands, qualifiedCommand) ||
				appAny.hotkeyManager.removeDefaultHotkeys(qualifiedCommand)
			) {
				delete appCommands.commands[qualifiedCommand];
				delete appCommands.editorCommands[qualifiedCommand];
			}
		}
	}

	onunload() {
		// Save settings before cleanup to persist any changes
		// Must await to ensure settings are persisted before destroying namespaced settings
		void this.settings?.save();

		// Cleanup all monkeypatches and destroy the singleton
		Patcher.destroy();

		this.timeProvider?.destroy();

		this.folderNavDecorations?.destroy();

		// Note: detachLeavesOfType should not be called in onunload (Obsidian handles leaf cleanup)

		this._liveViews?.destroy();
		this._liveViews = null as unknown as LiveViewManager;

		this.relayManager?.destroy();
		this.relayManager = null as unknown as RelayManager;

		this.tokenStore?.stop();
		this.tokenStore?.clearState();
		this.tokenStore?.destroy();
		this.tokenStore = null as unknown as LiveTokenStore;

		this.networkStatus?.stop();
		this.networkStatus?.destroy();
		this.networkStatus = null as unknown as NetworkStatus;

		this.openModals.forEach((modal) => {
			modal.close();
		});
		this.openModals.length = 0;

		this.sharedFolders?.destroy();
		this.sharedFolders = null as unknown as SharedFolders;

		this.settingsTab?.destroy();
		this.settingsTab = null as unknown as LiveSettingsTab;

		this.loginManager?.destroy();
		this.loginManager = null as unknown as LoginManager;

		this.backgroundSync?.destroy();
		this.backgroundSync = null as unknown as BackgroundSync;

		// Cleanup InboundSyncPoller (v1.9)
		if (this.inboundSyncPoller) {
			this.inboundSyncPoller.destroy();
			this.inboundSyncPoller = undefined;
		}

		// Cleanup InboundFileDownloader (v1.9)
		if (this.inboundFileDownloader) {
			this.inboundFileDownloader.destroy();
			this.inboundFileDownloader = undefined;
		}

		// Cleanup WebSyncManager (v1.8.1)
		if (this.webSyncManager) {
			this.webSyncManager.destroy();
			this.webSyncManager = undefined;
		}

		this.hashStore.destroy();
		this.hashStore = null as unknown as ContentAddressedFileStore;

		this.app?.workspace.updateOptions();
		(this.app as unknown as ObsidianApp).reloadRelay = undefined;
		this.app = null as unknown as App;
		this.fileManager = null as unknown as FileManager;
		this.manifest = null as unknown as PluginManifest;
		this.vault = null as unknown as Vault;

		this.debugSettings.destroy();
		this.debugSettings = null as unknown as NamespacedSettings<DebugSettings, Record<string, unknown>>;
		this.folderSettings.destroy();
		this.folderSettings = null as unknown as NamespacedSettings<SharedFolderSettings[], Record<string, unknown>>;

		// Destroy FeatureFlagManager before destroying featureSettings
		FeatureFlagManager.destroy();

		this.featureSettings.destroy();
		this.featureSettings = null as unknown as NamespacedSettings<FeatureFlags, Record<string, unknown>>;
		this.loginSettings.destroy();
		this.loginSettings = null as unknown as NamespacedSettings<LoginSettings, Record<string, unknown>>;
		this.endpointSettings.destroy();
		this.endpointSettings = null as unknown as NamespacedSettings<EndpointSettings, Record<string, unknown>>;
		this.relayOnPremSettings.destroy();
		this.relayOnPremSettings = null as unknown as NamespacedSettings<RelayOnPremSettings, Record<string, unknown>>;

		this.interceptedUrls.length = 0;
		PostOffice.destroy();

		this.notifier = null as unknown as ObsidianNotifier;

		auditTeardown();
		void flushLogs();
	}

	loadSettings() {
		void this.settings.load();
	}

	async saveSettings() {
		await this.settings.save();
	}
}
