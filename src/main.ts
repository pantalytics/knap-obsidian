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
import { LiveViewManager } from "./LiveViews";

import { SharedFolders } from "./SharedFolder";
import { FolderNavigationDecorations } from "./ui/FolderNav";
import { LiveSettingsTab } from "./ui/SettingsTab";
import { LoginManager, type LoginSettings } from "./LoginManager";
import { EndpointConfigModal } from "./ui/EndpointConfigModal";
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
import { FeatureFlagManager, flags, withFlag } from "./flagManager";
import { PostOffice } from "./observable/Postie";
import { BackgroundSync } from "./BackgroundSync";
import { FeatureFlagToggleModal } from "./ui/FeatureFlagModal";
import { DebugModal } from "./ui/DebugModal";
import { NamespacedSettings, Settings } from "./SettingsStorage";
import { ObsidianFileAdapter, ObsidianNotifier } from "./debugObsididan";
import { BugReportModal } from "./ui/BugReportModal";
import { IndexedDBAnalysisModal } from "./ui/IndexedDBAnalysisModal";

import { SyncSettingsManager } from "./SyncSettings";
import { ContentAddressedFileStore, isSyncFile } from "./SyncFile";
import { isDocument } from "./Document";
import { EndpointManager, type EndpointSettings } from "./EndpointManager";
import { SelfHostModal } from "./ui/SelfHostModal";
import {
	DEFAULT_RELAY_ONPREM_SETTINGS,
	EVC_SERVER_ID,
	type RelayOnPremSettings,
	type RelayOnPremServer,
	migrateRelayOnPremSettings,
	getDefaultServer,
} from "./RelayOnPremConfig";
import { RelayOnPremTokenProvider } from "./auth/RelayOnPremTokenProvider";
import type { IAuthProvider } from "./auth/IAuthProvider";
import { RelayOnPremShareClient, type FolderItem } from "./RelayOnPremShareClient";
import { RelayOnPremShareClientManager } from "./RelayOnPremShareClientManager";
import { QuickShareModal } from "./ui/QuickShareModal";
import { confirmDialog } from "./ui/dialogs";

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

