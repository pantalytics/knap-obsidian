/**
 * Relay On-Premise Share Management Client
 *
 * Handles share CRUD operations and member management via control plane API.
 */

import { curryLog } from "./debug";
import { customFetch } from "./customFetch";

const log = curryLog("[RelayOnPremShareClient]");

/**
 * Share data from control plane API
 */
export interface RelayOnPremShare {
	id: string;
	kind: "doc" | "folder";
	path: string;
	visibility: "private" | "public" | "protected";
	password_hash?: string | null;
	owner_user_id: string;
	created_at: string;
	updated_at: string;
	// Web publishing fields (v1.7)
	web_published?: boolean;
	web_slug?: string | null;
	web_noindex?: boolean;
	web_sync_mode?: "manual" | "auto"; // v1.8.1 - Sync mode for web publishing
	web_url?: string | null;
	web_doc_id?: string | null; // Y-sweet document ID for real-time sync
}

/**
 * Share member data
 */
export interface ShareMember {
	id: string;
	share_id: string;
	user_id: string;
	user_email: string; // Email for better UX display
	role: "viewer" | "editor";
	created_at?: string;
	updated_at?: string;
}

/**
 * User data from control plane
 */
export interface User {
	id: string;
	email: string;
	name?: string;
	is_admin: boolean;
	is_active: boolean;
	created_at: string;
}

/**
 * Request to create a new share
 */
export interface CreateShareRequest {
	kind: "doc" | "folder";
	path: string;
	visibility: "private" | "public" | "protected";
	password?: string; // Optional password for protected shares
}

/**
 * Item in a folder for web publishing
 */
export interface FolderItem {
	path: string;
	name: string;
	type: "doc" | "folder" | "canvas";
}

/**
 * Request to update a share
 */
export interface UpdateShareRequest {
	visibility?: "private" | "public" | "protected";
	password?: string;
	// Web publishing fields (v1.7)
	web_published?: boolean;
	web_slug?: string;
	web_noindex?: boolean;
	web_sync_mode?: "manual" | "auto"; // v1.8.1 - Sync mode for web publishing
	web_content?: string; // Document content for web publishing
	web_folder_items?: FolderItem[]; // Folder contents for web publishing
	web_doc_id?: string; // Y-sweet document ID for real-time sync
}

/**
 * Request to add a member to a share
 */
export interface AddMemberRequest {
	user_id: string;
	role: "viewer" | "editor";
}

/**
 * Invite data from control plane API
 */
export interface Invite {
	id: string;
	share_id: string;
	token: string;
	created_by: string;
	role: "viewer" | "editor";
	expires_at: string | null;
	max_uses: number | null;
	use_count: number;
	revoked_at: string | null;
	created_at: string;
	updated_at: string;
}

/**
 * Request to create an invite
 */
export interface CreateInviteRequest {
	role: "viewer" | "editor";
	expires_in_days?: number | null;
	max_uses?: number | null;
}

/**
 * OAuth provider information
 */
export interface OAuthProvider {
	name: string;
	display_name: string;
	authorize_url: string;
}

/**
 * Server information response
 */
export interface ServerInfo {
	id: string;
	name: string;
	version: string;
	relay_url: string;
	edition?: string; // "community" | "enterprise"
	features: ServerFeatures;
	web_publish_enabled?: boolean;
	web_publish_domain?: string | null;
}

/**
 * Server features
 */
export interface ServerFeatures {
	multi_user: boolean;
	share_members: boolean;
	audit_logging: boolean;
	admin_ui: boolean;
	oauth_enabled?: boolean;
	oauth_provider?: string | null;
	web_publish_enabled?: boolean;
	web_publish_domain?: string | null;
	billing_enabled?: boolean;
}

/**
 * Billing plan response from GET /v1/billing/plan
 */
export interface BillingPlanResponse {
	plan: string;
	subscription: BillingSubscription | null;
	entitlements: Record<string, { limit: number | null }>;
	usage: Record<string, { current: number; max: number | null; percentage: number | null }>;
}

export interface BillingSubscription {
	id: string;
	status: string;
	current_period_end?: string;
	cancel_at_period_end?: boolean;
}

/**
 * Available plan info from GET /v1/billing/plans
 */
export interface AvailablePlan {
	id: string;
	name: string;
	service_id: string;
	type: string;
	status: string;
	prices: Array<{
		id: string;
		amount: number;
		currency: string;
		billing_period: string;
	}>;
	entitlements: Record<string, { limit: number | null }>;
	metadata: Record<string, unknown>;
}

