import { writable } from "svelte/store";

export interface ToastMessage {
	message: string;
	details?: string;
	type?: "error" | "warning" | "info" | "success";
	visible: boolean;
	autoDismiss?: number;
	source?: "client" | "server";
}

// Global toast store
export const toastStore = writable<{ [key: string]: ToastMessage }>({});

export function showToast(
	key: string,
	message: string,
	details?: string,
	type: "error" | "warning" | "info" | "success" = "error",
	autoDismiss?: number,
	source: "client" | "server" = "client",
) {
	toastStore.update((toasts) => ({
		...toasts,
		[key]: {
			message,
			details,
			type,
			visible: true,
			autoDismiss: autoDismiss ?? 5000,
			source,
		},
	}));
}

export function hideToast(key: string) {
	toastStore.update((toasts) => ({
		...toasts,
		[key]: { ...toasts[key], visible: false },
	}));
}

/**
 * Show a server-driven toast message
 * Typically called when receiving error responses or server notifications
 */
export function showServerToast(
	key: string,
	message: string,
	details?: string,
	type: "error" | "warning" | "info" | "success" = "error",
	autoDismiss?: number,
) {
	showToast(key, message, details, type, autoDismiss, "server");
}

/** Structured server error with HTTP status and optional body */
interface ServerError {
	status?: number;
	message?: string;
	body?: {
		message?: string;
		details?: string;
	};
}

function toServerError(error: unknown): ServerError {
	if (typeof error === "object" && error !== null) {
		return error as ServerError;
	}
	return {};
}

/**
 * Parse server error response and show appropriate toast
 * Example: HTTP 403 with custom message from server
 */
export function handleServerError(
	error: unknown,
	fallbackMessage: string = "An error occurred",
) {
	const key = `server-error-${Date.now()}`;
	const err = toServerError(error);
	const status = err.status ?? 0;
	const errMessage = err.message ?? (error instanceof Error ? error.message : "");

	if (status === 403) {
		// Server sent permission denial
		const serverMessage = err.body?.message || errMessage || "Permission denied";
		const serverDetails = err.body?.details;
		showServerToast(key, serverMessage, serverDetails, "error", 7000);
	} else if (status >= 400 && status < 500) {
		// Client error with potential server message
		const serverMessage = err.body?.message || errMessage || fallbackMessage;
		showServerToast(key, serverMessage, undefined, "error", 5000);
	} else if (status >= 500) {
		// Server error
		showServerToast(key, "Server error occurred", errMessage, "error", 8000);
	} else {
		// Unknown error
		showServerToast(key, fallbackMessage, errMessage, "error", 5000);
	}
}