declare const HEALTH_URL: string;
declare const GIT_TAG: string;

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
	 * Open endpoint configuration modal
	 */
	openEndpointConfigurationModal() {
		const modal = new EndpointConfigModal(this.app, this, () => {
			void this.reload();
		});
		modal.open();
	}

	/**
	 * Validate and apply custom endpoints
	 */
	async validateAndApplyEndpoints() {
		const settings = this.endpointSettings.get();

		if (!settings.activeTenantId || !settings.tenants?.length) {
			new Notice("Please configure an enterprise tenant first", 4000);
			return;
		}

		const notice = new Notice("Validating endpoints...", 0);

		try {
			const result = await this.loginManager.validateAndApplyEndpoints();
			notice.hide();

			if (result.success) {
				// Clear any previous validation errors on success
				await this.endpointSettings.update((current) => ({
					...current,
					_lastValidationError: undefined,
					_lastValidationAttempt: undefined,
				}));
				new Notice("Endpoints validated and applied successfully!", 5000);
				if (result.licenseInfo) {
					this.log("License validation successful:", result.licenseInfo);
				}
			} else {
				// Store validation error for display in settings
				await this.endpointSettings.update((current) => ({
					...current,
					_lastValidationError: result.error,
					_lastValidationAttempt: Date.now(),
				}));
				new Notice(`❌ Validation failed: ${result.error}`, 8000);
			}
		} catch (error: unknown) {
			notice.hide();
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			// Store validation error for display in settings
			await this.endpointSettings.update((current) => ({
				...current,
				_lastValidationError: errorMessage,
				_lastValidationAttempt: Date.now(),
			}));
			new Notice(`❌ Validation error: ${errorMessage}`, 8000);
		}
	}

	/**
	 * Reset to default endpoints
	 */
	resetToDefaultEndpoints() {
		this.loginManager.getEndpointManager().clearValidatedEndpoints();
		void this.endpointSettings.update(() => ({}));
		new Notice("Reset to default endpoints", 3000);
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

		this.debug = curryLog("[System 3][Relay]", "debug");
		this.log = curryLog("[System 3][Relay]", "log");
		this.warn = curryLog("[System 3][Relay]", "warn");
		this.error = curryLog("[System 3][Relay]", "error");

		this.settings = new Settings(this, DEFAULT_SETTINGS);
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
		// If an existing server was adopted as EVC, migrate its localStorage auth key
		// and update all shared folder settings that reference the old server ID
		if (migration.renamedServerId) {
			const oldId = migration.renamedServerId;
			const vaultName = this.app.vault.getName();
			const prefix = "evc-team-relay_onprem_auth_";
			const oldKey = `${prefix}${vaultName}_${oldId}`;
			const newKey = `${prefix}${vaultName}_${EVC_SERVER_ID}`;
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
						return { ...f, onpremServerId: EVC_SERVER_ID };
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

		// Register custom EVC Relay icon
		addIcon("evc-relay", `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><g transform="scale(0.333333)"><g><path fill="currentColor" d="M 11.914969 99.237534 C 24.033806 99.046112 36.213295 99.289841 48.341644 99.170944 C 51.59132 99.138855 54.709785 100.099091 56.287449 103.287704 C 58.8848 108.536697 61.970402 113.782532 64.009758 119.258606 C 65.717018 124.316162 60.033283 130.881668 54.537395 129.028961 C 49.582062 127.358566 47.504257 120.03772 45.145096 115.681992 C 41.199928 115.644348 37.254375 115.630478 33.309204 115.641174 C 31.607891 115.639969 27.951637 115.53891 26.411209 115.806808 L 26.183739 116.165878 C 26.220995 117.831924 55.919304 174.47226 58.774639 179.955078 L 89.279808 179.928101 C 91.172134 176.000397 93.297867 171.989853 95.29287 168.100174 C 97.119392 164.547714 98.928131 158.911163 103.1063 157.727798 C 104.985542 157.212601 106.993217 157.48172 108.670761 158.473236 C 111.701668 160.298203 113.50206 164.976105 112.27549 168.30307 C 110.644325 172.727768 108.047783 177.048218 105.977509 181.306061 C 104.063759 185.241699 102.030739 189.213013 99.927589 193.049194 C 98.963799 194.505203 97.083336 195.794769 95.299988 195.959625 C 91.153107 196.343262 86.709808 196.090393 82.535988 196.124481 L 64.463516 196.170471 C 61.042667 196.18277 57.48547 196.250519 54.070545 196.130829 C 53.020763 196.094376 50.863697 195.683426 50.079811 195.072327 C 48.939274 194.183029 47.711941 192.606934 47.029503 191.308258 C 44.950912 187.350815 42.906799 183.33786 40.866241 179.360626 L 27.982546 154.259003 L 13.372949 126.231491 C 10.72765 121.150925 6.464263 113.902206 4.774438 108.342514 C 4.267175 106.672913 5.326883 103.239365 6.512603 101.882019 C 8.067284 100.102249 9.543509 99.446381 11.914969 99.237534 Z"/><path fill="currentColor" d="M 96.765511 99.206619 C 104.64196 98.855881 112.642067 99.161423 120.531998 99.149155 C 125.15921 99.141632 133.149017 98.681122 137.281616 99.417038 C 138.877914 99.701202 140.38623 101.225372 141.28067 102.524033 C 142.465607 104.246368 143.15477 106.884125 142.723587 108.977005 C 142.127579 111.869965 131.412796 132.920242 129.553772 135.769623 C 128.994995 136.625641 128.348618 137.31601 127.489838 137.879532 C 125.958946 138.884155 123.912041 139.336716 122.10968 138.944778 C 119.988678 138.483887 118.224754 137.024307 117.105209 135.197754 C 113.812767 129.825134 117.837166 124.246414 120.330299 119.512619 C 120.819336 118.584473 121.585373 117.38092 121.758942 116.345383 C 121.811264 116.031128 121.686035 115.97287 121.521179 115.72757 C 119.903885 115.250809 105.285164 115.594818 102.599846 115.600342 C 100.726547 118.87854 98.589294 123.348801 96.784935 126.824341 C 95.811234 128.946915 94.195511 131.818924 93.090225 133.941879 L 85.836746 147.964966 C 83.232254 153.157272 80.585785 158.328217 77.896873 163.477722 C 76.897804 165.36055 75.342743 168.486938 74.166519 170.174789 L 73.581581 170.210052 C 72.546432 169.047714 66.1371 156.252777 64.921638 153.907471 C 65.589813 152.263626 67.242775 149.362717 68.123344 147.697067 L 73.751602 136.890366 C 79.474556 125.851044 85.262115 114.852127 91.068687 103.857193 C 92.470428 101.202377 93.881645 100.01944 96.765511 99.206619 Z"/></g><g><path fill="currentColor" d="M 229.592743 80.346909 C 225.620056 81.464081 222.799362 78.789856 219.698334 76.720947 L 211.969116 71.582443 C 210.270462 70.453598 208.56575 69.333633 206.854858 68.223083 C 205.807663 67.542068 203.431625 66.137802 202.741852 65.300659 C 199.394806 61.237976 201.1017 54.953613 206.419769 53.831467 C 210.131241 53.048584 212.647934 55.291641 215.396652 57.044693 C 215.197998 56.612656 214.99588 56.181946 214.790176 55.753128 C 206.48027 38.370483 191.632401 24.979767 173.486664 18.503357 C 155.566162 12.226807 135.899277 13.225739 118.706818 21.285645 C 102.899513 28.707184 90.333931 41.629028 83.35743 57.637833 C 82.531479 59.514069 81.796463 61.429108 81.155586 63.376297 C 80.675835 64.869034 80.260368 66.37413 79.768669 67.865723 C 78.550438 71.560181 74.3181 73.636627 70.640404 72.193039 C 68.903053 71.499191 67.51226 70.144241 66.773537 68.425507 C 66.33036 67.429642 66.114784 66.34761 66.142128 65.257996 C 66.195793 63.067215 68.387192 57.190826 69.22052 55.006943 C 70.202843 52.332474 71.779228 49.05687 73.085312 46.543411 C 81.885345 29.671783 96.01577 16.182495 113.277481 8.174713 C 134.042603 -1.336609 157.720856 -2.27594 179.174255 5.560577 C 197.290985 12.225525 212.627197 24.811676 222.698181 41.280365 C 225.095444 45.167862 226.856827 48.729919 228.759521 52.852127 C 229.574036 50.892975 230.491577 48.96637 231.304245 47.016327 C 232.823837 43.370514 237.393616 41.796753 240.898041 43.603424 C 242.446838 44.41243 243.606079 45.809433 244.115341 47.481049 C 244.723312 49.409882 244.483749 50.598175 243.77037 52.457092 C 243.269394 53.762375 242.740311 55.066391 242.223953 56.366257 L 238.624496 65.430374 C 237.718628 67.701248 236.82666 69.977524 235.948349 72.259262 C 234.42601 76.225433 234.068451 78.94632 229.592743 80.346909 Z"/><path fill="currentColor" d="M 81.009193 214.557129 C 84.981888 213.439941 87.802574 216.114166 90.903603 218.18309 L 98.632828 223.321594 C 100.331482 224.450439 102.036186 225.570389 103.747086 226.680939 C 104.794273 227.361969 107.170319 228.766235 107.860092 229.603363 C 111.207138 233.666046 109.500237 239.950424 104.182167 241.072556 C 100.470695 241.855438 97.954002 239.612396 95.205276 237.859344 C 95.403946 238.291367 95.606056 238.722076 95.811752 239.150909 C 104.121674 256.533569 118.969536 269.924255 137.11528 276.400665 C 155.035782 282.677216 174.702667 281.678284 191.895126 273.618408 C 207.702423 266.196838 220.268005 253.274994 227.244507 237.26619 C 228.07045 235.389969 228.805481 233.474915 229.44635 231.52774 C 229.926102 230.035004 230.341568 228.529907 230.833267 227.0383 C 232.051498 223.343842 236.283844 221.267395 239.961533 222.710999 C 241.698883 223.404846 243.089676 224.759796 243.8284 226.478516 C 244.271576 227.47438 244.487152 228.556427 244.459808 229.646027 C 244.406143 231.836807 242.214752 237.713196 241.381409 239.897095 C 240.399094 242.571548 238.822708 245.847153 237.516632 248.360611 C 228.716599 265.232239 214.586166 278.721558 197.324463 286.729309 C 176.559341 296.240662 152.881088 297.179962 131.427689 289.343445 C 113.310944 282.678497 97.974739 270.092346 87.903755 253.623657 C 85.506485 249.73616 83.745117 246.174103 81.842415 242.051895 C 81.027901 244.011047 80.110359 245.937653 79.297691 247.887695 C 77.778099 251.533524 73.208321 253.107269 69.703888 251.300598 C 68.155106 250.491608 66.99585 249.094589 66.486595 247.422974 C 65.878624 245.494141 66.118187 244.305847 66.831558 242.44693 C 67.332535 241.141663 67.861626 239.837631 68.377975 238.537781 L 71.977432 229.473663 C 72.883316 227.202789 73.775284 224.926498 74.653587 222.64476 C 76.175934 218.678589 76.533493 215.957703 81.009193 214.557129 Z"/></g><g><path fill="currentColor" d="M 244.770096 96.388397 C 241.608612 94.792068 239.73555 93.846298 235.701004 94.020554 C 232.660995 94.280548 231.450714 94.94342 228.81105 96.262756 L 224.349686 98.486786 L 210.462036 105.391602 L 195.45816 112.83522 L 190.458542 115.298233 C 187.985382 116.518234 186.030899 117.332047 184.2229 119.549362 C 182.416779 121.764114 181.613113 124.538849 181.835648 127.392609 C 182.110916 130.461609 183.489136 133.133301 185.893967 135.078339 C 187.230026 136.158859 189.085464 136.964081 190.649475 137.725021 L 194.619629 139.686066 L 211.814667 148.176056 L 224.883926 154.615067 C 226.7155 155.516632 230.004898 157.27359 231.793304 157.949051 C 233.699203 158.663101 235.737015 158.956085 237.766968 158.807877 C 240.468796 158.607788 242.251343 157.715363 244.591873 156.544388 L 249.116989 154.276337 L 263.0495 147.364243 L 278.732574 139.587021 L 283.125916 137.406158 C 283.994324 136.979523 285.108246 136.467285 285.921356 135.994781 C 287.058746 135.345322 288.077362 134.507217 288.933472 133.516327 C 292.887177 128.926895 292.202576 121.467407 287.469788 117.74881 C 285.887634 116.505646 284.056183 115.782028 282.262939 114.896622 L 275.540497 111.566772 L 252.542023 100.239471 L 245.657806 96.835022 C 245.349777 96.681107 245.054718 96.53212 244.770096 96.388397 Z M 241.139893 104.779465 C 241.490112 104.967133 241.83017 105.149338 242.156433 105.312271 L 247.808517 108.094299 L 265.681885 116.901123 L 277.893036 122.924942 C 279.119019 123.541245 280.394623 124.112076 281.591187 124.766373 C 282.75589 125.403381 282.643677 127.456345 281.505005 128.032333 C 279.477478 129.057816 277.424805 130.03212 275.390717 131.042313 L 261.775757 137.794754 L 246.846924 145.220947 L 242.338379 147.434845 C 240.90715 148.151047 238.760712 149.438782 237.212997 149.6483 L 237.148453 149.649445 C 236.347702 149.663651 235.647308 149.676086 234.891327 149.331024 C 233.58844 148.736313 232.286835 148.08429 231.001511 147.45256 L 223.175995 143.555893 L 204.295868 134.250107 L 195.354401 129.827896 C 194.165131 129.243332 192.837936 128.682358 191.715118 128.004044 C 190.906601 127.515671 190.698929 125.983231 191.362244 125.297623 C 191.670105 124.979477 191.9841 124.746521 192.38829 124.553268 C 194.808578 123.333267 197.254578 122.160583 199.679993 120.952164 L 217.786179 111.978394 L 228.762894 106.523834 C 230.4151 105.697876 234.647781 103.327927 236.219528 103.164276 C 237.851334 103.017334 239.59465 103.951477 241.139893 104.779465 Z"/><path fill="currentColor" d="M 288.635193 145.318848 C 290.814087 145.186493 292.598328 145.987595 293.498627 148.10202 C 294.312836 150.014343 293.518768 152.689163 291.679047 153.712357 C 290.540222 154.345657 289.282776 154.924774 288.097656 155.513046 L 281.490692 158.786865 L 264.080139 167.429489 L 249.344238 174.762634 L 244.523972 177.160034 C 243.485199 177.673859 242.404694 178.250412 241.321625 178.639008 C 238.810013 179.55072 235.535065 179.765411 232.956284 178.93988 C 230.682785 178.211975 228.015686 176.76442 225.834229 175.666473 L 217.808624 171.703491 L 184.229187 155.157593 C 182.130493 154.126114 180.120987 153.374619 179.601318 150.835007 C 179.357193 149.594284 179.632477 148.307678 180.362671 147.275345 C 181.279388 145.973022 183.236298 145.143478 184.765869 145.46521 C 186.261292 145.779785 188.339981 146.951614 189.725189 147.641083 L 195.311813 150.424103 L 227.259048 166.177185 L 232.224228 168.629761 C 233.219116 169.123001 234.62178 169.908508 235.661407 170.16333 C 236.396469 170.343704 237.675781 170.244385 238.36853 169.941666 C 240.006577 169.225464 241.706955 168.335342 243.315125 167.534393 L 252.050079 163.213791 L 279.654266 149.534256 C 281.326904 148.715729 287.194519 145.580826 288.537872 145.335724 L 288.635193 145.318848 Z"/><path fill="currentColor" d="M 288.576172 165.897629 C 293.808472 165.48587 295.77124 171.601578 291.525818 174.372742 C 290.652557 174.942719 289.314087 175.488983 288.335327 175.970764 L 282.488464 178.866974 L 263.286621 188.405731 L 248.137665 195.946838 L 244.179108 197.914764 C 243.276688 198.362671 242.279648 198.893646 241.338776 199.212219 C 238.650085 200.146652 235.742874 200.252411 232.993439 199.515503 C 231.170731 199.019562 227.380524 197.041046 225.495224 196.093185 L 217.138306 191.951385 L 184.341812 175.769531 C 182.247559 174.740326 180.189301 174.015137 179.608597 171.4991 C 179.343903 170.303253 179.568863 169.051392 180.233322 168.022476 C 181.158035 166.586945 182.997467 165.785858 184.679688 166.025833 C 186.319458 166.259659 191.112274 168.936188 192.91597 169.812881 L 223.025345 184.66983 L 231.498886 188.851379 C 232.721741 189.451782 234.295197 190.358917 235.568649 190.738251 C 237.679779 191.366974 240.242264 189.645309 242.122574 188.719177 L 250.808914 184.418015 L 279.461456 170.187073 L 284.802704 167.518097 C 285.981659 166.936829 287.321442 166.17662 288.576172 165.897629 Z"/></g></g></svg>`);
		this.addRibbonIcon("evc-relay", "Relay settings", () => {
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
						id: "send-bug-report",
						name: "Send bug report",
						callback: () => {
							const modal = new BugReportModal(this.app, this);
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
					this.removeCommand("send-bug-report");
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
			await appRef.plugins.disablePlugin("evc-team-relay");
			await appRef.plugins.enablePlugin("evc-team-relay");
		};

		this.addCommand({
			id: "reload",
			name: "Reload relay",
			callback: async () => await (this.app as unknown as ObsidianApp).reloadRelay?.(),
		});

		this.addCommand({
			id: "open-settings",
			name: "Open settings",
			callback: () => {
				void this.openSettings();
			},
		});

		this.addCommand({
			id: "configure-endpoints",
			name: "Configure enterprise tenant",
			callback: () => {
				this.openEndpointConfigurationModal();
			},
		});

		if (flags().enableSelfManageHosts) {
			this.addCommand({
				id: "register-host",
				name: "Register self-hosted relay server",
				callback: () => {
					const modal = new SelfHostModal(
						this.app,
						this.relayManager,
						(relay) => {
							// Open relay settings after successful creation
							void this.openSettings(`/relays?id=${relay.id}`);
						},
					);
					this.openModals.push(modal);
					modal.open();
				},
			});
		}


		this.vault = this.app.vault;
		const vaultName = this.vault.getName();
		this.fileManager = this.app.fileManager;

		this.hashStore = new ContentAddressedFileStore(this.appId);

		// Initialize and validate endpoints before creating LoginManager
		const endpointManager = new EndpointManager(this.endpointSettings);
		await this.validateEndpointsOnStartup(endpointManager);

		this.loginManager = new LoginManager(
			this.vault.getName(),
			this.openSettings.bind(this),
			this.timeProvider,
			this.patchWebviewer.bind(this),
			this.loginSettings,
			endpointManager,
			this.relayOnPremSettings.get(),
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

		this.networkStatus = new NetworkStatus(this.timeProvider, HEALTH_URL);

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
							// Folder is not shared yet - offer to share in relay-onprem mode
							if (this.loginManager.isRelayOnPremMode() && this.loginManager.isLoggedInToAnyServer()) {
								menu.addItem((item) => {
									item
										.setTitle("Relay: share folder")
										.setIcon("share-2")
										.onClick(() => {
											const modal = new QuickShareModal(this.app, this, file.path);
											modal.open();
										});
								});
							}
							return;
						}
						if (folder.relayId) {
							menu.addItem((item) => {
								item
									.setTitle("Relay: relay settings")
									.setIcon("gear")
									.onClick(() => {
										void this.openSettings(`/relays?id=${folder.relayId}`);
									});
							});
							menu.addItem((item) => {
								item
									.setTitle("Relay: share settings")
									.setIcon("settings")
									.onClick(() => {
										if (folder.settings?.onpremServerId && this.loginManager.isRelayOnPremMode()) {
											// eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for optional polyfill
											const { ShareManagementModal } = require("./ui/ShareManagementModal");
											new ShareManagementModal(this.app, this, folder.settings.onpremServerId).open();
										} else {
											void this.openSettings(`/shared-folders?id=${folder.guid}`);
										}
									});
							});
							menu.addItem((item) => {
								item
									.setTitle(
										folder.connected ? "Relay: disconnect" : "Relay: connect",
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
									.setTitle("Relay: share settings")
									.setIcon("settings")
									.onClick(() => {
										if (folder.settings?.onpremServerId && this.loginManager.isRelayOnPremMode()) {
											// eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for optional polyfill
											const { ShareManagementModal } = require("./ui/ShareManagementModal");
											new ShareManagementModal(this.app, this, folder.settings.onpremServerId).open();
										} else {
											void this.openSettings(`/shared-folders?id=${folder.guid}`);
										}
									});
							});
							// Add Unshare option for relay-onprem folders
							if (folder.settings?.onpremServerId && this.loginManager.isRelayOnPremMode()) {
								menu.addItem((item) => {
									item
										.setTitle("Relay: unshare folder")
										.setIcon("folder-x")
										.onClick(async () => {
											const confirmed = await confirmDialog(
												this.app,
												`Are you sure you want to unshare "${folder.path}"?\n\nThis will remove the share from the server and disconnect this folder.`
											);
											if (!confirmed) return;

											try {
												// Delete from server
												if (this.shareClientManager && folder.guid) {
													await this.shareClientManager.deleteShare(
														folder.settings.onpremServerId!,
														folder.guid
													);
												}
												// Remove local shared folder
												this.sharedFolders.delete(folder);
												this.folderNavDecorations?.quickRefresh();
												new Notice(`Folder "${folder.path}" unshared`);
											} catch (error: unknown) {
												new Notice(
													`Failed to unshare: ${error instanceof Error ? error.message : "Unknown error"}`
												);
											}
										});
								});
							}
						}
						if (folder.relayId && folder.connected) {
							menu.addItem((item) => {
								item
									.setTitle("Relay: sync")
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
									.setTitle("Relay: download")
									.setIcon("cloud-download")
									.onClick(async () => {
										await ifile.pull();
										new Notice(`Download complete: ${ifile.name}`);
									});
							});
							if (this.debugSettings.get().debugging) {
								menu.addItem((item) => {
									item
										.setTitle("Relay: verify upload")
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
									.setTitle("Relay: upload")
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
	): SharedFolder {
		// Initialize settings with pattern matching syntax
		const folderSettings = new NamespacedSettings<SharedFolderSettings>(
			this.settings as unknown as Settings<unknown>,
			`sharedFolders/[guid=${guid}]`,
		);
		const settings: SharedFolderSettings = { guid: guid, path: path };
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
				}
			} else {
				log("No share client available, skipping share load");
				return;
			}

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
		// Use the same registered evc-relay icon as ribbon
		const iconEl = statusBarItem.createSpan({ cls: "relay-status-icon" });
		setIcon(iconEl, "evc-relay");
		statusBarItem.setAttribute("aria-label", "Relay status");
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
						// eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for optional polyfill
						const { ShareManagementModal } = require("./ui/ShareManagementModal");
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
			let webSynced = 0;
			const webShares = shares.filter(s => s.web_published);
			for (const share of webShares) {
				try {
					if (share.kind === "doc") {
						const file = this.vault.getAbstractFileByPath(share.path);
						if (file instanceof TFile) {
							const content = await this.vault.read(file);
							await this.shareClientManager.updateShare(share.serverId, share.id, {
								web_content: content,
							});
							webSynced++;
						}
					} else if (share.kind === "folder") {
						const folderAbs = this.vault.getAbstractFileByPath(share.path);
						if (folderAbs instanceof TFolder) {
							// 1. Build recursive folder items and PATCH structure
							const items = this.getFolderItemsRecursive(folderAbs);
							await this.shareClientManager.updateShare(share.serverId, share.id, {
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
												await this.shareClientManager.syncFolderFileContent(
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

			const parts = [];
			if (relaySynced > 0) parts.push(`${relaySynced} relay`);
			if (webSynced > 0) parts.push(`${webSynced} web`);
			new Notice(parts.length > 0 ? `Synced: ${parts.join(", ")}` : "No shares to sync");
		} catch (error: unknown) {
			new Notice(`Sync failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
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

			// Check direct doc share match
			const docShare = shares.find(s => s.path === activeFile.path && s.web_published);
			if (docShare) {
				const content = await this.vault.read(activeFile);
				await this.shareClientManager.updateShare(docShare.serverId, docShare.id, {
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
				await this.shareClientManager.syncFolderFileContent(
					folderShare.serverId, folderShare.web_slug, relativePath, content
				);
				new Notice(`Synced ${activeFile.name} to web`);
				return;
			}

			new Notice("Current file is not in a web-published share");
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
		await setting.openTabById("evc-team-relay");
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
				capturedOpenUrlEvent = e as unknown as { type?: string; detail?: { url?: string } };
			};
			window.addEventListener("open-url", openUrlListener, true);

			Object.defineProperty(options, "openExternalURLs", {
				get() {
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
					return originalDesc.value;
				},
				set(value) {
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

		const vaultLog = curryLog("[System 3][Relay][Vault]", "log");

		const handlePromiseRejection = (event: PromiseRejectionEvent): void => {
			//event.preventDefault();
		};
		const rejectionListener = (event: PromiseRejectionEvent) =>
			handlePromiseRejection(event);
		window.addEventListener("unhandledrejection", rejectionListener, true);
		this.register(() =>
			window.removeEventListener("unhandledrejection", rejectionListener, true),
		);

		this.registerEvent(
			this.app.vault.on("create", (tfile) => {
				// NOTE: this is called on every file at startup...
				const folder = this.sharedFolders.lookup(tfile.path);
				if (folder) {
					const newDocs = folder.placeHold([tfile]);
					if (newDocs.length > 0) {
						folder.uploadFile(tfile);
					} else {
						void folder.whenReady().then((folder) => {
							folder.getFile(tfile);
						});
					}
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
					folder.markPendingDelete(vpath);
					void folder.whenReady().then((folder) => {
						folder.proxy.deleteFile(file.path);
					}).finally(() => {
						folder.clearPendingDelete(vpath);
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
				const folder = this.sharedFolders.lookup(tfile.path);
				if (folder) {
					vaultLog("Modify", tfile.path);
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
					// Trigger metadata resolve with the actual TFile (not our Document proxy)
					this.timeProvider.setTimeout(() => {
						this.app.metadataCache.trigger("resolve", tfile);
					}, 500);
				}

				// Handle auto-sync to web (v1.8.1)
				if (this.webSyncManager && tfile instanceof TFile) {
					void this.webSyncManager.onFileModified(tfile);
				}
			}),
		);

		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed to preserve `this` reference inside getPatcher callback functions where `this` is rebound
		const plugin = this;

		getPatcher().patch(MarkdownView.prototype, {
			// When this is called, the active editors haven't yet updated.
			onUnloadFile(old: unknown) {
				return function (file: unknown) {
					plugin._liveViews.wipe();
					// @ts-ignore
					return old.call(this, file);
				};
			},
		});

		getPatcher().patch(this.app.vault, {
			process(old: unknown) {
				return function (
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

					// @ts-ignore
					return old.call(this, tfile, fn, options);
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

		this.registerObsidianProtocolHandler("evc-team-relay/settings/relays", (e) => {
			const parameters = e as unknown as Parameters;
			const query = new URLSearchParams({ ...parameters }).toString();
			const path = `/${parameters.action.split("/").slice(-1).join("")}?${query}`;
			void this.openSettings(path);
		});

		this.registerObsidianProtocolHandler(
			"evc-team-relay/settings/shared-folders",
			(e) => {
				const parameters = e as unknown as Parameters;
				const query = new URLSearchParams({ ...parameters }).toString();
				const path = `/${parameters.action.split("/").slice(-1).join("")}?${query}`;
				void this.openSettings(path);
			},
		);

		this.registerObsidianProtocolHandler("evc-team-relay/billing-ok", (e) => {
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
			const qualifiedCommand = `evc-team-relay:${command}`;
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
