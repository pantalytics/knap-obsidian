import * as Y from "yjs";
import { curryLog } from "./debug";
import { diff_match_patch, type Diff } from "diff-match-patch";
import { flags } from "./flagManager";

export function diffMatchPatch(
	ydoc: Y.Doc,
	diskBuffer: string,
	origin?: unknown,
): void {
	// Get the YText from the YDoc
	const ytext = ydoc.getText("contents");

	// Get the current content of the YText
	const currentContent = ytext.toJSON();

	// Create a new diff_match_patch object
	const dmp = new diff_match_patch();

	// Compute the diff between the current content and the disk buffer
	const diffs: Diff[] = dmp.diff_main(currentContent, diskBuffer);

	// Optimize the diff
	dmp.diff_cleanupSemantic(diffs);

	// Initialize the cursor position
	let cursor = 0;

	const log = flags().enableDeltaLogging
		? curryLog("[diffMatchPatch]", "debug")
		: (...args: unknown[]) => {};

	// Log the overall change
	log("Updating YDoc:");
	log("Current content length:", currentContent.length);
	log("Disk buffer length:", diskBuffer.length);

	if (diffs.length == 0) {
		return;
	}

	// Apply the diffs as updates to the YDoc
	ydoc.transact(() => {
		for (const [operation, text] of diffs) {
			switch (operation) {
				case 1: // Insert
					log(`Inserting "${text}" at position ${cursor}`);
					ytext.insert(cursor, text);
					cursor += text.length;
					break;
				case 0: // Equal
					log(`Keeping "${text}" (length: ${text.length})`);
					cursor += text.length;
					break;
				case -1: // Delete
					log(`Deleting "${text}" at position ${cursor}`);
					ytext.delete(cursor, text.length);
					break;
			}
			log("intermediate", ytext.toJSON());
		}
	}, origin);

	log("result", ytext.toJSON());

	// Log the final state
	log("Update complete. New content length:", ytext.toJSON().length);
}

/**
 * Persists `content` somewhere the user can find it and returns the path it
 * was written to. Injected by the caller so this module stays independent of
 * the vault/file API (and directly unit-testable without mocking it).
 */
export type ConflictCopyWriter = (content: string) => Promise<string>;

export interface ReconcileResult {
	/** True if the Y.Doc was rewritten to match `vaultContent`. */
	reconciled: boolean;
	/** Path the pre-reconciliation content was preserved at, if it diverged. */
	conflictPath?: string;
}

/**
 * Reconcile a Y.Doc's "contents" text to match `vaultContent`, WITHOUT
 * silently discarding whatever the Y.Doc currently holds (TR-01, #814d6d9b).
 *
 * `diffMatchPatch` computes a plain-text diff against whatever is CURRENTLY
 * in the Y.Doc and applies it as real delete/insert CRDT ops — indistinguishable
 * from any other edit once broadcast, and unrecoverable after GC. If the Y.Doc's
 * content differs from `vaultContent` at all, the losing (pre-reconciliation)
 * content is preserved via `writeConflictCopy` FIRST. If that write fails, the
 * reconciliation is skipped entirely (fail closed) rather than risk a silent loss.
 */
export async function reconcileWithConflictCopy(
	ydoc: Y.Doc,
	vaultContent: string,
	writeConflictCopy: ConflictCopyWriter,
	origin?: unknown,
	log: (...args: unknown[]) => void = () => {},
): Promise<ReconcileResult> {
	const ytext = ydoc.getText("contents");
	const currentContent = ytext.toJSON();

	if (currentContent === vaultContent) {
		return { reconciled: false };
	}

	let conflictPath: string;
	try {
		conflictPath = await writeConflictCopy(currentContent);
	} catch (e) {
		log(
			"Failed to write conflict copy — skipping reconciliation to avoid silent data loss:",
			e,
		);
		return { reconciled: false };
	}

	diffMatchPatch(ydoc, vaultContent, origin);
	return { reconciled: true, conflictPath };
}
