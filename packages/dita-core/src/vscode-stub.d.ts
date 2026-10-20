// Type-only stand-in for the `vscode` module.
//
// editor/topicRender.ts (a verbatim copy of the VS Code DITA Viewer source)
// contains one host-specific function, openHrefTarget(vscode: typeof
// import('vscode'), ...), which takes the vscode API as a parameter and never
// imports it at runtime. This declaration lets that signature compile without
// pulling the real @types/vscode into a host-neutral package. The proper fix
// is upstream: move openHrefTarget out of topicRender.ts into a VS Code-only
// module, after which this file can be deleted.
declare module 'vscode' {
  const vscode: any;
  export = vscode;
}
