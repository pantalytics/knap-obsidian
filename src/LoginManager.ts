"use strict";

import { requestUrl, type RequestUrlResponsePromise } from "obsidian";
import { User } from "./User";
import PocketBase, {
	BaseAuthStore,
	type AuthProviderInfo,
	type RecordAuthResponse,
	type RecordModel,
} from "pocketbase";
import { RelayInstances, curryLog } from "./debug";
import type { IAuthProvider } from "./auth/IAuthProvider";
import { isRelayOnPremMode } from "./auth/AuthProviderFactory";
import { loginWithEmailPassword, logoutUser, getCurrentUserFromProvider } from "./LoginManagerExtensions";
import type { RelayOnPremSettings, RelayOnPremServer } from "./RelayOnPremConfig";
import { getServerById } from "./RelayOnPremConfig";
import { Observable } from "./observable/Observable";
import { MultiServerAuthManager, type ServerAuthStatus } from "./auth/MultiServerAuthManager";

declare const GIT_TAG: string;

import { customFetch } from "./customFetch";
import { LocalAuthStore } from "./pocketbase/LocalAuthStore";
import type { TimeProvider } from "./TimeProvider";
import { FeatureFlagManager } from "./flagManager";
import type { NamespacedSettings } from "./SettingsStorage";
import type { EndpointManager } from "./EndpointManager";

interface GoogleUser {
	email: string;
	family_name: string;
	given_name: string;
	name: string;
	picture: string;
}

interface GitHubUser {
	email: string;
	name: string;
	login: string;
	avatar_url: string;
}

interface MicrosoftUser {
	mail: string;
	surname: string;
	givenName: string;
	displayName: string;
}

interface OIDCUser {
	email: string;
	given_name: string;
	family_name: string;
	name?: string;
	picture?: string;
}

/**
 * Normalized OAuth user data structure that standardizes information across providers
 */
interface NormalizedOAuthUser {
	name: string;
	given_name: string;
	family_name: string;
	email: string;
	picture?: string;
}

/**
 * Normalizes OAuth2 user data from different providers into a consistent format
 */
function normalizeOAuthUser(rawUser: unknown): NormalizedOAuthUser | null {
	if (typeof rawUser !== "object" || rawUser === null) {
		return null;
	}
	const userObj = rawUser as Record<string, unknown>;

	// Handle Google user
	if ("email" in userObj && "name" in userObj && "given_name" in userObj && "family_name" in userObj) {
		const googleUser = userObj as unknown as GoogleUser;
		return {
			name: googleUser.name,
			given_name: googleUser.given_name,
			family_name: googleUser.family_name,
			email: googleUser.email,
			picture: googleUser.picture,
		};
	}

	// Handle GitHub user
	if ("email" in userObj && "login" in userObj && "avatar_url" in userObj) {
		const githubUser = userObj as unknown as GitHubUser;
		const nameParts = (githubUser.name || githubUser.login).split(' ');
		return {
			name: githubUser.name || githubUser.login,
			given_name: nameParts[0] || githubUser.login,
			family_name: nameParts.slice(1).join(' ') || '',
			email: githubUser.email,
			picture: githubUser.avatar_url,
		};
	}

	// Handle Microsoft user
	if ("mail" in userObj && "displayName" in userObj) {
		const microsoftUser = userObj as unknown as MicrosoftUser;
		return {
			name: microsoftUser.displayName,
			given_name: microsoftUser.givenName,
			family_name: microsoftUser.surname,
			email: microsoftUser.mail,
			// Microsoft doesn't typically provide picture in basic profile
		};
	}

	// Handle OIDC user (standard OpenID Connect claims)
	if ("email" in userObj && "given_name" in userObj && "family_name" in userObj) {
		const oidcUser = userObj as unknown as OIDCUser;
		return {
			name: oidcUser.name || `${oidcUser.given_name} ${oidcUser.family_name}`,
			given_name: oidcUser.given_name,
			family_name: oidcUser.family_name,
			email: oidcUser.email,
			picture: oidcUser.picture,
		};
	}

	return null;
}

