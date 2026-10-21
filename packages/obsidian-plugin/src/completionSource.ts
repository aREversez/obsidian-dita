// Adapts the core completion engine to CodeMirror's autocompletion.

import { Completion, CompletionContext, CompletionResult, CompletionSource, startCompletion } from '@codemirror/autocomplete';
import { CompletionEnv, Suggestion, SuggestionKind, complete } from '@dita-viewer/core';

const TYPE: Record<SuggestionKind, string> = {
  tag: 'keyword',
  closeTag: 'keyword',
  attribute: 'property',
  value: 'constant',
  key: 'variable',
  file: 'text',
  id: 'variable',
};

function toCompletion(s: Suggestion): Completion {
  return {
    label: s.label,
    detail: s.detail,
    type: TYPE[s.kind],
    boost: s.boost,
    apply: (view, _c, from, to) => {
      view.dispatch({
        changes: { from, to, insert: s.insert },
        selection: { anchor: from + (s.cursor ?? s.insert.length) },
        userEvent: 'input.complete',
      });
      if (s.continueAfter) setTimeout(() => startCompletion(view), 0);
    },
  };
}

export function ditaCompletionSource(getEnv: () => CompletionEnv | undefined): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const env = getEnv();
    if (!env) return null;
    const r = await complete(ctx.state.doc.toString(), ctx.pos, env);
    if (!r || r.suggestions.length === 0) return null;
    return { from: r.from, options: r.suggestions.map(toCompletion), filter: true };
  };
}
