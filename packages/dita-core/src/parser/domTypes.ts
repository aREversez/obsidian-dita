export interface SourceRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface DitaNode {
  type: 'element' | 'text';
  tagName?: string;
  classTokens?: string[];
  baseType?: string;
  attributes?: Record<string, string>;
  children: DitaNode[];
  text?: string;
  sourceRange: SourceRange;
}

export interface DitaDocument {
  root: DitaNode;
  sourceRange: SourceRange;
}
