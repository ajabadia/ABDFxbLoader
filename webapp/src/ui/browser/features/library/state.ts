import type { LibraryScanResponse } from '../../../../client/fxb-client.js';
import { readStorage } from '../../shared/utils/storage.js';
import { STORAGE_ROOT } from '../../../storage-keys.js';

export type ScanPlugin = LibraryScanResponse['plugins'][number];

export let libraryRoot = readStorage(STORAGE_ROOT);
export let rootRemembered = libraryRoot !== '';

/** Último resultado de `/library/scan`, o `null` si aún no hay lista. */
export let scanData: LibraryScanResponse | null = null;

export function setLibraryRoot(value: string): void {
  libraryRoot = value;
  rootRemembered = value !== '';
}

export function setScanData(data: LibraryScanResponse | null): void {
  scanData = data;
}
