// Render a .ditamap's text to the outline tree HTML.
//
// The same steps the VS Code viewer's tree mode runs (parse, splice in
// referenced submaps, render), as one host-neutral call. Nothing here is new
// rendering logic -- it only sequences the copied parser and renderer.

import { resolve } from 'path';
import { parseDitamap, preprocessEntities } from './parser/ditaParser';
import { expandDitamapRefs } from './editor/refResolvers';
import { readSourceText } from './editor/sourceText';
import { RoleLabelFormatter, renderMapDocument } from './render/mapTypeMap';

export interface MapXmlRenderInput {
  xml: string;
  /** Folder of the map: hrefs and submap references resolve against it. */
  docDir: string;
  /** Key name -> text, for keyref in titles and navtitles. */
  keyMap?: ReadonlyMap<string, string>;
  roleFormat?: RoleLabelFormatter;
  /** aria-label of the tree. */
  treeLabel?: string;
  /** Receives the absolute path of every submap file read. */
  collectDependencies?: Set<string>;
}

export function renderMapXml(input: MapXmlRenderInput): string {
  const doc = parseDitamap(preprocessEntities(input.xml));
  const read = (path: string, enc: 'utf-8'): string => {
    input.collectDependencies?.add(resolve(path));
    return readSourceText(path, enc);
  };
  expandDitamapRefs(doc.root, input.docDir, read);
  return renderMapDocument(doc.root, {
    docDir: input.docDir,
    resolveKey: (k) => input.keyMap?.get(k),
    roleFormat: input.roleFormat,
    treeLabel: input.treeLabel,
  });
}
