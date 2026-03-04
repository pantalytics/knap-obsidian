import { around } from "monkey-around";
import { HasLogging } from "./debug";

// Extend window interface to include our debugging property
declare global {
	interface Window {
		evcTeamRelayPatches?: Array<() => void>;
	}
}

/**
 * Singleton manager for all monkeypatches in the plugin.
 * Ensures proper cleanup during plugin unload/reload.
 */
export class Patcher extends HasLogging {
	private static instance: Patcher | null = null;
	private unsubscribes: Array<() => void> = [];
	private patchedMethods = new WeakMap<object, Set<string>>();

	private constructor() {
		super("Patcher");
		// Initialize window.evcTeamRelayPatches for debugging
		if (typeof window !== "undefined") {
			if (window.evcTeamRelayPatches && window.evcTeamRelayPatches.length > 0) {
				console.warn(`Found ${window.evcTeamRelayPatches.length} existing unsubscribers on window.evcTeamRelayPatches at startup - possible memory leak or incomplete cleanup`);
			}
			window.evcTeamRelayPatches = [];
		}
	}

	/**
	 * Get the singleton instance
	 */
	static getInstance(): Patcher {
		if (!Patcher.instance) {
			Patcher.instance = new Patcher();
		}
		return Patcher.instance;
	}

	/**
	 * Create a monkeypatch and register its cleanup function
	 * Prevents duplicate patches of the same method on the same instance
	 */
	patch<T extends object>(target: T, patches: Record<string, object>): () => void {
		const existingMethods = this.patchedMethods.get(target) || new Set();
		const requestedMethods = Object.keys(patches);

		// Check for method conflicts
		const conflicts = requestedMethods.filter(method => existingMethods.has(method));

		if (conflicts.length > 0) {
			this.warn(`Methods [${conflicts.join(', ')}] already patched on ${(target as { constructor?: { name?: string } }).constructor?.name}, skipping duplicates`);

			// Only patch non-conflicting methods
			const safePatch: Record<string, object> = {};
			requestedMethods
				.filter(method => !conflicts.includes(method))
				.forEach(method => { safePatch[method] = patches[method]; });

			if (Object.keys(safePatch).length === 0) {
				this.debug("All methods conflicted, returning no-op unsubscriber");
				return () => {}; // No-op if all methods conflict
			}
			patches = safePatch;
		}

		// Update method tracking
		const newMethodSet = new Set([...existingMethods, ...Object.keys(patches)]);
		this.patchedMethods.set(target, newMethodSet);

		// Apply patch using type assertion required for monkey-around's generic constraint
		const unsubscribe = around(target as unknown as Record<string, object>, patches as Parameters<typeof around>[1]);
		this.unsubscribes.push(unsubscribe);

		// Also store on window for debugging
		if (typeof window !== "undefined" && window.evcTeamRelayPatches) {
			window.evcTeamRelayPatches.push(unsubscribe);
		}
		
		this.debug("Applied monkeypatch", {
			target: (target as { constructor?: { name?: string } }).constructor?.name,
			methods: Object.keys(patches),
			patchCount: this.unsubscribes.length 
		});
		
		// Return enhanced unsubscriber that cleans up method tracking
		const enhancedUnsubscribe = () => {
			// Remove from method tracking
			Object.keys(patches).forEach(method => newMethodSet.delete(method));
			if (newMethodSet.size === 0) {
				this.patchedMethods.delete(target);
			}
			
			// Remove from global tracking
			const index = this.unsubscribes.indexOf(unsubscribe);
			if (index >= 0) this.unsubscribes.splice(index, 1);
			
			// Remove from window debugging
			if (typeof window !== "undefined" && window.evcTeamRelayPatches) {
				const windowIndex = window.evcTeamRelayPatches.indexOf(unsubscribe);
				if (windowIndex >= 0) window.evcTeamRelayPatches.splice(windowIndex, 1);
			}
			
			unsubscribe();
		};
		
		return enhancedUnsubscribe;
	}

	/**
	 * Get the total number of registered cleanups
	 */
	getCount(): number {
		return this.unsubscribes.length;
	}

	/**
	 * Cleanup all registered monkeypatches and resources
	 * Called during plugin unload
	 */
	private cleanup(): void {
		const count = this.unsubscribes.length;
		this.debug("Starting cleanup of monkeypatches", { count });
		
		this.unsubscribes.forEach((unsubscribe, index) => {
			try {
				unsubscribe();
				this.debug("Cleaned up monkeypatch", { index: index + 1, total: count });
			} catch (error: unknown) {
				this.error("Error during monkeypatch cleanup", { index: index + 1, error });
			}
		});
		this.unsubscribes.length = 0;

		// Clear window.evcTeamRelayPatches as well
		if (typeof window !== "undefined" && window.evcTeamRelayPatches) {
			window.evcTeamRelayPatches.length = 0;
		}
		
		this.log("Completed cleanup of monkeypatches", { cleanedCount: count });
	}

	/**
	 * Destroy the singleton instance and cleanup all monkeypatches
	 * Follows the repo's standard destroy() pattern
	 */
	static destroy(): void {
		if (Patcher.instance) {
			Patcher.instance.cleanup();
			Patcher.instance = null;
		}
		// Clear window.evcTeamRelayPatches even if instance is null
		if (typeof window !== "undefined" && window.evcTeamRelayPatches) {
			window.evcTeamRelayPatches.length = 0;
		}
	}

	/**
	 * Check if any monkeypatches are currently registered
	 */
	hasRegisteredPatches(): boolean {
		return this.unsubscribes.length > 0;
	}
}

/**
 * Convenience function to get the singleton instance
 */
export const getPatcher = (): Patcher => Patcher.getInstance();
