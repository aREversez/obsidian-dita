# obsidian-dita

Read and edit DITA topics and maps in Obsidian. `.dita` files open in a
formatted reading view and `.ditamap` files in an outline tree, as a small
site with one topic per page, or as a whole book; all take their colours, fonts
and heading style from whichever theme you use.

Built on [`@dita-viewer/core`](packages/dita-core), the same rendering engine as
the [VS Code DITA Viewer](https://github.com/aREversez/VS-Code-DITA-Viewer).

## Status

**Preview and editing** of `.dita` topics and `.ditamap` maps, desktop only.

Works: all topic types and specializations the core renders, `keyref` /
`conkeyref` against the ditamap near the topic, `conref` / `conrefend`
(including content from other files, and re-render when those change), images
inside the vault, MathML, links between topics, light and dark themes, and
editing the XML source with view modes (below), tag / attribute / value
completion in the editor, source diagnostics (well-formedness, references to
nothing, duplicate ids), Ctrl/Cmd+click on a reference to open its target,
conref "jump to source" in the preview, wrap and insert commands, the
`.ditamap` outline, site and book views (below), and a quick switcher for
`.dita` / `.ditamap` files.

Not yet: profiling filters, Git compare, DITA-OT. Mobile is not supported
because the core reads files through Node.

## View modes

A `.dita` file opens in one of three modes, like a Markdown note; a `.ditamap`
has two more. Use the button in the pane header, the pane's "more options"
menu, or a command:

| Mode | What you see |
| --- | --- |
| **Reading view** | The formatted topic, or the map outline. |
| **Source mode** | The XML in an editor: syntax highlighting, line numbers, auto-closing tags and quotes, search, undo history. |
| **Live preview (side by side)** | Source on the left, preview on the right. The preview updates shortly after you stop typing and keeps the last good render while the XML is invalid (an error bar says what is wrong). Scrolling or moving the caret in the source scrolls the preview to the same place; clicking an element in the preview puts the caret on its source. |
| **Site view** (maps only) | One topic per page with a sidebar of the whole map. The sidebar shows nested topicheads and bookmap division labels; click a row, or use the previous/next buttons in the pane header, to change page. A cross-topic `xref` to another topic in the map switches to that page and scrolls to the target. Right-click the page to reveal its topic's source at the clicked line. |
| **Book view** (maps only) | Every topic the map references, in map order, merged into one reading page with its bookmap chapter/appendix labels. A cross-topic `xref` to another topic in the same book scrolls to that section instead of opening a file. Right-click a section to reveal that topic's source at the clicked line. |

Commands (all under "DITA Viewer:"): *Reading view*, *Source mode*, *Live
preview (side by side)*, *Site view* (on a map), *Book view* (on a map),
*Toggle reading view and source mode*, *Wrap selection in an element*, *Insert
a structure*, and *Quick switch to a DITA file*. No hotkeys are assigned; set
your own under Settings → Hotkeys. Settings has the default mode for newly
opened files and the live-preview delay. Each pane remembers the mode you last
chose for it.

In the source, Ctrl/Cmd+click an `href`, `conref` or `keyref` to open the file
or key it names; in the preview, click the reuse badge on conref'd content to
show where it comes from. Diagnostics underline XML errors, references that
point at nothing and duplicate ids, with the message on hover and a dot in the
line-number gutter. A reference is re-checked when the file or key map it
depends on changes on disk, so fixing the target clears the warning without
reopening the document.

Edits are saved by Obsidian as for any text file, and a change to the file on
disk is merged into the open editor without moving your caret.

## Completion

In the source editor, completion pops up as you type:

- after `<`: elements, with the usual children of the enclosing element first
  (`<ul><` offers `li`; `<steps><` offers `step`); every other element is still
  there. After `</` it offers the element to close. In a `.ditamap` the map
  vocabulary is used.
- inside a tag: attributes that are not already written. Picking one inserts
  `name=""` with the caret between the quotes, and opens the value list where
  there is one.
- inside a value: enumerated values (`note type`, `scope`, `processing-role`, …),
  keys from the map for `keyref` / `conkeyref`, topics and maps for `href` /
  `conref`, images for `<image href>`, and element ids after `#`. Files are
  searched below the document's folder, three levels deep, never outside the
  vault.

## Map outline

A `.ditamap` opens in the same modes, plus **Site view** and **Book view**
(both described above: one topic per page with a sidebar, or the whole map
merged into one page). Reading view shows the outline tree: navtitles (or the
file name when the map does not name an entry), bookmap division badges
(`第 1 章` / `Chapter 1`, following the Obsidian language), nested submaps,
key definitions and reltables. Click an entry to open its topic; Ctrl/Cmd-click
opens it in a new tab. Right-click an entry for *Open* and *Reveal in source*:
the source opens beside the preview, so the outline stays in view, with the
caret on that `topicref` in the map. An entry pulled in from a referenced
submap has no line in this map, so it opens that topic's own source instead.
After a reveal, a Back button appears in the pane header, and the right-click
menu offers *Back to Reading view*, *Back to Site view* or *Back to Book view*
to return where you were. The outline re-renders when a referenced submap
changes. Side by side, the outline follows your typing; clicking in it does not
move the source caret.

## Install (manual)

```
npm install
npm run build
```

Copy `packages/obsidian-plugin/dist/{main.js,manifest.json,styles.css}` into
`<vault>/.obsidian/plugins/dita-viewer/`, then enable **DITA Viewer** under
Settings → Community plugins.

## How it follows your theme

Community themes restyle almost everything, so the preview is built so that a
theme can influence it only in ways it is meant to.

1. **Shadow DOM isolation.** The topic renders inside a shadow root. Theme
   selectors (`.markdown-rendered table`, bare `code`, `a`, `blockquote`, a
   snippet that styles `.view-content *`) cannot reach in, so tables, code
   blocks and callouts keep their structure in every theme.
2. **Variables pass through.** Obsidian defines its design variables on
   `<body>`; custom properties inherit across the shadow boundary. The adapter
   ([`obsidian-adapter.css`](packages/obsidian-plugin/src/theme/obsidian-adapter.css))
   is the only file that knows Obsidian's variable names. It maps them to the
   core's 12 host tokens ([`TOKENS.md`](packages/dita-core/styles/TOKENS.md)):
   text, background, border, link and code colours, body font, font size,
   line height, readable line width, and the theme's heading sizes, weights,
   fonts and colours.
3. **The source editor follows the theme too.** Its colours are Obsidian's
   own variables (`--code-tag`, `--code-property`, `--code-string`,
   `--code-comment`, `--text-selection`, `--font-monospace`, …); none is written
   into the plugin.
4. **Derived, not hard-coded, colours.** Note/warning/danger/tip panels, the
   conditional-processing highlight and index chips are `color-mix()` of the
   theme's own palette against its own background. They are therefore right in
   light and dark, and in themes nobody tested.
5. **Contrast is tested.** `test/theme.test.ts` resolves the adapter against
   nine theme archetypes (default light/dark, warm paper, Solarized, AMOLED
   black, neon, pastel, high contrast) and checks that body text stays at WCAG
   AA on every derived background, and that no `--vscode-*` leaks into either
   stylesheet.
6. **You can override anything.** Outer CSS wins over the shadow root's
   `:host` rules, so a snippet needs no specificity tricks:

   ```css
   .dita-view {
     --dita-link: #c2410c;
     --dita-note-bg: #eef3ff;
     --dita-max-width: 60rem;
   }
   ```

   Hooks: every `--dita-*` host token, `--dita-max-width`, and
   `--dita-{note,warning,danger,important,tip}-{bg,border}`.

The archetypes are *shapes* of themes, not copies of real ones; checking a
specific theme (Minimal, Things, AnuPpuccin, Sanctum, …) still needs a look in
Obsidian itself.

See [ROADMAP.md](ROADMAP.md) for what is planned next and the working rules.

## Layout

```
packages/dita-core        host-neutral parser + renderer + stylesheet (shared)
packages/obsidian-plugin  the Obsidian plugin: view, theme adapter, build
```

## Development

```
npm run verify      # typecheck, all tests, bundle
npm run watch -w obsidian-dita
```

`npm run build` also copies the bundle into the local test vault at
`test-dita-file/.obsidian/plugins/dita-viewer` when that folder exists; the
watch command does the same after each successful rebuild. Use `npm run
sync:test` to copy the current bundle without rebuilding, or set
`DITA_TEST_VAULT_PLUGIN` to a different plugin folder.

## Sample document

[`test-dita-file/`](test-dita-file/) is a DITA 1.3 bookmap fixture for trying
Site and Book view: topics, tasks, concepts, references, troubleshooting,
glossaries, a Learning specialization, keys and key scopes,
`conref`/`conkeyref`/`conrefend`, a ditaval, imagemaps, hazard statements and
MathML. Open `test-dita-file/complex-book.ditamap`, or see
[`test-dita-file/README.md`](test-dita-file/README.md) for the topic list and
validation commands.

## License

MIT
