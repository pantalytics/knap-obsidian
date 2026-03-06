// Code in this file has been adapted from y-codemirror.next
// License
// [The MIT License](./LICENSE) © Kevin Jahns

import { Facet, Annotation } from "@codemirror/state";
import type { ChangeSpec } from "@codemirror/state";
import { EditorView, ViewUpdate, ViewPlugin } from "@codemirror/view";
import type { PluginValue } from "@codemirror/view";
import {
	LiveView,
	LiveViewManager,
	ConnectionManagerStateField,
	type S3View,
	isLiveMd,
} from "../LiveViews";
import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import { curryLog } from "src/debug";
import { getPatcher } from "../Patcher";
import diff_match_patch from "diff-match-patch";
import { flags } from "src/flagManager";
import { MarkdownView, editorInfoField } from "obsidian";
import { Document } from "src/Document";
import { EmbedBanner } from "src/ui/EmbedBanner";
import { ViewHookPlugin } from "src/plugins/ViewHookPlugin";

export const connectionManagerFacet: Facet<LiveViewManager, LiveViewManager> =
	Facet.define({
		combine(inputs) {
			return inputs[inputs.length - 1];
		},
	});

export const ySyncAnnotation = Annotation.define();

export class LiveCMPluginValue implements PluginValue {
	editor: EditorView;
	view?: LiveView<MarkdownView>;
	connectionManager?: LiveViewManager;
	initialSet = false;
	sourceView: Element | null;
	banner?: EmbedBanner;
	private destroyed = false;
	_observer?: (event: YTextEvent, tr: Transaction) => void;
	observer?: (event: YTextEvent, tr: Transaction) => void;
	_ytext?: YText;
	keyFrameCounter = 0;
	unsubscribes: Array<() => void>;
	debug: (...args: unknown[]) => void = (...args: unknown[]) => {};
	log: (...args: unknown[]) => void = (...args: unknown[]) => {};
	warn: (...args: unknown[]) => void = (...args: unknown[]) => {};
	error: (...args: unknown[]) => void = (...args: unknown[]) => {};
	document?: Document;
	embed = false;
	viewHookPlugin?: ViewHookPlugin;

	getDocument(): Document | undefined {
		const fileInfo = this.editor.state.field(editorInfoField);
		const file = fileInfo.file;
		if (file) {
			if (this.document?._tfile === file) {
				return this.document;
			}
			const folder = this.connectionManager?.sharedFolders.lookup(file.path);
			if (folder) {
				this.document = folder.proxy.getDoc(file.path);
				return this.document;
			}
		}
		this.view = this.connectionManager?.findView(this.editor);
		if (this.view && this.view.document instanceof Document) {
			return this.view.document;
		}
	}

	active(view?: S3View) {
		const live = isLiveMd(view);
		return live || (this.embed && this.document);
	}

	mergeBanner(): () => void {
		if (this.destroyed || !this.editor) {
			return () => {};
		}

		this.banner = new EmbedBanner(
			this.sourceView,
			this.editor.dom,
			"Merge conflict -- click to resolve",
			async () => {
				if (!this.document) return true;
				const diskBuffer = await this.document.diskBuffer();
				let stale: boolean;
				try {
					stale = await this.document.checkStale();
				} catch (e: unknown) {
					this.warn("[mergeBanner] checkStale failed:", (e as Error).message);
					return true;
				}
				if (!stale) {
					return true;
				}
				this.connectionManager?.openDiffView({
					file1: this.document,
					file2: diskBuffer,
					showMergeOption: true,
					onResolve: () => {
						if (this.destroyed || !this.editor || !this.document) {
							return Promise.resolve();
						}
						void this.document.clearDiskBuffer();
						void this.resync();
						return Promise.resolve();
					},
				});
				return true;
			},
		);
		return () => {};
	}

