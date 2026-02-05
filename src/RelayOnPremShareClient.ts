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
		private getAuthToken: () => string | undefined,
	) {
		// Normalize URL: remove trailing slashes to prevent double-slash issues
		this.normalizedUrl = controlPlaneUrl.replace(/\/+$/, "");
		log(`Initialized with URL: ${this.normalizedUrl}`);
	}

	/**
	 * Get authorization headers
	 */
	private getHeaders(): HeadersInit {
		const token = this.getAuthToken();
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
				headers: this.getHeaders(),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to list shares: ${response.status} ${errorText}`);
			}

			const data: ShareListResponse = await response.json();
			log(`Retrieved ${data.length} shares`);
			return data;
		} catch (error) {
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
					headers: this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to get share: ${response.status} ${errorText}`);
			}

			const data: ShareDetailResponse = await response.json();
			log(`Retrieved share: ${data.path}`);
			return data;
		} catch (error) {
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
					headers: this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to get share members: ${response.status} ${errorText}`);
			}

			const members: ShareMember[] = await response.json();
			log(`Retrieved ${members.length} members`);
			return members;
		} catch (error) {
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
				headers: this.getHeaders(),
				body: JSON.stringify(request),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to create share: ${response.status} ${errorText}`);
			}

			const share: RelayOnPremShare = await response.json();
			log(`Created share: ${share.id}`);
			return share;
		} catch (error) {
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
					headers: this.getHeaders(),
					body: JSON.stringify(request),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to update share: ${response.status} ${errorText}`);
			}

			const share: RelayOnPremShare = await response.json();
			log(`Updated share: ${share.id}`);
			return share;
		} catch (error) {
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
					headers: this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to delete share: ${response.status} ${errorText}`);
			}

			log(`Deleted share: ${shareId}`);
		} catch (error) {
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
					headers: this.getHeaders(),
					body: JSON.stringify(request),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to add member: ${response.status} ${errorText}`);
			}

			const member: ShareMember = await response.json();
			log(`Added member: ${member.user_id}`);
			return member;
		} catch (error) {
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
					headers: this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to remove member: ${response.status} ${errorText}`);
			}

			log(`Removed member: ${userId}`);
		} catch (error) {
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
					headers: this.getHeaders(),
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
		} catch (error) {
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
					headers: this.getHeaders(),
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
		} catch (error) {
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
					headers: this.getHeaders(),
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
		} catch (error) {
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
					headers: this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to list invites: ${response.status} ${errorText}`);
			}

			const invites: Invite[] = await response.json();
			log(`Retrieved ${invites.length} invites`);
			return invites;
		} catch (error) {
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
					headers: this.getHeaders(),
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to revoke invite: ${response.status} ${errorText}`);
			}

			log(`Revoked invite: ${inviteId}`);
		} catch (error) {
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
		} catch (error) {
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
		} catch (error) {
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
					headers: this.getHeaders(),
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
		} catch (error) {
			log("Error syncing folder file content:", error);
			throw error;
		}
	}
}
