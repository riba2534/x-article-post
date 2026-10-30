// Owned by the ui area. Placeholder so the scaffold builds.
import type { ArticleDoc, ConvertOptions, WriteProgress, WriteRequest, WriteTarget } from '../shared/types';

export interface PrepareResult {
  doc: ArticleDoc;
  request: WriteRequest;
}

export async function prepareWrite(
  markdown: string,
  options: Partial<ConvertOptions>,
  target: WriteTarget,
  onProgress?: (p: WriteProgress) => void,
  titleOverride?: string,
): Promise<PrepareResult> {
  void markdown; void options; void onProgress; void titleOverride;
  throw new Error(`not implemented for ${target.type}`);
}