	constructor(editor: EditorView) {
		this.unsubscribes = [];
		this.editor = editor;
		this.sourceView = this.editor.dom.closest(".markdown-source-view");
		this.connectionManager = this.editor.state.field(
			ConnectionManagerStateField,
		);

		// For SharedFolder documents, add the live editor class so this plugin
		// (and RemoteSelections) activates for real-time CRDT editing.
		// Without this, SharedFolder docs fail the allowlist check below and
		// the Y.Text ↔ CodeMirror binding is never established.
		const fileInfo = this.editor.state.field(editorInfoField);
		const file = fileInfo?.file;
		if (file && this.connectionManager?.sharedFolders.lookup(file.path)) {
			this.sourceView?.classList.add("relay-live-editor");
		}

		// Allowlist: Check for live editing markers
		const isLiveEditor = this.editor.dom.closest(".relay-live-editor");
		const hasIframeClass =
			this.sourceView?.classList.contains("mod-inside-iframe");

		// For embedded canvas editors, we can't always find the canvas via ConnectionManager
		// but if it has mod-inside-iframe, it's likely a legitimate embedded editor
		const isEmbeddedInCanvas = hasIframeClass;

		if (!isLiveEditor && !isEmbeddedInCanvas) {
			this.destroyed = true;
			return;
		}

		this.view = this.connectionManager?.findView(this.editor);
		this.document = this.getDocument();
		if (!this.document) {
			this.destroyed = true;
			return;
		}
		if (!this.view) {
			this.embed = true;
		} else {
			this.viewHookPlugin = new ViewHookPlugin(this.view.view, this.document);
		}
		this.log = curryLog(`[LiveCMPluginValue][${this.document.path}]`, "log");
		this.warn = curryLog(`[LiveCMPluginValue][${this.document.path}]`, "warn");
		this.error = curryLog(
			`[LiveCMPluginValue][${this.document.path}]`,
			"error",
		);
		this.debug = curryLog(
			`[LiveCMPluginValue][${this.document.path}]`,
			"debug",
		);
		this.debug("created");

		// eslint-disable-next-line @typescript-eslint/no-this-alias -- needed to preserve `this` reference inside getPatcher callback functions where `this` is rebound
		const liveEditPlugin = this;
		let fmSave = false;

		if (this.view?.view) {
			this.unsubscribes.push(
				getPatcher().patch(this.view.view, {
					setViewData(old: unknown) {
						return function (data: string, clear: boolean) {
							if (clear) {
								if (isLiveMd(liveEditPlugin.view)) {
									if (liveEditPlugin.view.document.text === data) {
										liveEditPlugin.view.tracking = true;
									}
								}
								void liveEditPlugin.resync();
							} else if (fmSave) {
								const changes = liveEditPlugin.incrementalBufferChange(data);
								editor.dispatch({
									changes,
								});
								return;
							}
							// @ts-ignore
							return old.call(this, data, clear);
						};
					},
					// @ts-ignore
					saveFrontmatter(old: unknown) {
						return function (data: unknown) {
							fmSave = true;
							// @ts-ignore
							const result = old.call(this, data);
							fmSave = false;
							return result;
						};
					},
					requestSave(old: unknown) {
						return function () {
							// @ts-ignore
							const result = old.call(this);
							if (!liveEditPlugin.destroyed && liveEditPlugin.document) {
								try {
									// @ts-ignore
									this.app.metadataCache.trigger("resolve", this.file);
								} catch {
									// pass
								}
							}
							return result;
						};
					},
				}),
			);
		} else {
			void this.document.connect();
		}

		if (this.document.connected) {
			void this.resync();
		} else {
			void this.document.onceConnected().then(() => {
				void this.resync();
			});
		}

		// Initialize ViewHookPlugin
		if (this.viewHookPlugin) {
			this.viewHookPlugin.initialize().catch((error: unknown) => {
				this.error("Error initializing ViewHookPlugin:", error);
			});
		}

		// Synchronous observer — MUST NOT be async to prevent interleaving.
		// Yjs calls observers synchronously; async observers cause concurrent
		// getKeyFrame() calls that overwrite each other with stale snapshots.
		this._observer = (event: YTextEvent, tr: Transaction) => {
			this.document = this.getDocument();

			if (!this.active(this.view)) {
				this.debug("Recived yjs event against a non-live view");
				return;
			}
			if (this.destroyed) {
				this.debug("Recived yjs event but editor was destroyed");
				return;
			}

			// Called when a yjs event is received. Results in updates to codemirror.
			if (tr.origin !== this) {
				let changes: ChangeSpec[];

				if (isLiveMd(this.view) && !this.view.tracking) {
					// Not tracking: editor and ytext may be out of sync.
					// Compute a synchronous keyframe (full diff) to reconcile.
					// MUST be synchronous — async getKeyFrame races with user typing.
					if (!this.document) {
						this.debug("not tracking, no document");
						return;
					}
					if (this.document.text === this.editor.state.doc.toString()) {
						// Already in sync — just set tracking
						this.view.tracking = true;
						this.debug("not tracking but content matches, set tracking=true");
						return;
					}
					changes = this.getBufferChange(this.document.text, true);
					this.debug("dispatch (sync keyframe)");
				} else {
					// Tracking: apply Yjs delta incrementally (fast path)
					const delta = event.delta;
					changes = [];
					let pos = 0;
					for (let i = 0; i < delta.length; i++) {
						const d = delta[i];
						if (d.insert != null) {
							changes.push({
								from: pos,
								to: pos,
								insert: d.insert as string,
							});
						} else if (d.delete != null) {
							changes.push({
								from: pos,
								to: pos + d.delete,
								insert: "",
							});
							pos += d.delete;
						} else if (d.retain != null) {
							pos += d.retain;
						}
					}
					this.keyFrameCounter += 1;
					this.debug(`dispatch (incremental + ${this.keyFrameCounter})`);
				}

				if (this.active(this.view)) {
					editor.dispatch({
						changes,
						annotations: [ySyncAnnotation.of(this.editor)],
					});
					if (isLiveMd(this.view)) {
						this.view.tracking = true;
					}
				}
			}
		};

		this.observer = (event: YTextEvent, tr: Transaction) => {
			try {
				this._observer?.(event, tr);
			} catch (e: unknown) {
				if (e instanceof RangeError) {
					if (isLiveMd(this.view)) {
						this.view.tracking = false;
					}
					this.warn("[observer] RangeError, scheduling resync");
					void this.resync();
				}
			}
		};
		this._ytext = this.document.ytext;
		this._ytext.observe(this.observer);
	}

