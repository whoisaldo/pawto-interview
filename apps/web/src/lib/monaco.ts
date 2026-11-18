import { loader } from "@monaco-editor/react";
import type { BeforeMount } from "@monaco-editor/react";

// The editor's code is fetched from a CDN unless told otherwise. A server
// that cannot count on reaching it (a classroom network, a demonstration with
// no internet) can serve its own copy of monaco-editor's `min/vs` folder and
// name that path here.
const localMonaco = import.meta.env.VITE_MONACO_VS_PATH;
if (localMonaco) {
  loader.config({ paths: { vs: localMonaco } });
}

export const EDITOR_THEME = "tandem";
export const INTERVIEW_EDITOR_THEME = "interview";

// vs-dark on the page's charcoal, so the editor sits flush inside its card.
export const defineEditorTheme: BeforeMount = (monaco) => {
  monaco.editor.defineTheme(EDITOR_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#101013",
      "editor.lineHighlightBackground": "#18181b",
      "editorLineNumber.foreground": "#52525b",
      "editorLineNumber.activeForeground": "#a1a1aa",
      "editorCursor.foreground": "#f97316",
      "editor.selectionBackground": "#f9731640",
    },
  });
  monaco.editor.defineTheme(INTERVIEW_EDITOR_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#17181b",
      "editor.lineHighlightBackground": "#22242a",
      "editorLineNumber.foreground": "#a2a9b4",
      "editorLineNumber.activeForeground": "#f0f2f5",
      "editorGutter.background": "#17181b",
      "editor.selectionBackground": "#263e61",
      "editorCursor.foreground": "#85b5ff",
    },
  });
};