/**
 * Limit exceeded error response (403)
 */
export interface LimitExceededError {
	error: "limit_exceeded";
	detail: string;
	limit: string;
	current: number;
	max: number;
	plan: string;
}

/**
 * Error thrown when a billing limit is exceeded (403 from server)
 */
export class LimitExceededApiError extends Error {
	public readonly limitInfo: LimitExceededError;

	constructor(limitInfo: LimitExceededError) {
		super(limitInfo.detail || `Limit exceeded: ${limitInfo.limit} (${limitInfo.current}/${limitInfo.max})`);
		this.name = "LimitExceededApiError";
		this.limitInfo = limitInfo;
	}
}

/**
 * Visibility not allowed error response (403)
 */
export interface VisibilityNotAllowedError {
	error: "visibility_not_allowed";
	detail: string;
	visibility: string;
	allowed: string[];
	plan: string;
}

/**
 * Error thrown when a visibility tier is not in the user's plan (403 from server)
 */
export class VisibilityNotAllowedApiError extends Error {
	public readonly visibilityInfo: VisibilityNotAllowedError;

	constructor(visibilityInfo: VisibilityNotAllowedError) {
		super(visibilityInfo.detail || `Visibility '${visibilityInfo.visibility}' requires a higher plan`);
		this.name = "VisibilityNotAllowedApiError";
		this.visibilityInfo = visibilityInfo;
	}
}

/**
 * Error thrown when a billing API call fails with an HTTP error
 */
export class BillingApiError extends Error {
	public readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "BillingApiError";
		this.status = status;
	}
}

/**
 * Share list response from API (returns array directly)
 */
export type ShareListResponse = RelayOnPremShare[];

/**
 * Share detail response (just the share, members fetched separately)
 */
export type ShareDetailResponse = RelayOnPremShare;

/**
 * Client for relay-onprem share management API
 */
export class RelayOnPremShareClient {
	private readonly normalizedUrl: string;

	constructor(
		controlPlaneUrl: string,
		private getAuthToken: () => string | undefined | Promise<string | undefined>,
	) {
		// Normalize URL: remove trailing slashes to prevent double-slash issues
		this.normalizedUrl = controlPlaneUrl.replace(/\/+$/, "");
		log(`Initialized with URL: ${this.normalizedUrl}`);
	}

