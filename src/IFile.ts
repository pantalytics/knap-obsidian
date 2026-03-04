import type { SharedFolder } from "./SharedFolder";

export interface IFile {
	guid: string;
	path: string;
	move: (newPath: string, sharedFolder: SharedFolder) => void;
	connect: () => Promise<boolean> | void;
	disconnect: () => void;
	cleanup: () => Promise<void> | void;
	destroy: () => void;
}

export interface HasMimeType {
	mimetype: string;
}
