// Owned by the core area. Placeholder so the scaffold builds.
import { DEFAULT_CONVERT_OPTIONS, type ArticleDoc, type ConvertOptions } from '../shared/types';

export function convertMarkdown(markdown: string, options: Partial<ConvertOptions> = {}): ArticleDoc {
  void markdown;
  void { ...DEFAULT_CONVERT_OPTIONS, ...options };
  return { title: '', blocks: [], warnings: [], stats: { blocks: 0, images: 0, mermaid: 0, codeBlocks: 0, tables: 0, latex: 0, tweets: 0, characters: 0 } };
}