	public incrementalBufferChange(newBuffer: string): ChangeSpec[] {
		const currentBuffer = this.editor.state.doc.toString();
		const dmp = new diff_match_patch();
		const diffs = dmp.diff_main(currentBuffer, newBuffer);
		dmp.diff_cleanupSemantic(diffs);

		const changes: ChangeSpec[] = [];
		let currentPos = 0;

		for (const [type, text] of diffs) {
			switch (type) {
				case 0: // EQUAL
					currentPos += text.length;
					break;
				case 1: // INSERT
					changes.push({
						from: currentPos,
						to: currentPos,
						insert: text,
					});
					currentPos += text.length;
					break;
				case -1: // DELETE
					changes.push({
						from: currentPos,
						to: currentPos + text.length,
						insert: "",
					});
					break;
			}
		}
		return changes;
	}

	public getBufferChange(newBuffer: string, incremental = false): ChangeSpec[] {
		if (incremental) {
			return this.incrementalBufferChange(newBuffer);
		}
		return [
			{
				from: 0,
				to: this.editor.state.doc.length,
				insert: newBuffer,
			},
		];
	}

	async resync() {
		if (isLiveMd(this.view) && !this.view.tracking && !this.destroyed) {
			await this.view.document.whenSynced();
			await this.waitForProviderSync();
			// Guard: if relay returned empty content but the editor has text,
			// upload the editor content to Y.Text instead of wiping the editor.
			// This prevents data loss when opening a file before background sync
			// has uploaded its content to a newly created share.
			if (this.view.document.text === "" && this.editor.state.doc.length > 0) {
				const editorContent = this.editor.state.doc.toString();
				this.warn("[resync] relay is empty but editor has content — uploading to Y.Text");
				this.view.document.ydoc.getText("contents").insert(0, editorContent);
				this.view.tracking = true;
				return;
			}
			const keyFrame = await this.getKeyFrame();
			if (isLiveMd(this.view) && !this.view.tracking && !this.destroyed) {
				this.editor.dispatch({
					changes: keyFrame,
					annotations: [ySyncAnnotation.of(this.editor)],
				});
			}
		} else if (this.active(this.view) && this.document) {
			await this.document.whenSynced();
			await this.waitForProviderSync();
			// Same guard for embedded/SharedFolder documents
			if (this.document.text === "" && this.editor.state.doc.length > 0) {
				const editorContent = this.editor.state.doc.toString();
				this.warn("[resync] relay is empty but editor has content — uploading to Y.Text");
				this.document.ydoc.getText("contents").insert(0, editorContent);
				return;
			}
			const keyFrame = await this.getKeyFrame();
			if (this.active(this.view) && !this.destroyed) {
				this.editor.dispatch({
					changes: keyFrame,
					annotations: [ySyncAnnotation.of(this.editor)],
				});
			}
		}
	}

