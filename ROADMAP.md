# Roadmap

Where obsidian-dita is and where it is going. Read this and `README.md` before
starting work; update the checkboxes in the same change that finishes an item.

## Done

- [x] Monorepo: `packages/dita-core` (host-neutral parser, renderer, stylesheet,
      completion engine) and `packages/obsidian-plugin`.
- [x] Theme-following preview (Shadow DOM + `obsidian-adapter.css`, contrast
      tested across theme archetypes).
- [x] Reading view / Source mode / side-by-side live preview, CodeMirror 6 XML
      editor, scroll and caret sync.
- [x] Selectable, copyable preview (Ctrl/Cmd+A, context menu).
- [x] Tag, attribute and value completion (keys, files, images, ids).
- [x] `.ditamap` outline view in the same three modes; click to open a topic.
- [x] Conditional processing: `.ditaval` and hand-picked profiling values in the
      preview, outline, site and book views (Phase 3 below).

## Next

Ordered by value for day-to-day writing; each phase is a separate patch series.

### Phase 0 — check in real Obsidian

Done: the items below were checked in Obsidian itself, not only in the browser
harness with its mock of the Obsidian API.

- [x] Pane icons (`book-open`, `code`, `separator-vertical`), completion popup,
      context menu, outline click behave as intended.
- [x] Look at 2-3 real community themes (preview, outline, editor, popup) and
      record problems here.

### Phase 1 — editing

Checked in Obsidian itself: diagnostics underlines and gutter dots,
Ctrl/Cmd+click navigation, the conref badge, the wrap / insert commands and
the quick switcher.

- [x] Diagnostics underlines and gutter dots, Ctrl/Cmd+click navigation, the
      conref badge, the wrap / insert commands and the quick switcher.

1. [x] Diagnostics in the source editor: XML well-formedness with line
       positions; `href` / `conref` / `keyref` pointing at nothing; duplicate ids.
2. [x] Ctrl/Cmd+click in the source on `href`, `conref`, `keyref` opens the target.
3. [x] Preview: conref "jump to source" (the reuse badge on conref'd content).
4. [x] Commands: wrap the selection (`<b>`, `<codeph>`, ...), insert common
       structures (step, note, table skeleton).
5. [x] Quick switcher entry for `.dita` / `.ditamap` files.

### Phase 2 — maps

1. [x] Outline context menu (open, reveal in source).
2. [x] Book view (whole map merged into one page).
3. [x] Site view: one topic per page with a map sidebar, previous/next, and
       cross-page topic links.

### Phase 3 — conditional processing

Reuse check against the VS Code viewer (`dev`, `3b5e31a`): the renderer
already stamps `data-profile-keys` and the stylesheet already has
`.profile-filtered-out`, so both came for free. `src/editor/ditaval.ts` is the
closest piece but only answers "is this excluded" for its completeness check,
and the filter panel is an inline webview script built on `--vscode-*` and the
extension's toolbar, so neither moves into core unchanged. The engine here is
new (`packages/dita-core/src/profiling.ts`), informed by `ditaval.ts`. One
difference to know about: the VS Code panel hides an element when *any* of its
values is unticked; this one follows DITA-OT (every value of one attribute).

- [x] `.ditaval` and profiling filters in the preview: filter panel, `.ditaval`
      picker, per-pane state, topicref-level filtering in site and book view.
- [ ] Check in Obsidian itself (not done yet, see the patch notes): the header
      button and panel, the picker finding a `.ditaval` the vault index may not
      list, and that editing the `.ditaval` refreshes the preview.

### Phase 4 — release

- [x] Version and `manifest.json` hygiene (one manifest at the repo root,
      `versions.json`, `npm run release:check`), release workflow that attaches
      `main.js`, `manifest.json`, `styles.css` (`.github/workflows/release.yml`).
      The workflow has not run yet: it needs a first tag pushed to GitHub.
- [x] BRAT install and the desktop-only note are in the README.
- [ ] Trial through BRAT with a first tag (`0.1.0`), then consider the community
      plugin directory (needs screenshots; its review also reads the README).

### In parallel, later

- [ ] Make the VS Code DITA Viewer depend on `@dita-viewer/core` instead of its
      own copies (two small upstream changes, listed in
      `packages/dita-core/README.md`). Decided: publish the core to npm and
      depend on it by version.
  - [x] Move `openHrefTarget` out of `topicRender.ts` (upstream, then re-copied
        here; `vscode-stub.d.ts` removed).
  - [x] Re-point `media/styles.css` at the `--dita-*` host tokens, with the
        VS Code answers in one `:root` block at the top of that file (upstream;
        28 declarations, rendering unchanged). Not yet equal to
        `dita-content.css`, see the gaps below.
  - [ ] Close the style gaps before the extension takes its content rules from
        this package: (1) selectors: upstream styles `body`, `:root`, `html.dv-*`,
        this package `.dita-body` and `:host`, so VS Code needs the `dita-body`
        class on its body (or the core rules need an alias for both); (2) the 11
        declarations behind the image button, context menu and toast
        (`dropdown-*`, `menu-*`, `notifications-*`) are still `--vscode-*`
        upstream because this package folds them into `--dita-bg-elevated` and
        friends; decide whether VS Code accepts the merged colours or the core
        gets finer tokens; (3) `--dita-border` and `--dita-selected-fg` are
        defined upstream but no shared rule there reads them yet.
  - [ ] Publish `@dita-viewer/core` to npm, then replace the extension's 118
        imports of the copied modules and delete its copies.

## Out of scope for now

- DITA-OT publishing (needs Java; far from the Obsidian workflow).
- Git compare (Obsidian has its own Git plugins).
- Mobile (the core reads files through Node; the plugin is `isDesktopOnly`).

## Working rules

- Work on the `dev` branch. Deliver changes as one git-format patch
  (`git format-patch --stdout origin/dev..HEAD`) with commit messages.
- Commit messages carry no co-author, session or tool trailers, and no mention
  of the tool that wrote the change.
- Prefer small, surgical edits that keep existing wording and structure.
- The verbatim files in `packages/dita-core` (`src/parser/`, `src/render/`,
  `src/editor/*.ts`, `src/language/*.ts`) are copies of the VS Code DITA Viewer
  at `596202d`. Do not edit them here: change upstream, re-copy, run the tests.
- Colours come from Obsidian variables through `obsidian-adapter.css` only; no
  hard-coded colours, no `--vscode-*`.
- Before delivering: `npm run verify` (typecheck, all tests, bundle) must pass,
  and the patch must apply to a fresh clone of `dev` with `git am`.
- Anything the browser harness cannot show (real Obsidian behaviour) is listed
  as unverified in the patch notes, not claimed as working.