	/**
	 * Get authorization headers (awaits token refresh if needed)
	 */
	private async getHeaders(): Promise<HeadersInit> {
		const token = await Promise.resolve(this.getAuthToken());
		if (!token) {
			throw new Error("Not authenticated");
		}

		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		};
	}

	/**
	 * List all shares for the current user
	 */
	async listShares(): Promise<ShareListResponse> {
		log("Fetching shares list...");

		try {
			const response = await customFetch(`${this.normalizedUrl}/shares`, {
				method: "GET",
				headers: await this.getHeaders(),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to list shares: ${response.status} ${errorText}`);
			}

			const data: ShareListResponse = await response.json();
			log(`Retrieved ${data.length} shares`);
			return data;
		} catch (error: unknown) {
			log("Error listing shares:", error);
			throw error;
		}
	}

	/**
	 * Get a specific share by ID
	 */
	async getShare(shareId: string): Promise<ShareDetailResponse> {
		log(`Fetching share ${shareId}...`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/shares/${shareId}`,
				{
					method: "GET",
					headers: await this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to get share: ${response.status} ${errorText}`);
			}

			const data: ShareDetailResponse = await response.json();
			log(`Retrieved share: ${data.path}`);
			return data;
		} catch (error: unknown) {
			log("Error getting share:", error);
			throw error;
		}
	}

	/**
	 * Get members of a share
	 */
	async getShareMembers(shareId: string): Promise<ShareMember[]> {
		log(`Fetching members for share ${shareId}...`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/shares/${shareId}/members`,
				{
					method: "GET",
					headers: await this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to get share members: ${response.status} ${errorText}`);
			}

			const members: ShareMember[] = await response.json();
			log(`Retrieved ${members.length} members`);
			return members;
		} catch (error: unknown) {
			log("Error getting share members:", error);
			throw error;
		}
	}

	/**
	 * Create a new share
	 */
	async createShare(request: CreateShareRequest): Promise<RelayOnPremShare> {
		log(`Creating share: ${request.path}`);

		try {
			const response = await customFetch(`${this.normalizedUrl}/shares`, {
				method: "POST",
				headers: await this.getHeaders(),
				body: JSON.stringify(request),
			});

			if (!response.ok) {
				const errorText = await response.text();
				if (response.status === 403) {
					const limitError = RelayOnPremShareClient.parseLimitExceededError(errorText);
					if (limitError) {
						throw new LimitExceededApiError(limitError);
					}
				}
				throw new Error(`Failed to create share: ${response.status} ${errorText}`);
			}

			const share: RelayOnPremShare = await response.json();
			log(`Created share: ${share.id}`);
			return share;
		} catch (error: unknown) {
			log("Error creating share:", error);
			throw error;
		}
	}

	/**
	 * Update an existing share
	 */
	async updateShare(
		shareId: string,
		request: UpdateShareRequest,
	): Promise<RelayOnPremShare> {
		log(`Updating share ${shareId}`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/shares/${shareId}`,
				{
					method: "PATCH",
					headers: await this.getHeaders(),
					body: JSON.stringify(request),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				if (response.status === 403) {
					const limitError = RelayOnPremShareClient.parseLimitExceededError(errorText);
					if (limitError) throw new LimitExceededApiError(limitError);
					const visError = RelayOnPremShareClient.parseVisibilityNotAllowedError(errorText);
					if (visError) throw new VisibilityNotAllowedApiError(visError);
				}
				throw new Error(`Failed to update share: ${response.status} ${errorText}`);
			}

			const share: RelayOnPremShare = await response.json();
			log(`Updated share: ${share.id}`);
			return share;
		} catch (error: unknown) {
			log("Error updating share:", error);
			throw error;
		}
	}

	/**
	 * Delete a share
	 */
	async deleteShare(shareId: string): Promise<void> {
		log(`Deleting share ${shareId}`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/shares/${shareId}`,
				{
					method: "DELETE",
					headers: await this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to delete share: ${response.status} ${errorText}`);
			}

			log(`Deleted share: ${shareId}`);
		} catch (error: unknown) {
			log("Error deleting share:", error);
			throw error;
		}
	}

	/**
	 * Add a member to a share
	 */
	async addMember(shareId: string, request: AddMemberRequest): Promise<ShareMember> {
		log(`Adding member to share ${shareId}: ${request.user_id}`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/shares/${shareId}/members`,
				{
					method: "POST",
					headers: await this.getHeaders(),
					body: JSON.stringify(request),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				if (response.status === 403) {
					const limitError = RelayOnPremShareClient.parseLimitExceededError(errorText);
					if (limitError) {
						throw new LimitExceededApiError(limitError);
					}
				}
				throw new Error(`Failed to add member: ${response.status} ${errorText}`);
			}

			const member: ShareMember = await response.json();
			log(`Added member: ${member.user_id}`);
			return member;
		} catch (error: unknown) {
			log("Error adding member:", error);
			throw error;
		}
	}

	/**
	 * Remove a member from a share
	 */
	async removeMember(shareId: string, userId: string): Promise<void> {
		log(`Removing member ${userId} from share ${shareId}`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/shares/${shareId}/members/${userId}`,
				{
					method: "DELETE",
					headers: await this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to remove member: ${response.status} ${errorText}`);
			}

			log(`Removed member: ${userId}`);
		} catch (error: unknown) {
			log("Error removing member:", error);
			throw error;
		}
	}

	/**
	 * Update a member's permission
	 */
	async updateMemberRole(
		shareId: string,
		userId: string,
		role: "viewer" | "editor",
	): Promise<ShareMember> {
		log(`Updating member ${userId} role in share ${shareId} to ${role}`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/shares/${shareId}/members/${userId}`,
				{
					method: "PATCH",
					headers: await this.getHeaders(),
					body: JSON.stringify({ role }),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Failed to update member role: ${response.status} ${errorText}`,
				);
			}

			const member: ShareMember = await response.json();
			log(`Updated member role: ${member.user_id}`);
			return member;
		} catch (error: unknown) {
			log("Error updating member role:", error);
			throw error;
		}
	}

	/**
	 * Search for a user by email address
	 */
	async searchUserByEmail(email: string): Promise<User> {
		log(`Searching for user: ${email}`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/users/search?email=${encodeURIComponent(email)}`,
				{
					method: "GET",
					headers: await this.getHeaders(),
				},
			);

			if (!response.ok) {
				if (response.status === 404) {
					throw new Error(`User with email '${email}' not found`);
				}
				const errorText = await response.text();
				throw new Error(`Failed to search user: ${response.status} ${errorText}`);
			}

			const user: User = await response.json();
			log(`Found user: ${user.id}`);
			return user;
		} catch (error: unknown) {
			log("Error searching user:", error);
			throw error;
		}
	}

	/**
	 * Create an invite link for a share
	 */
	async createInvite(shareId: string, request: CreateInviteRequest): Promise<Invite> {
		log(`Creating invite for share ${shareId}`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/shares/${shareId}/invites`,
				{
					method: "POST",
					headers: await this.getHeaders(),
					body: JSON.stringify(request),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to create invite: ${response.status} ${errorText}`);
			}

			const invite: Invite = await response.json();
			log(`Created invite: ${invite.id}`);
			return invite;
		} catch (error: unknown) {
			log("Error creating invite:", error);
			throw error;
		}
	}

	/**
	 * List all invites for a share
	 */
	async listInvites(shareId: string): Promise<Invite[]> {
		log(`Fetching invites for share ${shareId}`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/shares/${shareId}/invites`,
				{
					method: "GET",
					headers: await this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to list invites: ${response.status} ${errorText}`);
			}

			const invites: Invite[] = await response.json();
			log(`Retrieved ${invites.length} invites`);
			return invites;
		} catch (error: unknown) {
			log("Error listing invites:", error);
			throw error;
		}
	}

	/**
	 * Revoke an invite link
	 */
	async revokeInvite(shareId: string, inviteId: string): Promise<void> {
		log(`Revoking invite ${inviteId} from share ${shareId}`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/shares/${shareId}/invites/${inviteId}`,
				{
					method: "DELETE",
					headers: await this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to revoke invite: ${response.status} ${errorText}`);
			}

			log(`Revoked invite: ${inviteId}`);
		} catch (error: unknown) {
			log("Error revoking invite:", error);
			throw error;
		}
	}

	/**
	 * Get list of available OAuth providers
	 */
	async getOAuthProviders(): Promise<OAuthProvider[]> {
		log("Fetching OAuth providers...");

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/v1/auth/oauth/providers`,
				{
					method: "GET",
					headers: {
						"Content-Type": "application/json",
					},
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to get OAuth providers: ${response.status} ${errorText}`);
			}

			const providers: OAuthProvider[] = await response.json();
			log(`Retrieved ${providers.length} OAuth providers`);
			return providers;
		} catch (error: unknown) {
			log("Error getting OAuth providers:", error);
			throw error;
		}
	}

	/**
	 * Get server information including web publishing support
	 */
	async getServerInfo(): Promise<ServerInfo> {
		log("Fetching server info...");

		try {
			const response = await customFetch(`${this.normalizedUrl}/server/info`, {
				method: "GET",
				headers: {
					"Content-Type": "application/json",
				},
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to get server info: ${response.status} ${errorText}`);
			}

			const info: ServerInfo = await response.json();
			log(`Retrieved server info: ${info.name} v${info.version}`);
			return info;
		} catch (error: unknown) {
			log("Error getting server info:", error);
			throw error;
		}
	}

	/**
	 * Sync file content for a folder share (v1.8 web editing)
	 */
	async syncFolderFileContent(
		slug: string,
		path: string,
		content: string,
	): Promise<void> {
		log(`Syncing folder file content: ${slug}${path}`);

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/v1/web/shares/${slug}/files?path=${encodeURIComponent(path)}`,
				{
					method: "POST",
					headers: await this.getHeaders(),
					body: JSON.stringify({ content }),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Failed to sync folder file content: ${response.status} ${errorText}`,
				);
			}

			log(`Successfully synced file content: ${path}`);
		} catch (error: unknown) {
			log("Error syncing folder file content:", error);
			throw error;
		}
	}

	/**
	 * Check if server supports billing (enterprise edition + billing_enabled)
	 */
	isBillingSupported(serverInfo: ServerInfo): boolean {
		return serverInfo.edition === "enterprise" && serverInfo.features?.billing_enabled === true;
	}

	/**
	 * Get current user's billing plan, entitlements, and usage
	 */
	async getBillingPlan(): Promise<BillingPlanResponse> {
		log("Fetching billing plan...");

		try {
			const response = await customFetch(`${this.normalizedUrl}/v1/billing/plan`, {
				method: "GET",
				headers: await this.getHeaders(),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to get billing plan: ${response.status} ${errorText}`);
			}

			const plan: BillingPlanResponse = await response.json();
			log(`Retrieved billing plan: ${plan.plan}`);
			return plan;
		} catch (error: unknown) {
			log("Error getting billing plan:", error);
			throw error;
		}
	}

	/**
	 * Get available billing plans
	 */
	async getAvailablePlans(): Promise<AvailablePlan[]> {
		log("Fetching available plans...");

		try {
			const response = await customFetch(`${this.normalizedUrl}/v1/billing/plans`, {
				method: "GET",
				headers: {
					"Content-Type": "application/json",
				},
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to get available plans: ${response.status} ${errorText}`);
			}

			const data = await response.json();
			log(`Retrieved ${data.plans.length} available plans`);
			return data.plans;
		} catch (error: unknown) {
			log("Error getting available plans:", error);
			throw error;
		}
	}

	/**
	 * Create a checkout session for upgrading to a paid plan
	 */
	async createCheckout(productId: string, priceId: string): Promise<{ checkout_url?: string; id?: string; status?: string }> {
		log(`Creating checkout for product ${productId}, price ${priceId}...`);
		const response = await customFetch(`${this.normalizedUrl}/v1/billing/checkout`, {
			method: "POST",
			headers: await this.getHeaders(),
			body: JSON.stringify({ product_id: productId, price_id: priceId }),
		});

		if (!response.ok) {
			const errorText = await response.text();
			let message = `Failed to create checkout: ${response.status}`;
			try {
				const body = JSON.parse(errorText);
				message = body?.error?.message || body?.detail || message;
			} catch { /* use default message */ }
			throw new BillingApiError(message, response.status);
		}

		return response.json();
	}

	/**
	 * Change plan on an existing subscription (e.g. upgrade/downgrade)
	 */
	async changePlan(productId: string, priceId?: string): Promise<{ status?: string; message?: string; product_id?: string }> {
		log(`Changing plan to product ${productId}...`);
		const body: Record<string, string> = { product_id: productId };
		if (priceId) body.price_id = priceId;

		const response = await customFetch(`${this.normalizedUrl}/v1/billing/change-plan`, {
			method: "POST",
			headers: await this.getHeaders(),
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text();
			let message = `Failed to change plan: ${response.status}`;
			try {
				const parsed = JSON.parse(errorText);
				message = parsed?.error?.message || parsed?.detail || message;
			} catch { /* use default message */ }
			throw new BillingApiError(message, response.status);
		}

		return response.json();
	}

	/**
	 * Cancel the current subscription
	 */
	async cancelSubscription(): Promise<{ status: string; message?: string }> {
		log("Cancelling subscription...");
		const response = await customFetch(`${this.normalizedUrl}/v1/billing/cancel`, {
			method: "POST",
			headers: await this.getHeaders(),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Failed to cancel subscription: ${response.status} ${errorText}`);
		}

		return response.json();
	}

	/**
	 * Create a Stripe Customer Portal session for subscription management
	 */
	async createPortalSession(
		returnUrl?: string,
	): Promise<{ url?: string; message?: string }> {
		log("Creating portal session...");
		const response = await customFetch(
			`${this.normalizedUrl}/v1/billing/portal`,
			{
				method: "POST",
				headers: await this.getHeaders(),
				body: JSON.stringify({
					return_url: returnUrl || "",
				}),
			},
		);

		if (!response.ok) {
			const errorText = await response.text();
			let message = `Failed to create portal session: ${response.status}`;
			try {
				const parsed = JSON.parse(errorText);
				message = parsed?.error?.message || parsed?.detail || message;
			} catch { /* use default message */ }
			throw new BillingApiError(message, response.status);
		}

		return response.json();
	}

	/**
	 * Parse a limit_exceeded error response from a 403 status
	 */
	static parseLimitExceededError(errorText: string): LimitExceededError | null {
		try {
			const data = JSON.parse(errorText);
			if (data.error === "limit_exceeded") {
				return data as LimitExceededError;
			}
		} catch {
			// Not a JSON response or not a limit_exceeded error
		}
		return null;
	}

	/**
	 * Parse a visibility_not_allowed error response from a 403 status
	 */
	static parseVisibilityNotAllowedError(errorText: string): VisibilityNotAllowedError | null {
		try {
			const data = JSON.parse(errorText);
			if (data.error === "visibility_not_allowed") {
				return data as VisibilityNotAllowedError;
			}
		} catch {
			// Not a JSON response or not a visibility error
		}
		return null;
	}
}