	/**
	 * Wait for the provider to finish syncing with the relay server.
	 * Without this, resync() uses stale Y.Text data from IDB, sets tracking=true,
	 * and then the relay sync arrives with incremental deltas that reference
	 * different positions — causing character loss and missing newlines.
	 */
	private async waitForProviderSync(): Promise<void> {
		if (!this.document) return;
		const provider = this.document._provider;
		if (!provider || provider.synced) return;
		// Only wait if the document is connected or connecting
		if (!this.document.connected && this.document.intent !== "connected") return;
		try {
			await Promise.race([
				new Promise<void>((resolve) => {
					provider.once("synced", () => resolve());
					// Double-check after registration
					if (provider.synced) resolve();
				}),
				new Promise<void>((resolve) => setTimeout(resolve, 5000)),
			]);
		} catch {
			// timeout or error — proceed with current Y.Text state
		}
	}

	async getKeyFrame(incremental = false): Promise<ChangeSpec[]> {
		// goal: sync editor state to ytext state so we can accept delta edits.
		if (!this.active(this.view) || this.destroyed) {
			return [];
		}

		if (this.document?.text === this.editor.state.doc.toString()) {
			// disk and ytext were already the same.
			if (isLiveMd(this.view)) {
				this.view.tracking = true;
			}
			return [];
		} else if (flags().enableDeltaLogging) {
			this.warn(
				`|${this.document?.text}|\n|${this.editor.state.doc.toString()}|`,
			);
		}

		if (!this.document) {
			this.warn("no document");
			return [];
		}

		this.warn(`ytext and editor buffer need syncing`);
		if (!this.document.hasLocalDB() && this.document.text === "") {
			this.warn("local db missing, not setting buffer");
			return [];
		}

		// disk and ytext differ
		if (isLiveMd(this.view) && !this.view.tracking) {
			void this.view.checkStale();
		} else if (this.document) {
			try {
				const stale = await this.document.checkStale();
				if (stale && !this.destroyed && this.editor) {
					this.mergeBanner();
				}
			} catch (e: unknown) {
				this.warn("[getKeyFrame] checkStale failed, relying on WS sync:", (e as Error).message);
			}
		}

		if (this.active(this.view) && !this.destroyed) {
			return [this.getBufferChange(this.document.text, incremental)];
		}
		return [];
	}

	update(update: ViewUpdate): void {
		// When updates were made to the local editor. Forwarded to the ydoc.
		if (
			!update.docChanged ||
			(update.transactions.length > 0 &&
				update.transactions[0].annotation(ySyncAnnotation) === this.editor) ||
			this.destroyed
		) {
			return;
		}
		this.document = this.getDocument();
		const ytext = this.document?.ytext;
		if (!ytext) {
			return;
		}
		try {
			ytext.doc?.transact(() => {
				/**
				 * This variable adjusts the fromA position to the current position in the Y.Text type.
				 */
				let adj = 0;
				update.changes.iterChanges((fromA, toA, fromB, toB, insert) => {
					const insertText = insert.sliceString(0, insert.length, "\n");
					if (fromA !== toA) {
						ytext.delete(fromA + adj, toA - fromA);
					}
					if (insertText.length > 0) {
						ytext.insert(fromA + adj, insertText);
					}
					adj += insertText.length - (toA - fromA);
				});
			}, this);
		} catch (e: unknown) {
			// Yjs internal error (e.g., ydoc destroyed while editor still active).
			// Skip Yjs update — local edit is preserved, sync resumes on reconnect.
			this.warn("[update] Yjs transact failed:", (e as Error).message);
		}

		if (this.embed && this.document) {
			this.document.requestSave();
		}
	}

	destroy() {
		this.destroyed = true;
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.unsubscribes.forEach((unsub) => {
			unsub();
		});
		this.unsubscribes.length = 0;
		this.viewHookPlugin?.destroy();
		// Remove class we may have added for SharedFolder documents
		if (this.embed && this.sourceView) {
			this.sourceView.classList.remove("relay-live-editor");
		}
		this.connectionManager = null as unknown as LiveViewManager | undefined;
		this.view = undefined;
		this._ytext = undefined;
		this.editor = null as unknown as EditorView;
	}
}

export const LiveEdit = ViewPlugin.fromClass(LiveCMPluginValue);
