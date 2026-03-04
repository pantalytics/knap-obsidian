/**
 * Relay On-Premise Login Modal
 *
 * Modal dialog for email/password authentication with relay-onprem control plane
 * Supports multi-server mode with optional serverId parameter
 */

import { App, Modal, Notice } from "obsidian";
import type { LoginManager } from "../LoginManager";
import type { RelayOnPremShareClient, OAuthProvider } from "../RelayOnPremShareClient";

export class RelayOnPremLoginModal extends Modal {
	private emailInput!: HTMLInputElement;
	private passwordInput!: HTMLInputElement;
	private loginButton!: HTMLButtonElement;
	private errorDiv!: HTMLDivElement;
	private isLoggingIn: boolean = false;
	private oauthProviders: OAuthProvider[] = [];

	constructor(
		app: App,
		private loginManager: LoginManager,
		private onSuccess: () => void,
		private serverId?: string,
		private shareClient?: RelayOnPremShareClient,
	) {
		super(app);
		this.setTitle("Relay on-premise login");
	}

	onOpen() {
		void this._init();
	}

	private async _init() {
		const { contentEl } = this;
		contentEl.empty();

		// Fetch OAuth providers if available
		if (this.shareClient) {
			try {
				this.oauthProviders = await this.shareClient.getOAuthProviders();
			} catch (error: unknown) {
				// OAuth providers not available, continue with password-only login
				console.debug("OAuth providers not available:", error);
			}
		}

		// Create form
		const form = contentEl.createEl("form", { cls: "relay-onprem-login-form" });

		// Email field
		const emailGroup = form.createDiv({ cls: "setting-item" });
		emailGroup.createDiv({ cls: "setting-item-info" })
			.createEl("div", { text: "Email", cls: "setting-item-name" });
		const emailControl = emailGroup.createDiv({ cls: "setting-item-control" });
		this.emailInput = emailControl.createEl("input", {
			type: "email",
			placeholder: "user@example.com",
			cls: "relay-onprem-input",
		});
		this.emailInput.addClass("evc-w-full");

		// Password field
		const passwordGroup = form.createDiv({ cls: "setting-item" });
		passwordGroup.createDiv({ cls: "setting-item-info" })
			.createEl("div", { text: "Password", cls: "setting-item-name" });
		const passwordControl = passwordGroup.createDiv({ cls: "setting-item-control" });
		this.passwordInput = passwordControl.createEl("input", {
			type: "password",
			placeholder: "Enter your password",
			cls: "relay-onprem-input",
		});
		this.passwordInput.addClass("evc-w-full");

		// Error display
		this.errorDiv = form.createDiv({ cls: "relay-onprem-error" });
		this.errorDiv.addClass("evc-text-error");
		this.errorDiv.addClass("evc-mt-2");
		this.errorDiv.addClass("evc-hidden");

		// Buttons
		const buttonGroup = form.createDiv({ cls: "modal-button-container" });
		buttonGroup.addClass("evc-flex", "evc-justify-end", "evc-mt-4", "evc-gap-2");

		// Cancel button
		const cancelButton = buttonGroup.createEl("button", {
			text: "Cancel",
			cls: "mod-cancel",
		});
		cancelButton.addEventListener("click", (e) => {
			e.preventDefault();
			this.close();
		});

		// Login button
		this.loginButton = buttonGroup.createEl("button", {
			text: "Login",
			cls: "mod-cta",
		});
		this.loginButton.addEventListener("click", (e) => {
			e.preventDefault();
			void this.handleLogin();
		});

		// Handle Enter key in inputs
		const handleEnter = (e: KeyboardEvent) => {
			if (e.key === "Enter" && !this.isLoggingIn) {
				e.preventDefault();
				void this.handleLogin();
			}
		};
		this.emailInput.addEventListener("keydown", handleEnter);
		this.passwordInput.addEventListener("keydown", handleEnter);

		// Add OAuth buttons if providers are available
		if (this.oauthProviders.length > 0) {
			const oauthSection = form.createDiv({ cls: "relay-onprem-oauth-section evc-oauth-section" });

			oauthSection.createDiv({
				text: "Or sign in with:",
				cls: "setting-item-name evc-oauth-label",
			});

			const oauthButtons = oauthSection.createDiv({ cls: "relay-onprem-oauth-buttons" });
			oauthButtons.addClass("evc-flex");
			oauthButtons.addClass("evc-flex-col");
			oauthButtons.addClass("evc-gap-2");

			for (const provider of this.oauthProviders) {
				const oauthButton = oauthButtons.createEl("button", {
					text: provider.display_name,
					cls: "mod-cta",
				});
				oauthButton.addClass("evc-w-full");
				oauthButton.addEventListener("click", (e) => {
					e.preventDefault();
					void this.handleOAuthLogin(provider.name);
				});
			}
		}

		// Focus email input
		setTimeout(() => this.emailInput.focus(), 100);
	}

