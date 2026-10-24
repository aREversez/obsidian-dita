# @dita-viewer/core

Host-neutral DITA parsing and HTML rendering, shared by the
[VS Code DITA Viewer](https://github.com/aREversez/VS-Code-DITA-Viewer) and
[obsidian-dita](https://github.com/aREversez/obsidian-dita).

## What is in it

| Path | Origin |
| --- | --- |
| `src/parser/`, `src/render/`, `src/editor/*.ts` | **Copied** from the same paths in the VS Code DITA Viewer, taken from `dev` at commit `596202d` and byte-identical when the viewer switched to this package; they are edited here now. Except `editor/topicRender.ts`, which is from the upstream change "move openHrefTarget out of topicRender" (it was identical before that, and the other files were checked identical to `dev` at `de5a237`). The 15 files in `parser/`, `render/` and `editor/` are exactly the transitive import closure of `renderTopicToHtml` and import nothing from `vscode`. |
| `src/language/ditaLanguageUtils.ts`, `src/language/referenceableFiles.ts` | **Copied** too (same commit, and edited here now): completion-context detection, tag-stack scanning, and the file walk behind `href` completion. Both are `vscode`-free. |
| `src/keyMapForDocument.ts`, `src/mapRender.ts`, `src/bookRender.ts`, `src/siteRender.ts`, `src/index.ts` | New here. The public API; the key-map lookup without the VS Code workspace features; `renderMapXml`, which sequences the copied map parser and renderer for a `.ditamap` outline; `renderBookXml` for the whole map on one page; and `renderSiteXml`, which renders one map topic at a time plus the sidebar manifest. |
| `src/profiling.ts` | New here. Conditional processing: read a `.ditaval`, read the profiling values of an element or of the renderer's `data-profile-keys`, decide whether an element stays (DITA-OT rules), list the values for a filter panel, and prune filtered entries from a parsed map. `renderBookXml` and `renderSiteXml` take it as `filter`. Informed by the VS Code viewer's `src/editor/ditaval.ts`, which only answers the exclusion question and is not a drop-in. |
| `src/index.ts` | New here. The public API. Besides the high-level `render*` functions it exports the parser and renderer entry points (`parseDita`, `parseDitamap`, `renderDocument`, ...) and the types they use, which is everything the VS Code viewer imports from the modules it copied; `test/publicApi.test.ts` pins that list. |
| `src/completion.ts`, `src/completionData.ts` | New here. Host-neutral completion engine (`complete(text, offset, env)`) and its tables: usual children per element (a ranking aid only, never a filter), enumerated attribute values, which attributes name files. |
| `styles/dita-content.css` | The topic-content, `.ditamap` outline-tree, and map page/site rules of the VS Code `media/styles.css`, with every `--vscode-*` replaced by a `--dita-*` host token. See the header comment for the complete list of differences. |
| `styles/TOKENS.md` | The contract between the stylesheet and a host. |
| `test/` | The upstream tests whose imports stay inside the 15 files (plus tests for completion, map rendering, book and site rendering), unchanged except for import paths. |

## Changing the shared files

The VS Code extension depends on this package (from 0.2.0) and no longer holds
copies of the parser, renderer and language files, so this is the one place
they are edited. A change to them:

1. is made here, with `npm run verify` passing;
2. is released as a new version of this package (see below);
3. reaches the extension when its `@dita-viewer/core` dependency is raised and
   its own `npm run verify` passes. The extension pins an exact version, so it
   never changes by itself.

While the version is 0.x the exported surface may change; the extension's
imports are what `test/publicApi.test.ts` pins.

What is not shared yet is the stylesheet. The extension's `media/styles.css`
reads these `--dita-*` tokens in its content and outline rules, answered from
VS Code's theme in one `:root` block, with rendering unchanged, but it is not
yet interchangeable with `styles/dita-content.css`; the open differences
(selectors, three colour families this package folds into one token, two
tokens nothing in the extension reads yet) are listed in `ROADMAP.md`.

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

A published version can never be reused, so run `check:pack` every time. The
plugin depends on the core as `*`: an exact version would stop matching the
workspace after the first bump, and npm would then install the published copy
next to it, so `verify` would test the plugin against old code. Until
the host-token and selector gaps in `ROADMAP.md` are closed, keep the version at
`0.x`: the exported surface is allowed to change.
