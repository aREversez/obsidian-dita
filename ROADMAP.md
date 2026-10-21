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

## Next

Ordered by value for day-to-day writing; each phase is a separate patch series.

### Phase 0 — check in real Obsidian (needs the maintainer)

Everything so far is verified in a browser harness with a mock of the Obsidian
API, not in Obsidian itself.

- [ ] Pane icons (`book-open`, `code`, `separator-vertical`), completion popup,
      context menu, outline click behave as intended.
- [ ] Look at 2-3 real community themes (preview, outline, editor, popup) and
      record problems here.

### Phase 1 — editing

1. [ ] Diagnostics in the source editor: XML well-formedness with line
       positions; `href` / `conref` / `keyref` pointing at nothing; duplicate ids.
2. [ ] Ctrl/Cmd+click in the source on `href`, `conref`, `keyref` opens the target.
3. [ ] Preview: conref "jump to source" (currently `markConrefs: false`).
4. [ ] Commands: wrap the selection (`<b>`, `<codeph>`, ...), insert common
       structures (step, note, table skeleton).
5. [ ] Quick switcher entry for `.dita` / `.ditamap` files.

### Phase 2 — maps

1. [ ] Outline context menu (open, reveal in source).
2. [ ] Book view (whole map merged into one page).
3. [ ] Site view: only after book view is stable, and only if wanted.

### Phase 3 — conditional processing

- [ ] `.ditaval` and profiling filters in the preview. First check which parts
      of the VS Code implementation can move into core unchanged.

### Phase 4 — release

- [ ] Version and `manifest.json` hygiene, release workflow that attaches
      `main.js`, `manifest.json`, `styles.css`.
- [ ] Trial through BRAT, then consider the community plugin directory
      (screenshots, desktop-only note in the README).

### In parallel, later

- [ ] Make the VS Code DITA Viewer depend on `@dita-viewer/core` instead of its
      own copies (two small upstream changes, listed in
      `packages/dita-core/README.md`). Start after Phase 1 so two repositories
      are not changing at once.

## Out of scope for now

- DITA-OT publishing (needs Java; far from the Obsidian workflow).
- Git compare (Obsidian has its own Git plugins).
- Mobile (the core reads files through Node; the plugin is `isDesktopOnly`).

## Working rules

- Work on the `dev` branch. Deliver changes as one git-format patch
  (`git format-patch --stdout origin/dev..HEAD`) with commit messages.
- Author and committer: `aREversez <53844261+aREversez@users.noreply.github.com>`.
  Commit messages carry no co-author, session or tool trailers, and no mention
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
