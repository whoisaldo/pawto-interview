// y-monaco imports monaco-editor's whole API, which would put a second copy
// of the editor in the app's bundle beside the one @monaco-editor/react
// loads at runtime. It only reaches for these three while an editor is
// running, so vite.config.ts points that import here and they come from the
// copy the page already loaded.

const live = () => window.monaco;

export function Selection(...args) {
  return new (live().Selection)(...args);
}
Selection.createWithDirection = (...args) => live().Selection.createWithDirection(...args);

export function Range(...args) {
  return new (live().Range)(...args);
}

export const SelectionDirection = {
  get LTR() {
    return live().SelectionDirection.LTR;
  },
  get RTL() {
    return live().SelectionDirection.RTL;
  },
};
