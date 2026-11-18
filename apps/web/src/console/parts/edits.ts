// Code Codex proposes as an edit, shown as a diff the asker can approve or
// deny. An approved edit goes into the shared editor as one undoable step,
// so the other person in the room sees it land like any other typing.
//
// Codex writes edits as fenced ```edit blocks of SEARCH/REPLACE sections
// (see SYSTEM_PROMPT in the backend's services/assistant.py). SEARCH has to
// match the editor's text; nothing is applied on a guess.

import { createContext } from "react";
import type { MonacoEditor } from "../../components/CollaborativeEditor";

export interface Hunk {
  search: string;
  replace: string;
}

type Parsed = { hunks: Hunk[] } | { error: string };

const SEARCH = /^<{7} ?SEARCH\s*$/;
const DIVIDER = /^={7}\s*$/;
const REPLACE = /^>{7} ?REPLACE\s*$/;

export const parseEdit = (text: string): Parsed => {
  const hunks: Hunk[] = [];
  let state: "outside" | "search" | "replace" = "outside";
  let search: string[] = [];
  let replace: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (state === "outside" && SEARCH.test(line)) {
      state = "search";
      search = [];
      replace = [];
    } else if (state === "search" && DIVIDER.test(line)) {
      state = "replace";
    } else if (state === "replace" && REPLACE.test(line)) {
      hunks.push({ search: search.join("\n"), replace: replace.join("\n") });
      state = "outside";
    } else if (state === "search") {
      search.push(line);
    } else if (state === "replace") {
      replace.push(line);
    }
  }
  if (state !== "outside") return { error: "This edit is incomplete." };
  if (hunks.length === 0) return { error: "This block is not written as an edit." };
  return { hunks };
};

/** Where `search` is in `text`: exactly, or line by line ignoring trailing spaces. */
const locate = (text: string, search: string): { start: number; end: number } | "missing" | "ambiguous" => {
  if (search === "") return { start: text.length, end: text.length };
  const exact = text.indexOf(search);
  if (exact !== -1) {
    return text.indexOf(search, exact + 1) === -1 ? { start: exact, end: exact + search.length } : "ambiguous";
  }
  const lines = text.split("\n");
  const wanted = search.split("\n").map((line) => line.trimEnd());
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const found: number[] = [];
  for (let first = 0; first + wanted.length <= lines.length; first += 1) {
    if (wanted.every((line, index) => lines[first + index].trimEnd() === line)) found.push(first);
  }
  if (found.length === 0) return "missing";
  if (found.length > 1) return "ambiguous";
  const last = found[0] + wanted.length - 1;
  return { start: starts[found[0]], end: starts[last] + lines[last].length };
};

/** Apply every hunk or none. Returns an error to show, or null when it went in. */
export const applyHunks = (editor: MonacoEditor | null, hunks: Hunk[]): string | null => {
  const model = editor?.getModel();
  if (!editor || !model) return "The editor is not ready yet.";
  const text = model.getValue();
  const edits: { start: number; end: number; text: string }[] = [];
  for (const hunk of hunks) {
    const at = locate(text, hunk.search);
    if (at === "missing") return "The code has changed since Codex saw it. Ask again.";
    if (at === "ambiguous") return "This edit matches more than one place in the code.";
    edits.push({ ...at, text: hunk.replace });
  }
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index > 0 && edit.start < edits[index - 1].end)) {
    return "This edit changes the same lines twice.";
  }
  const range = (start: number, end: number) => {
    const from = model.getPositionAt(start);
    const to = model.getPositionAt(end);
    return { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column };
  };
  editor.pushUndoStop();
  const applied = editor.executeEdits(
    "codex",
    edits.map((edit) => ({ range: range(edit.start, edit.end), text: edit.text, forceMoveMarkers: true })),
  );
  editor.pushUndoStop();
  return applied ? null : "The editor is read-only right now.";
};

/** What the room offers an edit proposal. Absent outside the room: no buttons there. */
export interface EditActions {
  apply: ((hunks: Hunk[]) => string | null) | null;
}
export const EditContext = createContext<EditActions | null>(null);
