# @dita-viewer/core

Host-neutral DITA parsing and HTML rendering, shared by the
[VS Code DITA Viewer](https://github.com/aREversez/VS-Code-DITA-Viewer) and
[obsidian-dita](https://github.com/aREversez/obsidian-dita).

## What is in it

| Path | Origin |
| --- | --- |
| `src/parser/`, `src/render/`, `src/editor/*.ts` | **Verbatim copies** of the same paths in the VS Code DITA Viewer, taken from `dev` at commit `596202d`. These 15 files are exactly the transitive import closure of `renderTopicToHtml` and import nothing from `vscode`. |
| `src/keyMapForDocument.ts`, `src/index.ts` | New here. The public API, and the key-map lookup without the VS Code workspace features. |
| `src/vscode-stub.d.ts` | Type-only stand-in so the one host-specific function in `topicRender.ts` (`openHrefTarget`) compiles. |
| `styles/dita-content.css` | The topic-content rules of the VS Code `media/styles.css`, with every `--vscode-*` replaced by a `--dita-*` host token. See the header comment for the complete list of differences. |
| `styles/TOKENS.md` | The contract between the stylesheet and a host. |
| `test/` | The upstream tests whose imports stay inside the 15 files (268 tests), unchanged except for import paths. |

## Keeping it in sync

Do not edit the verbatim files here. Change them upstream, then copy them over
and run `npm test`. Because they are byte-identical, `diff -r` against the
upstream tree shows exactly what is out of date.

The intended end state is that the VS Code extension depends on this package
instead of holding its own copies. Two small upstream changes make that
possible: move `openHrefTarget` out of `topicRender.ts` (then
`vscode-stub.d.ts` can go), and re-point `media/styles.css` at the host tokens
with a small VS Code adapter sheet.
