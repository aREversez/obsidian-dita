# Roadmap

Where obsidian-dita is and where it is going. Read this and `README.md` before
starting work; update the checkboxes in the same change that finishes an item.

## Done

- [x] Monorepo: `packages/dita-core` (host-neutral parser, renderer, stylesheet,
      completion engine) and `packages/obsidian-plugin`. The core has since
      moved to the VS Code DITA Viewer repository (`packages/core`); this
      repository installs it from npm.
- [x] Theme-following preview (Shadow DOM + `obsidian-adapter.css`, contrast
      tested across theme archetypes).
- [x] Reading view / Source mode / side-by-side live preview, CodeMirror 6 XML
      editor, scroll and caret sync.
- [x] Selectable, copyable preview (Ctrl/Cmd+A, context menu).
- [x] Tag, attribute and value completion (keys, files, images, ids).
- [x] `.ditamap` outline view in the same three modes; click to open a topic.
- [x] Conditional processing: `.ditaval` and hand-picked profiling values in the
      preview, outline, site and book views (Phase 3 below).
- [x] Obsidian's Outline pane lists the headings of an open `.dita` / `.ditamap`
      and scrolls to them on click. Obsidian has no hook for this, so the
      plugin wraps `getHeadings`, `findCorrespondingLeaf` and
      `findActiveHeading` on the Outline view's prototype (`outlinePatch.ts`),
      guarded so that a changed Outline leaves it alone. Unit-tested against a
      stand-in view and checked against the source of the 1.5.12, 1.8.10,
      1.11.7 and 1.14.5 bundles. In a running Obsidian it lists the headings
      and scrolls on click. The row of the current heading is highlighted (the
      caret's with the source showing, the top of the preview in reading view;
      none in a map's reading view, site view or book view, which show no
      lines of the file); not yet tried in a running Obsidian.
- [x] Find in the preview (Ctrl/Cmd+F), in reading, split, site and book view.
- [x] Hover preview: Ctrl/Cmd over a link to another DITA file shows it in
      Obsidian's Page Preview popover, and `![[topic.dita]]` embeds a topic (a
      map shows its outline).

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
new (`src/profiling.ts` in the core), informed by `ditaval.ts`. One
difference to know about: the VS Code panel hides an element when *any* of its
values is unticked; this one follows DITA-OT (every value of one attribute).

- [x] `.ditaval` and profiling filters in the preview: filter panel, `.ditaval`
      picker, per-pane state, topicref-level filtering in site and book view.
- [x] Checked in Obsidian itself: the header button opens the panel with the
      right values, the picker finds a `.ditaval` the vault index does not list
      (`common/strict.ditaval` never appears in the file tree), and editing that
      file refreshes the preview on its own within a few seconds.

### Phase 4 — release

- [x] Version and `manifest.json` hygiene (one manifest at the repo root,
      `versions.json`, `npm run release:check`), release workflow that attaches
      `main.js`, `manifest.json`, `styles.css` (`.github/workflows/release.yml`).
      Tags `0.1.0` and `0.2.0` are pushed.
- [x] BRAT install and the desktop-only note are in the README.
- [x] README screenshot, and the community plugin directory's review findings
      except the two below.
- [ ] Trial through BRAT from a release tag.
- [ ] Community plugin directory: get the submission through review. Two
      findings stay open because fixing them needs Obsidian 1.13 and
      `minAppVersion` is 1.5.0: `getSettingDefinitions()` for the settings tab,
      and `setDynamicTooltip()` on the preview-delay slider (1.13 shows its
      value inline). Raising `minAppVersion` closes both.

### In parallel, later

- [x] Make the VS Code DITA Viewer depend on `@dita-viewer/core` instead of its
      own copies. Decided: publish the core to npm and depend on it by version.
      The core's source moved into the viewer's repository (`packages/core`,
      with its own README), so it is edited and released there.
  - [x] Move `openHrefTarget` out of `topicRender.ts` (upstream, then re-copied
        here; `vscode-stub.d.ts` removed).
  - [x] Re-point `media/styles.css` at the `--dita-*` host tokens, with the
        VS Code answers in one `:root` block at the top of that file (upstream;
        28 declarations, rendering unchanged). Not yet equal to
        `dita-content.css`, see the gaps below.
  - [x] Close the style gaps between the extension's `media/styles.css` and
        this package's stylesheet (upstream; ships with the next core release):
        (1) the core rules for `body` and `html.dv-*` also match `.dita-body`
        and `:host(.dv-*)`; (2) the image button, context menu and toast read
        finer tokens (`--dita-btn-*`, `--dita-menu-*`, `--dita-toast-*`) that
        fall back to the shared ones, so this plugin's adapter does not have to
        define them; (3) `--dita-border` and `--dita-selected-fg` are now read
        by the extension's rules too. The extension still keeps its own copy of
        the rules; a test there fails if the tokens the two read drift apart.
        `theme.test.ts` here treats the new tokens as optional.
  - [x] Make the package publishable: metadata, LICENSE, no source maps, the
        parser and renderer entry points the extension imports are exported,
        `npm run check:pack` installs the tarball into an empty project.
  - [x] Publish `@dita-viewer/core` to npm: 0.1.0 is out. It turned out to
        export too little; the extension now imports 107 distinct symbols from
        the copied modules (99 in `src`, 8 more only in tests) and 0.1.0 had 46
        of them.
  - [x] Publish 0.2.0, which exports the remaining 61 (`src/index.ts`, pinned
        by `test/publicApi.test.ts`).
  - [x] In the extension: depend on the package (pinned to 0.2.0), replace its
        imports of the copied modules, delete the copies, and adjust its
        build and tests.


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
- The core (`@dita-viewer/core`) is not in this repository. It is edited in the
  VS Code DITA Viewer repository (`packages/core`) and released there with a
  `core-<version>` tag. This repository pins a published version in
  `packages/obsidian-plugin/package.json`; to take a change, raise it, then run
  `npm install` and `npm run verify`.
- Colours come from Obsidian variables through `obsidian-adapter.css` only; no
  hard-coded colours, no `--vscode-*`.
- Before delivering: `npm run verify` (typecheck, all tests, bundle) must pass,
  and the patch must apply to a fresh clone of `dev` with `git am`.
- Anything the browser harness cannot show (real Obsidian behaviour) is listed
  as unverified in the patch notes, not claimed as working.