/**
 * Creates a User object from OAuth2 payload data, supporting multiple providers
 * @param id - User ID from the auth store
 * @param token - Authentication token
 * @param authStoreModel - Model data from the auth store
 * @param rawUser - Raw OAuth user data from the provider (Google, GitHub, Microsoft, OIDC, etc.)
 * @returns A new User instance with normalized data from the OAuth provider
 */
export function createUserFromOAuth(
	id: string,
	token: string,
	authStoreModel: unknown,
	rawUser?: unknown,
): User {
	const normalizedOAuth = rawUser ? normalizeOAuthUser(rawUser) : null;

	const model = authStoreModel as { name?: string; email?: string; picture?: string } | null | undefined;
	return new User(
		id,
		model?.name || normalizedOAuth?.name || "",
		model?.email || normalizedOAuth?.email || "",
		model?.picture || normalizedOAuth?.picture || "",
		token,
	);
}

export class Provider {
	fullAuthUrl: string;
	info: AuthProviderInfo;
	login: (code: string) => Promise<RecordAuthResponse<RecordModel>>;

	constructor(
		authUrl: string,
		info: AuthProviderInfo,
		loginFn: (code: string) => Promise<RecordAuthResponse<RecordModel>>,
	) {
		this.fullAuthUrl = authUrl;
		this.info = info;
		this.login = loginFn;
	}
}

export interface LoginSettings {
	provider: string | undefined;
}

export class LoginManager extends Observable<LoginManager> {
	// pb is optional - not used in relay-onprem mode
	pb?: PocketBase;
	private openSettings: () => Promise<void>;
	// XXX keep this private
	authStore: LocalAuthStore;
	user?: User;
	resolve?: (code: string) => Promise<RecordAuthResponse<RecordModel>>;
	private endpointManager: EndpointManager;

	// Relay-onprem support (legacy single-server)
	private authProvider?: IAuthProvider;
	private relayOnPremSettings?: RelayOnPremSettings;
	private isRelayOnPrem: boolean = false;

	// Multi-server auth manager
	private multiServerAuthManager?: MultiServerAuthManager;
	private activeServerId?: string;
	private _restorePromise?: Promise<void>;

	constructor(
		private vaultName: string,
		openSettings: () => Promise<void>,
		timeProvider: TimeProvider,
		private beforeLogin: () => void,
		public loginSettings: NamespacedSettings<LoginSettings>,
		endpointManager: EndpointManager,
		relayOnPremSettings?: RelayOnPremSettings,
	) {
		super();
		const pbLog = curryLog("[Pocketbase]", "debug");
		// Use plugin-specific localStorage key to avoid conflicts with other plugins
		this.authStore = new LocalAuthStore(`evc-team-relay_pocketbase_auth_${vaultName}`);
		this.endpointManager = endpointManager;

		// Initialize relay-onprem if enabled
		if (relayOnPremSettings) {
			this.relayOnPremSettings = relayOnPremSettings;
			this.isRelayOnPrem = isRelayOnPremMode(relayOnPremSettings);

			if (this.isRelayOnPrem) {
				this.log("Initializing in relay-onprem mode with multi-server support");

				// Initialize multi-server auth manager
				this.multiServerAuthManager = new MultiServerAuthManager(
					vaultName,
					relayOnPremSettings.servers
				);

				// Set active server to default
				this.activeServerId = relayOnPremSettings.defaultServerId;
				if (!this.activeServerId && relayOnPremSettings.servers.length > 0) {
					this.activeServerId = relayOnPremSettings.servers[0].id;
				}

				// Get auth provider for the active server (for backward compatibility)
				if (this.activeServerId) {
					this.authProvider = this.multiServerAuthManager.getProvider(this.activeServerId);
				}

				// In relay-onprem mode, we don't need PocketBase or System 3 connectivity
				// Return early to avoid initializing PocketBase
				this.openSettings = openSettings;

				// Start async auth restore — await via waitForRestore() before using auth state
				this._restorePromise = this.multiServerAuthManager.waitForAllRestore().then(() => {
					// After restore completes, update user from active server
					if (this.authProvider) {
						const currentUser = getCurrentUserFromProvider(this.authProvider);
						if (currentUser) {
							this.user = currentUser;
							this.log("Restored relay-onprem user:", currentUser.email);
							this.notifyListeners();
						}
					}
				});

				return;
			}
		}

		// Only initialize PocketBase if NOT in relay-onprem mode
		this.pb = new PocketBase(this.endpointManager.getAuthUrl(), this.authStore);
		this.pb.beforeSend = (url, options) => {
			pbLog(url, options);
			if (this.pb && !this.pb.authStore.isValid && this.user) {
				this.logout();
			}
			options.fetch = customFetch;
			options.headers = Object.assign({}, options.headers, {
				"Relay-Version": GIT_TAG,
			});
			return { url, options };
		};
		this.refreshToken();
		timeProvider.setInterval(() => this.refreshToken(), 86400000);
		this.openSettings = openSettings;
		if (this.pb && !this.pb.authStore.isValid) {
			this.logout();
		}
		if (this.pb && this.pb.authStore.model?.id) {
			this.pb
				.collection("users")
				.getOne(this.pb.authStore.model.id)
				.then(() => {
					this.getFlags();
				})
				.catch((response: unknown) => {
					if (response && typeof response === "object" && "status" in response && (response as { status: number }).status === 404) {
						this.logout();
					}
				});
		}
		RelayInstances.set(this, "loginManager");
	}

