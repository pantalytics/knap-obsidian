import type { LiveTokenStore } from "./LiveTokenStore";
import { S3RN } from "./S3RN";
import type { SharedFolder } from "./SharedFolder";
import type { SyncFile } from "./SyncFile";
import { customFetch } from "./customFetch";
import { HasLogging } from "./debug";


interface DownloadUrlApiResponse { downloadUrl: string }
interface UploadUrlApiResponse { uploadUrl: string; error?: string }

export class ContentAddressedStore extends HasLogging {
	private tokenStore: LiveTokenStore;

	constructor(private sharedFolder: SharedFolder) {
		super();
		// TR-58: this class never actually calls PocketBase (every real request
		// below goes through customFetch against token.baseUrl) — it used to
		// construct one anyway (unconditionally, unguarded by relayOnPrem mode)
		// just to call cancelAllRequests() in destroy(), which is a no-op on a
		// client that never issued a request. Removed rather than gated: unlike
		// LoginManager's PocketBase usage, there was no live behavior here to
		// preserve, just an unused construction that hit the same
		// getAuthUrl()==="" trap this task was filed to fix.
		this.tokenStore = sharedFolder.tokenStore;
	}

	async verify(syncFile: SyncFile): Promise<boolean> {
		if (!syncFile.meta) {
			throw new Error("cannot head file with missing hash");
		}
		const sha256 = syncFile.meta.hash;
		const token = await this.tokenStore.getFileToken(
			S3RN.encode(syncFile.s3rn),
			sha256,
			syncFile.mimetype,
			0,
		);
		const response = await customFetch(token.baseUrl!, {
			method: "HEAD",
			headers: { Authorization: `Bearer ${token.token}` },
		});
		return response.status === 200;
	}

	async readFile(syncFile: SyncFile): Promise<ArrayBuffer> {
		if (!syncFile.meta) {
			throw new Error("cannot pull file with missing hash");
		}
		const sha256 = syncFile.meta.hash;
		const token = await this.tokenStore.getFileToken(
			S3RN.encode(syncFile.s3rn),
			sha256,
			syncFile.mimetype,
			0,
		);
		const response = await customFetch(token.baseUrl + "/download-url", {
			method: "GET",
			headers: { Authorization: `Bearer ${token.token}` },
		});
		if (response.status === 404) {
			throw new Error(
				`[${this.sharedFolder.path}] File is missing: ${syncFile.guid} ${syncFile.meta.hash} ${syncFile.meta.type}`,
			);
		}
		const responseJson = await response.json() as DownloadUrlApiResponse;
		const presignedUrl = responseJson.downloadUrl;
		const downloadResponse = await customFetch(presignedUrl);
		return downloadResponse.arrayBuffer();
	}

	async writeFile(syncFile: SyncFile): Promise<void> {
		const content = await syncFile.caf.read();
		const hash = await syncFile.caf.hash();
		this.log("writeFile", hash);
		if (!(content && hash)) {
			throw new Error("invalid caf");
		}
		const token = await this.tokenStore.getFileToken(
			S3RN.encode(syncFile.s3rn),
			hash,
			syncFile.mimetype,
			content.byteLength,
		);
		const response = await customFetch(token.baseUrl + "/upload-url", {
			method: "POST",
			headers: { Authorization: `Bearer ${token.token}` },
		});
		const responseJson = await response.json() as UploadUrlApiResponse;
		if (response.status !== 200) {
			throw new Error(responseJson.error);
		}
		const presignedUrl = responseJson.uploadUrl;
		await customFetch(presignedUrl, {
			method: "PUT",
			headers: { "Content-Type": syncFile.mimetype },
			body: content,
		});
		return;
	}

	public destroy() {
		this.tokenStore = null as unknown as LiveTokenStore;
		this.sharedFolder = null as unknown as SharedFolder;
	}
}
