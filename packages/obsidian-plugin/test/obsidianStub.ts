// A stand-in for the obsidian package, loaded with --require before the specs.
//
// `node_modules/obsidian` ships types only: its `main` is empty, so require
// ('obsidian') throws as soon as a test loads a module that imports one of its
// values (SiteNav reads Keymap, TFile and moment; ProfileController reaches
// FileSystemAdapter and Notice through pickers.ts). This file answers that one
// request with the members below.
//
// Only the members the tests reach are here. Anything else throws with the
// name it was asked for: a test that drifts onto another part of the API fails
// by name, instead of passing against a stand-in that quietly pretends.

import Module from 'module';

/** A file in the vault. The tests hand their own plain objects where one is needed. */
class TFile {
  path = '';
  basename = '';
  extension = '';
}

/** A vault stored on the local file system: the tests give it a temporary directory. */
class FileSystemAdapter {
  constructor(readonly root = '') {}

  getBasePath(): string {
    return this.root;
  }
}

/** The base of the pickers; a test never opens one, so nothing here does anything. */
class SuggestModal<T> {
  constructor(readonly app: unknown) {}

  open(): void {}
  close(): void {}
  setPlaceholder(): this {
    return this;
  }
  setInstructions(): void {}
}

/** A toast. The tests read the message back through the field. */
class Notice {
  constructor(readonly message: string) {}
  hide(): void {}
}

/** Loaded only for its side effect: the request for 'obsidian' is answered below. */
export {};

const stub: Record<string, unknown> = {
  TFile,
  FileSystemAdapter,
  SuggestModal,
  Notice,
  Keymap: {
    /** Ctrl/Cmd on a click: the tests call the page code, not the handlers. */
    isModEvent: (): boolean => false,
  },
  Platform: { isMacOS: false, isMobile: false, isDesktop: true },
  /** SiteNav formats its landmark labels with the current locale. */
  moment: Object.assign((): string => '', { locale: (): string => 'en' }),
};

const proxy = new Proxy(stub, {
  get(target, name, receiver) {
    if (typeof name === 'symbol' || name in target) return Reflect.get(target, name, receiver);
    // What the compiler's namespace interop asks for; not part of the API.
    if (name === '__esModule' || name === 'default') return undefined;
    throw new Error(`obsidian stub: "${name}" is not provided by test/obsidianStub.ts`);
  },
});

interface Loader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

const loader = Module as unknown as Loader;
const load = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean): unknown {
  return request === 'obsidian' ? proxy : load.call(this, request, parent, isMain);
};
