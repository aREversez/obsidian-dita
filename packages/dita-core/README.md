# @dita-viewer/core

Host-neutral DITA parsing and HTML rendering, shared by the
[VS Code DITA Viewer](https://github.com/aREversez/VS-Code-DITA-Viewer) and
[obsidian-dita](https://github.com/aREversez/obsidian-dita).

## What is in it

| Path | Origin |
| --- | --- |
| `src/parser/`, `src/render/`, `src/editor/*.ts` | **Verbatim copies** of the same paths in the VS Code DITA Viewer, taken from `dev` at commit `596202d`, except `editor/topicRender.ts`, which is from the upstream change "move openHrefTarget out of topicRender" (it was identical before that, and the other files were checked identical to `dev` at `de5a237`). The 15 files in `parser/`, `render/` and `editor/` are exactly the transitive import closure of `renderTopicToHtml` and import nothing from `vscode`. |
| `src/language/ditaLanguageUtils.ts`, `src/language/referenceableFiles.ts` | **Verbatim copies** too (same commit): completion-context detection, tag-stack scanning, and the file walk behind `href` completion. Both are `vscode`-free. |
| `src/keyMapForDocument.ts`, `src/mapRender.ts`, `src/bookRender.ts`, `src/siteRender.ts`, `src/index.ts` | New here. The public API; the key-map lookup without the VS Code workspace features; `renderMapXml`, which sequences the copied map parser and renderer for a `.ditamap` outline; `renderBookXml` for the whole map on one page; and `renderSiteXml`, which renders one map topic at a time plus the sidebar manifest. |
| `src/profiling.ts` | New here. Conditional processing: read a `.ditaval`, read the profiling values of an element or of the renderer's `data-profile-keys`, decide whether an element stays (DITA-OT rules), list the values for a filter panel, and prune filtered entries from a parsed map. `renderBookXml` and `renderSiteXml` take it as `filter`. Informed by the VS Code viewer's `src/editor/ditaval.ts`, which only answers the exclusion question and is not a drop-in. |
| `src/index.ts` | New here. The public API. Besides the high-level `render*` functions it exports the parser and renderer entry points (`parseDita`, `parseDitamap`, `renderDocument`, ...) and the types they use, which is everything the VS Code viewer imports from the modules it copied; `test/publicApi.test.ts` pins that list. |
| `src/completion.ts`, `src/completionData.ts` | New here. Host-neutral completion engine (`complete(text, offset, env)`) and its tables: usual children per element (a ranking aid only, never a filter), enumerated attribute values, which attributes name files. |
| `styles/dita-content.css` | The topic-content, `.ditamap` outline-tree, and map page/site rules of the VS Code `media/styles.css`, with every `--vscode-*` replaced by a `--dita-*` host token. See the header comment for the complete list of differences. |
| `styles/TOKENS.md` | The contract between the stylesheet and a host. |
| `test/` | The upstream tests whose imports stay inside the 15 files (plus tests for completion, map rendering, book and site rendering), unchanged except for import paths. |

## Keeping it in sync

Do not edit the verbatim files here. Change them upstream, then copy them over
and run `npm test`. Because they are byte-identical, `diff -r` against the
upstream tree shows exactly what is out of date.

The intended end state is that the VS Code extension depends on this package
instead of holding its own copies. Two small upstream changes make that
possible. The first is done: `openHrefTarget` now lives in the extension's own
`editor/openHrefTarget.ts`, so `topicRender.ts` mentions no host and the
`vscode` type stand-in is gone. The second is done in part: the extension's
`media/styles.css` reads these `--dita-*` tokens in its content and outline
rules, answered from VS Code's theme in one `:root` block, with rendering
unchanged. It is not yet interchangeable with `styles/dita-content.css`; the
open differences (selectors, three colour families this package folds into one
token, two tokens nothing upstream reads yet) are listed in `ROADMAP.md`.

## Publishing to npm

The `@dita-viewer` scope must belong to the publisher: create an npm
organisation called `dita-viewer` (free for public packages), or rename the
package under a user scope in both repositories.

```
npm login                              # two-factor authentication is required
npm run verify
npm run check:pack                     # packs, installs the tarball into an empty project, requires it, type-checks it
cd packages/dita-core
npm version patch                      # or minor; keep it in step with what changed
npm publish                            # publishConfig makes it public; prepublishOnly builds first
```

A published version can never be reused, so run `check:pack` every time. Until
the host-token and selector gaps in `ROADMAP.md` are closed, keep the version at
`0.x`: the exported surface is allowed to change.
