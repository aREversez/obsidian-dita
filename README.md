# obsidian-dita

Read DITA topics in Obsidian. `.dita` files open in a formatted reading view
that takes its colours, fonts and heading style from whichever theme you use.

Built on [`@dita-viewer/core`](packages/dita-core), the same rendering engine as
the [VS Code DITA Viewer](https://github.com/aREversez/VS-Code-DITA-Viewer).

## Status

First cut: **single-topic preview** of `.dita` files, desktop only.

Works: all topic types and specializations the core renders, `keyref` /
`conkeyref` against the ditamap near the topic, `conref` / `conrefend`
(including content from other files, and re-render when those change), images
inside the vault, MathML, links between topics, light and dark themes.

Not yet: `.ditamap` views (outline, book, site), editing the source from
inside Obsidian (the preview replaces the editor for `.dita`), conref
"jump to source", profiling filters, Git compare, DITA-OT. Mobile is not
supported because the core reads files through Node.

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
3. **Derived, not hard-coded, colours.** Note/warning/danger/tip panels, the
   conditional-processing highlight and index chips are `color-mix()` of the
   theme's own palette against its own background. They are therefore right in
   light and dark, and in themes nobody tested.
4. **Contrast is tested.** `test/theme.test.ts` resolves the adapter against
   nine theme archetypes (default light/dark, warm paper, Solarized, AMOLED
   black, neon, pastel, high contrast) and checks that body text stays at WCAG
   AA on every derived background, and that no `--vscode-*` leaks into either
   stylesheet.
5. **You can override anything.** Outer CSS wins over the shadow root's
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
