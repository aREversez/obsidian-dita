# obsidian-dita

Read DITA topics in Obsidian. `.dita` files open in a formatted reading view
that takes its colours, fonts and heading style from whichever theme you use.

Built on [`@dita-viewer/core`](packages/dita-core), the same rendering engine as
the [VS Code DITA Viewer](https://github.com/aREversez/VS-Code-DITA-Viewer).

## Status

**Preview and editing** of single `.dita` topics, desktop only.

Works: all topic types and specializations the core renders, `keyref` /
`conkeyref` against the ditamap near the topic, `conref` / `conrefend`
(including content from other files, and re-render when those change), images
inside the vault, MathML, links between topics, light and dark themes, and
editing the XML source with three view modes (below).

Not yet: `.ditamap` views (outline, book, site), tag and attribute completion
and diagnostics in the editor, conref "jump to source", profiling filters, Git
compare, DITA-OT. Mobile is not supported because the core reads files through
Node.

## View modes

A `.dita` file opens in one of three modes, like a Markdown note. Use the
button in the pane header, the pane's "more options" menu, or a command:

| Mode | What you see |
| --- | --- |
| **Reading view** | The formatted topic. |
| **Source mode** | The XML in an editor: syntax highlighting, line numbers, auto-closing tags and quotes, search, undo history. |
| **Live preview (side by side)** | Source on the left, preview on the right. The preview updates shortly after you stop typing and keeps the last good render while the XML is invalid (an error bar says what is wrong). Scrolling or moving the caret in the source scrolls the preview to the same place; clicking an element in the preview puts the caret on its source. |

Commands (all under "DITA Viewer:"): *Reading view*, *Source mode*, *Live
preview (side by side)*, and *Toggle reading view and source mode*. No hotkeys
are assigned; set your own under Settings → Hotkeys. Settings has the default
mode for newly opened files and the live-preview delay. Each pane remembers the
mode you last chose for it.

Edits are saved by Obsidian as for any text file, and a change to the file on
disk is merged into the open editor without moving your caret.

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

## License

MIT