	/**
	 * Wait for auth restoration to complete.
	 * Must be called before using auth state after plugin load.
	 */
	async waitForRestore(): Promise<void> {
		if (this._restorePromise) {
			await this._restorePromise;
		}
	}

	refreshToken() {
		// Relay-onprem mode handles token refresh differently
		if (this.isRelayOnPrem || !this.pb) {
			return;
		}


		if (this.pb && this.pb.authStore.isValid) {
			this.user = this.makeUser(this.pb.authStore);
			void this.pb
				.collection("users")
				.authRefresh()
				.then((authData) => {
					const token = authData.token;
					const [, payload] = token.split(".");
					const decodedPayload = JSON.parse(atob(payload));

					const expiryDate = new Date(decodedPayload.exp * 1000);
					const now = new Date();
					const daysUntilExpiry = Math.ceil(
						(expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
					);

					this.log("Token Refreshed");
					this.log("JWT Info:", {
						expiresAt: expiryDate.toLocaleString(),
						expiresIn: `${daysUntilExpiry} days`,
						userId: decodedPayload.id,
						email: decodedPayload.email,
					});
				});
		}
	}

	setup(
		authData?: RecordAuthResponse<RecordModel>,
		provider?: string,
	): boolean {
		// Relay-onprem mode doesn't use this method
		if (this.isRelayOnPrem || !this.pb) {
			this.notifyListeners();
			return false;
		}

		if (!this.pb || !this.pb.authStore.isValid) {
			this.notifyListeners(); // notify anyway
			return false;
		}
		this.user = this.makeUser(this.pb.authStore, authData?.meta?.rawUser);
		this.notifyListeners();
		if (authData) {
			this.pb
				.collection("oauth2_response")
				.create({
					user: authData.record.id,
					oauth_response: authData.meta?.rawUser,
				})
				.then(() => {
					this.notifyListeners();
				})
				.catch((reason: unknown) => {
					this.log(reason);
				});
		}
		if (provider) {
			void this.loginSettings.set({ provider });
		}
		return true;
	}

	clearPreferredProvider() {
		void this.loginSettings.set({ provider: undefined });
	}

	async checkRelayHost(relay_guid: string): Promise<RequestUrlResponsePromise> {
		if (!this.pb) {
			throw new Error("PocketBase not initialized");
		}
		const headers = {
			Authorization: `Bearer ${this.pb.authStore.token}`,
			"Relay-Version": GIT_TAG,
		};
		return requestUrl({
			url: `${this.endpointManager.getApiUrl()}/relay/${relay_guid}/check-host`,
			method: "GET",
			headers: headers,
		});
	}

	getFlags() {
		if (!this.pb) return;
		const headers = {
			Authorization: `Bearer ${this.pb.authStore.token}`,
			"Relay-Version": GIT_TAG,
		};
		requestUrl({
			url: `${this.endpointManager.getApiUrl()}/flags`,
			method: "GET",
			headers: headers,
		})
			.then((response) => {
				if (response.status === 200) {
					const serverFlags = response.json;
					void FeatureFlagManager.getInstance().applyServerFlags(serverFlags);
				}
			})
			.catch((reason: unknown) => {
				this.log(reason);
			});
	}

	whoami() {
		if (!this.pb) return;
		const headers = {
			Authorization: `Bearer ${this.pb.authStore.token}`,
		};
		requestUrl({
			url: `${this.endpointManager.getApiUrl()}/whoami`,
			method: "GET",
			headers: headers,
		})
			.then((response) => {
				this.log(response.json);
			})
			.catch((reason: unknown) => {
				this.log(reason);
			});
	}

	public get loggedIn() {
		return this.user !== undefined;
	}

	/**
	 * Get the endpoint manager for endpoint configuration
	 */
	getEndpointManager(): EndpointManager {
		return this.endpointManager;
	}

	/**
	 * Validate and apply custom endpoints
	 */
	async validateAndApplyEndpoints(timeoutMs?: number): Promise<{
		success: boolean;
		error?: string;
		licenseInfo?: unknown;
	}> {
		const result = await this.endpointManager.validateAndSetEndpoints(timeoutMs);

		if (result.success && this.endpointManager.hasValidatedEndpoints()) {
			// Recreate PocketBase instance with new auth URL
			const pbLog = curryLog("[Pocketbase]", "debug");
			this.pb = new PocketBase(this.endpointManager.getAuthUrl(), this.authStore);
			this.pb.beforeSend = (url, options) => {
				pbLog(url, options);
				if (this.pb && !this.pb.authStore.isValid && this.user) {
					this.logout();
				}
				options.fetch = customFetch;
				options.headers = Object.assign({}, options.headers, {
					"Relay-Version": GIT_TAG,
				});
				return { url, options };
			};
			this.log("Updated PocketBase instance with validated endpoints");
		}

		return result;
	}

	get hasUser() {
		return this.user !== undefined;
	}

	private makeUser(
		authStore: BaseAuthStore,
		rawUser?: GoogleUser | GitHubUser | MicrosoftUser | OIDCUser,
	): User {
		return createUserFromOAuth(
			authStore.model?.id,
			authStore.token,
			authStore.model,
			rawUser,
		);
	}

	logout() {
		// Handle logout for relay-onprem mode
		if (this.isRelayOnPrem && this.authProvider) {
			logoutUser(this.authProvider).catch((error: unknown) => {
				this.error("Logout error:", error);
			});
			this.user = undefined;
			this.notifyListeners();
			return;
		}

		// Handle logout for System 3 mode
		if (this.pb) {
			this.pb.cancelAllRequests();
			this.pb.authStore.clear();
		}
		this.user = undefined;
		this.notifyListeners();
	}

	getWebviewIntercepts(providers?: Record<string, Provider>): RegExp[] {
		// Relay-onprem mode doesn't use webview intercepts
		if (this.isRelayOnPrem || !this.pb) {
			return [];
		}

		const redirectUrl = this.pb.buildUrl("/api/oauth2-redirect");
		const createIntercept = (authProviderUrl: string): RegExp => {
			// Escape forward slashes in the auth URL
			const escapedAuthProvider = authProviderUrl.replace(/\//g, "\\/");
			return new RegExp(
				`^${escapedAuthProvider}.*?[?&]redirect_uri=(${redirectUrl}|${encodeURIComponent(redirectUrl)})`,
				"i",
			);
		};

		const createInterceptFromAuthUrl = (authUrl: string): RegExp => {
			// Extract the base authorization URL (everything before the query parameters)
			const url = new URL(authUrl);
			const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;

			// Escape special regex characters
			const escapedBaseUrl = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

			return new RegExp(
				`^${escapedBaseUrl}.*?[?&]redirect_uri=(${redirectUrl}|${encodeURIComponent(redirectUrl)})`,
				"i",
			);
		};

		const intercepts = [
			// Google
			createIntercept("https://accounts.google.com/o/oauth2/auth"),
			// GitHub
			createIntercept("https://github.com/login/oauth/authorize"),
			// Discord
			createIntercept("https://discord.com/api/oauth2/authorize"),
			// Microsoft
			createIntercept(
				"https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
			),
		];

		// Add dynamic OIDC intercepts if provider info is available
		if (providers) {
			const oidcProvider = providers["oidc"];
			if (oidcProvider?.info?.authUrl) {
				console.debug("[OIDC Provider] Creating dynamic intercept for authUrl:", oidcProvider.info.authUrl);
				intercepts.push(createInterceptFromAuthUrl(oidcProvider.info.authUrl));
			}
		} else {
			// Fallback generic OIDC pattern when no provider info is available
			intercepts.push(new RegExp(
				`.*?/auth.*?[?&]redirect_uri=(${redirectUrl}|${encodeURIComponent(redirectUrl)})`,
				"i",
			));
		}

		return intercepts;
	}

	updateWebviewIntercepts(providers: Record<string, Provider>) {
		// This method can be called to update webview intercepts with provider info
		// Implementation depends on how the main plugin handles intercept updates
		const newIntercepts = this.getWebviewIntercepts(providers);
		console.debug("[OIDC Provider] Updated webview intercepts:", newIntercepts.map(r => r.source));
		return newIntercepts;
	}

	async initiateManualOAuth2CodeFlow(
		whichFetch: typeof fetch | typeof customFetch,
		providerNames: string[],
	): Promise<Record<string, Provider>> {
		this.beforeLogin();
		const authMethods = await this.pb!
			.collection("users")
			.listAuthMethods({ fetch: whichFetch })
			.catch((e: unknown) => {
				throw e instanceof Error ? e : (e && typeof e === "object" && "originalError" in e) ? (e as { originalError: unknown }).originalError : e;
			});

		const redirectUrl = this.pb!.buildUrl("/api/oauth2-redirect");
		const providers: Record<string, Provider> = {};

		for (const providerName of providerNames) {
			const provider = authMethods.authProviders.find((provider_) => {
				return provider_.name === providerName;
			});

			if (!provider) {
				this.log(`Warning: unable to find provider: ${providerName}`);
				continue;
			}

			const loginFunction = async (code: string) => {
				return this.pb!
					.collection("users")
					.authWithOAuth2Code(
						provider.name,
						code,
						provider.codeVerifier,
						redirectUrl,
						{
							fetch: whichFetch,
						},
					)
					.then((authData) => {
						this.setup(authData, provider.name);
						return authData;
					});
			};

			providers[providerName] = new Provider(
				provider.authUrl + redirectUrl,
				provider,
				loginFunction,
			);
		}

		if (Object.keys(providers).length === 0) {
			throw new Error(
				`No valid providers found from requested list: ${providerNames.join(", ")}`,
			);
		}

		return providers;
	}

	async poll(provider: Provider): Promise<RecordAuthResponse<RecordModel>> {
		let counter = 0;
		const interval = 1000;
		return new Promise((resolve, reject) => {
			const timer = setInterval(() => {
				counter += 1;
				if (counter >= 30) {
					clearInterval(timer);
					return reject(
						new Error(
							`Auth timeout: Timed out after ${
								(counter * interval) / 1000
							} seconds`,
						),
					);
				}
				this.pb!
					.collection("code_exchange")
					.getOne(provider.info.state.slice(0, 15))
					.then((response) => {
						if (response) {
							clearInterval(timer);
							return resolve(provider.login(response.code));
						}
					})
					.catch((e: unknown) => {});
			}, interval);
		});
	}

	async login(provider: string): Promise<boolean> {
		this.beforeLogin();
		const authData = await this.pb!.collection("users").authWithOAuth2({
			provider: provider,
		});
		return this.setup(authData, provider);
	}

	async openLoginPage() {
		await this.openSettings();
		const promise = new Promise<boolean>((resolve, reject) => {
			const isLoggedIn = () => {
				if (this.loggedIn) {
					this.off(isLoggedIn);
					resolve(true);
				}
				resolve(false);
			};
			this.on(isLoggedIn);
		});
		return await promise;
	}

	/**
	 * Login with email and password (relay-onprem mode only)
	 * This is the legacy single-server login method
	 */
	async loginWithEmailAndPassword(email: string, password: string): Promise<boolean> {
		if (!this.isRelayOnPrem || !this.authProvider) {
			throw new Error("Email/password login is only available in relay-onprem mode");
		}

		this.beforeLogin();
		this.log(`Attempting relay-onprem login for ${email}`);

		try {
			const user = await loginWithEmailPassword(this.authProvider, email, password);
			this.user = user;
			this.notifyListeners();
			this.log("Relay-onprem login successful");
			return true;
		} catch (error: unknown) {
			this.log("Relay-onprem login failed:", error);
			this.user = undefined;
			this.notifyListeners();
			throw error;
		}
	}

	/**
	 * Check if relay-onprem mode is enabled
	 */
	isRelayOnPremMode(): boolean {
		return this.isRelayOnPrem;
	}

	/**
	 * Get the auth provider (for advanced usage)
	 * Returns the auth provider for the active server
	 */
	getAuthProvider(): IAuthProvider | undefined {
		return this.authProvider;
	}

	// ---------------------------------------------------------------
	// Multi-server methods
	// ---------------------------------------------------------------

	/**
	 * Get the multi-server auth manager
	 */
	getMultiServerAuthManager(): MultiServerAuthManager | undefined {
		return this.multiServerAuthManager;
	}

	/**
	 * Get auth provider for a specific server
	 */
	getAuthProviderForServer(serverId: string): IAuthProvider | undefined {
		return this.multiServerAuthManager?.getProvider(serverId);
	}

	/**
	 * Login to a specific server
	 */
	async loginToServer(serverId: string, email: string, password: string): Promise<boolean> {
		if (!this.isRelayOnPrem || !this.multiServerAuthManager) {
			throw new Error("Multi-server login is only available in relay-onprem mode");
		}

		this.beforeLogin();
		this.log(`Attempting login to server ${serverId} as ${email}`);

		try {
			await this.multiServerAuthManager.loginToServer(serverId, email, password);

			// Update server's lastUserEmail in settings
			if (this.relayOnPremSettings) {
				const server = getServerById(this.relayOnPremSettings, serverId);
				if (server) {
					server.lastUserEmail = email;
				}
			}

			// If this is the active server, update the current user
			if (serverId === this.activeServerId) {
				this.authProvider = this.multiServerAuthManager.getProvider(serverId);
				if (this.authProvider) {
					const currentUser = getCurrentUserFromProvider(this.authProvider);
					if (currentUser) {
						this.user = currentUser;
					}
				}
			}

			this.notifyListeners();
			this.log(`Login to server ${serverId} successful`);
			return true;
		} catch (error: unknown) {
			this.log(`Login to server ${serverId} failed:`, error);
			this.notifyListeners();
			throw error;
		}
	}

	/**
	 * Logout from a specific server
	 */
	async logoutFromServer(serverId: string): Promise<void> {
		if (!this.isRelayOnPrem || !this.multiServerAuthManager) {
			throw new Error("Multi-server logout is only available in relay-onprem mode");
		}

		this.log(`Logging out from server ${serverId}`);

		try {
			await this.multiServerAuthManager.logoutFromServer(serverId);

			// If this is the active server, clear the current user
			if (serverId === this.activeServerId) {
				this.user = undefined;
			}

			this.notifyListeners();
		} catch (error: unknown) {
			this.log(`Logout from server ${serverId} failed:`, error);
			throw error;
		}
	}

	/**
	 * Set the active server for single-user operations
	 */
	setActiveServer(serverId: string): void {
		if (!this.isRelayOnPrem || !this.multiServerAuthManager) {
			throw new Error("Multi-server mode is only available in relay-onprem mode");
		}

		this.log(`Setting active server to ${serverId}`);
		this.activeServerId = serverId;
		this.authProvider = this.multiServerAuthManager.getProvider(serverId);

		// Update current user from the new active server
		if (this.authProvider) {
			const currentUser = getCurrentUserFromProvider(this.authProvider);
			this.user = currentUser || undefined;
		} else {
			this.user = undefined;
		}

		this.notifyListeners();
	}

	/**
	 * Get the active server ID
	 */
	getActiveServerId(): string | undefined {
		return this.activeServerId;
	}

	/**
	 * Get list of logged-in server IDs
	 */
	getLoggedInServers(): string[] {
		return this.multiServerAuthManager?.getLoggedInServerIds() || [];
	}

	/**
	 * Get auth status for all configured servers
	 */
	getAuthStatusForAllServers(): ServerAuthStatus[] {
		if (!this.multiServerAuthManager || !this.relayOnPremSettings) {
			return [];
		}
		return this.multiServerAuthManager.getAuthStatus(this.relayOnPremSettings.servers);
	}

	/**
	 * Check if logged in to any server
	 */
	isLoggedInToAnyServer(): boolean {
		return this.multiServerAuthManager?.isLoggedInToAny() || false;
	}

	/**
	 * Check if logged in to a specific server
	 */
	isLoggedInToServer(serverId: string): boolean {
		return this.multiServerAuthManager?.isLoggedInToServer(serverId) || false;
	}

	/**
	 * Add a new server to the auth manager
	 */
	addServer(server: RelayOnPremServer): void {
		if (!this.multiServerAuthManager) {
			return;
		}
		this.multiServerAuthManager.addServer(server);
		this.notifyListeners();
	}

	/**
	 * Remove a server from the auth manager
	 */
	removeServer(serverId: string): void {
		if (!this.multiServerAuthManager) {
			return;
		}

		// If removing the active server, clear user and switch to another
		if (serverId === this.activeServerId) {
			this.user = undefined;
			this.authProvider = undefined;
			this.activeServerId = undefined;

			// Try to switch to another logged-in server
			const loggedInServers = this.getLoggedInServers().filter((id) => id !== serverId);
			if (loggedInServers.length > 0) {
				this.setActiveServer(loggedInServers[0]);
			}
		}

		this.multiServerAuthManager.removeServer(serverId);
		this.notifyListeners();
	}

	/**
	 * Update server configuration
	 */
	updateServer(server: RelayOnPremServer): void {
		if (!this.multiServerAuthManager) {
			return;
		}
		this.multiServerAuthManager.updateServer(server);
		this.notifyListeners();
	}

	/**
	 * Logout from all servers
	 */
	async logoutFromAllServers(): Promise<void> {
		if (!this.multiServerAuthManager) {
			return;
		}

		this.log("Logging out from all servers");
		await this.multiServerAuthManager.logoutAll();
		this.user = undefined;
		this.notifyListeners();
	}

	destroy() {
		this.pb?.cancelAllRequests();
		void this.pb?.realtime.unsubscribe();
		this.pb = null as unknown as PocketBase | undefined;
		this.authStore.destroy();
		this.authStore = null as unknown as LocalAuthStore;
		this.user = undefined;
		this.openSettings = null as unknown as () => Promise<void>;
		this.multiServerAuthManager = undefined;
		super.destroy();
	}
}