	private async handleLogin() {
		const email = this.emailInput.value.trim();
		const password = this.passwordInput.value;

		// Validation
		if (!email) {
			this.showError("Please enter your email");
			return;
		}

		if (!password) {
			this.showError("Please enter your password");
			return;
		}

		// Basic email validation
		if (!email.includes("@")) {
			this.showError("Please enter a valid email address");
			return;
		}

		// Password length validation (control plane requires min 8 characters)
		if (password.length < 8) {
			this.showError("Password must be at least 8 characters");
			return;
		}

		// Attempt login
		this.setLoading(true);
		this.hideError();

		try {
			// Use serverId-specific login if provided, otherwise fall back to legacy method
			if (this.serverId) {
				await this.loginManager.loginToServer(this.serverId, email, password);
			} else {
				await this.loginManager.loginWithEmailAndPassword(email, password);
			}
			new Notice("Successfully logged in to relay-onprem!");
			this.close();
			this.onSuccess();
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Login failed";
			// Clean up error message for better UX
			let displayMessage = errorMessage;
			if (errorMessage.includes("401") || errorMessage.includes("Incorrect email or password")) {
				displayMessage = "Incorrect email or password";
			} else if (errorMessage.includes("400") || errorMessage.includes("Invalid data format")) {
				displayMessage = "Invalid login data. Please check your email and password.";
			} else if (errorMessage.includes("Network request failed") || errorMessage.includes("Failed to fetch")) {
				displayMessage = "Network error. Please check your connection and control plane URL.";
			}
			this.showError(displayMessage);
			this.setLoading(false);
		}
	}

	private setLoading(loading: boolean) {
		this.isLoggingIn = loading;
		this.loginButton.disabled = loading;
		this.emailInput.disabled = loading;
		this.passwordInput.disabled = loading;
		this.loginButton.setText(loading ? "Logging in..." : "Login");
	}

	private showError(message: string) {
		this.errorDiv.setText(message);
		this.errorDiv.removeClass("evc-hidden");
	}

	private hideError() {
		this.errorDiv.addClass("evc-hidden");
	}

	private async handleOAuthLogin(provider: string) {
		this.setLoading(true);
		this.hideError();

		try {
			// Get auth provider for the server
			let authProvider;
			if (this.serverId) {
				authProvider = this.loginManager.getAuthProviderForServer(this.serverId);
			} else {
				authProvider = this.loginManager.getAuthProvider();
			}

			if (!authProvider) {
				throw new Error("Auth provider not available");
			}

			// Start OAuth login
			await authProvider.loginWithOAuth2(provider);

			new Notice(`Successfully logged in with ${provider}!`);
			this.close();
			this.onSuccess();
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "OAuth login failed";
			let displayMessage = errorMessage;

			if (errorMessage.includes("timeout")) {
				displayMessage = "Login timeout. Please try again.";
			} else if (errorMessage.includes("Network request failed") || errorMessage.includes("Failed to fetch")) {
				displayMessage = "Network error. Please check your connection and control plane URL.";
			} else if (errorMessage.includes("Cannot open browser")) {
				displayMessage = "Unable to open browser. Please try manual login.";
			}

			this.showError(displayMessage);
			this.setLoading(false);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
