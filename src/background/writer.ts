// Owned by the writer area. Placeholder so the scaffold builds.
import type { ExtensionStatus, WriteProgress, WriteRequest, WriteResult } from '../shared/types';

export function initWriter(): void {}

export function isBusy(): boolean {
  return false;
}

export async function getXTabStatus(): Promise<ExtensionStatus['xTab']> {
  return null;
}

export async function runWrite(request: WriteRequest, _onProgress: (p: WriteProgress) => void): Promise<WriteResult> {
  return { ok: false, runId: request.runId, blocksWritten: 0, imagesOk: 0, imagesFailed: [], titleSet: false, coverSet: false, warnings: [], error: 'not implemented' };
}
