// The code editor: CodeMirror 6. This module and everything it imports load on demand (CodeView.tsx
// imports it dynamically), so none of it is in the initial bundle. Colours are CSS variables from
// sidebar.css, so one theme serves dark and light and follows a change of appearance without
// reconfiguring the editor.
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, LanguageDescription, syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--gm-text)', backgroundColor: 'transparent', fontSize: '12px' },
  // the app's own focus ring is drawn on the content element instead (sidebar.css)
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--gm-font-code)', lineHeight: '1.65', letterSpacing: '0', fontVariantLigatures: 'none',
    overflow: 'auto',
  },
  '.cm-content': { padding: '14px 0 28px', caretColor: 'var(--gm-text)' },
  '.cm-line': { padding: '0 24px 0 6px' },
  // opaque: the gutter stays put while long lines scroll underneath it
  '.cm-gutters': { backgroundColor: 'var(--gm-sidebar)', color: 'var(--gm-reader-gutter)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 16px', minWidth: '28px' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer' },
  '.cm-activeLine': { backgroundColor: 'var(--gm-reader-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--gm-text)' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '1.5px solid var(--gm-text)' },
  '&:not(.cm-focused) .cm-cursor': { display: 'none' },
  '&:not(.cm-focused) .cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--gm-reader-selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--gm-reader-match)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--gm-reader-match)', outline: '1px solid var(--gm-hairline)' },
  '&.cm-focused .cm-nonmatchingBracket': { color: 'var(--gm-syn-escape)' },
  '.cm-searchMatch': { backgroundColor: 'var(--gm-reader-match)', outline: '1px solid var(--gm-hairline)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--gm-reader-selection)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--gm-reader-fill)', border: '1px solid var(--gm-hairline)', color: 'var(--gm-text-dim)' },
  '.cm-specialChar': { color: 'var(--gm-syn-escape)' },
  '.cm-panels': { backgroundColor: 'var(--gm-sidebar)', color: 'var(--gm-text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--gm-hairline)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--gm-hairline)' },
  '.cm-panel.cm-search': { padding: '8px 36px 8px 14px', fontFamily: 'var(--gm-font-ui)', fontSize: '12px' },
  '.cm-panel.cm-search label': { fontSize: '12px', color: 'var(--gm-text-dim)' },
  '.cm-textfield': {
    fontFamily: 'var(--gm-font-code)', fontSize: '12px', color: 'var(--gm-text)', backgroundColor: 'var(--gm-reader-fill)',
    border: '1px solid var(--gm-hairline)', borderRadius: '6px', padding: '3px 7px',
  },
  '.cm-button': {
    fontFamily: 'var(--gm-font-ui)', fontSize: '12px', color: 'var(--gm-text)', backgroundImage: 'none',
    backgroundColor: 'var(--gm-reader-fill)', border: '1px solid var(--gm-hairline)', borderRadius: '999px', padding: '2px 10px',
  },
  '.cm-panel.cm-search [name=close]': { color: 'var(--gm-text-dim)', top: '6px', right: '10px', fontSize: '16px' },
  '.cm-tooltip': { backgroundColor: 'var(--gm-sidebar)', border: '1px solid var(--gm-hairline)', color: 'var(--gm-text)' },
});

const highlight = HighlightStyle.define([
  { tag: [t.comment, t.meta, t.documentMeta], color: 'var(--gm-syn-comment)' },
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.processingInstruction, t.self, t.heading], color: 'var(--gm-syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.inserted, t.attributeValue], color: 'var(--gm-syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color, t.constant(t.name), t.standard(t.name)], color: 'var(--gm-syn-number)' },
  { tag: [t.regexp, t.escape, t.character, t.deleted, t.invalid], color: 'var(--gm-syn-escape)' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.annotation], color: 'var(--gm-syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName], color: 'var(--gm-syn-function)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--gm-syn-property)' },
  { tag: [t.operator, t.punctuation, t.separator, t.derefOperator], color: 'var(--gm-syn-punctuation)' },
  { tag: [t.link, t.url], color: 'var(--gm-halo)' },
  { tag: t.heading1, fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
]);

/** The indent a file already uses: a tab, or the smallest run of leading spaces (2 or 4 when unclear). */
function detectIndent(text: string): string {
  let tabs = 0;
  let smallest = 0;
  for (const m of text.slice(0, 64 * 1024).matchAll(/^([ \t]+)\S/gm)) {
    const lead = m[1]!;
    if (lead[0] === '\t') { tabs++; continue; }
    if (lead.length >= 2 && (smallest === 0 || lead.length < smallest)) smallest = lead.length;
  }
  if (tabs > 0 && smallest === 0) return '\t';
  return ' '.repeat(smallest === 0 || smallest > 8 ? 2 : smallest);
}

export interface EditorOptions {
  text: string;
  /** Picks the language, by name and extension. */
  fileName: string;
  /** No typing: a file cut short, or one that is not clean UTF-8. */
  readOnly: boolean;
  /** Called with the full text (in the file's own line endings) after each change. */
  onChange?: (text: string) => void;
  /** Mod-S. */
  onSave?: () => void;
  /** Called with the language's display name once it is known; not called for a plain-text file. */
  onLanguage?: (name: string) => void;
}

export interface EditorHandle {
  destroy(): void;
  focus(): void;
}

export function mountEditor(parent: HTMLElement, { text, fileName, readOnly, onChange, onSave, onLanguage }: EditorOptions): EditorHandle {
  const language = new Compartment();
  let alive = true;
  const crlf = text.includes('\r\n');

  const editing: Extension = readOnly
    ? [
        EditorState.readOnly.of(true),
        EditorView.contentAttributes.of({ 'aria-readonly': 'true' }),
      ]
    : [
        // Tab indents here, so say how to leave with the keyboard (CodeMirror's own switch, in defaultKeymap)
        EditorView.contentAttributes.of({
          'aria-description': `Tab indents. ${/Mac|iPhone|iPad/.test(navigator.platform) ? 'Shift+Option+M' : 'Control+M'} switches Tab to moving the focus out of the editor.`,
        }),
        history(),
        closeBrackets(),
        indentOnInput(),
        indentUnit.of(detectIndent(text)),
        EditorView.updateListener.of((u) => { if (u.docChanged) onChange?.(u.state.sliceDoc()); }),
      ];

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        // the file keeps its own line endings when it is saved
        crlf ? EditorState.lineSeparator.of('\r\n') : [],
        EditorView.contentAttributes.of({ 'aria-label': `Contents of ${fileName}` }),
        editing,
        lineNumbers(),
        foldGutter({ openText: '⌄', closedText: '›' }),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        highlightSpecialChars(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { onSave?.(); return true; } },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...(readOnly ? [] : [indentWithTab]),
        ]),
        language.of([]),
        syntaxHighlighting(highlight),
        theme,
      ],
    }),
  });

  const description = LanguageDescription.matchFilename(languages, fileName);
  if (description) {
    description.load().then(
      (support) => {
        if (!alive) return;
        view.dispatch({ effects: language.reconfigure(support) });
        onLanguage?.(description.name);
      },
      () => { /* the language chunk did not load: the file stays readable, uncoloured */ },
    );
  }

  // CodeMirror measures character widths when it is created; measure again once Commit Mono is in.
  const remeasure = () => { if (alive) view.requestMeasure(); };
  document.fonts?.ready.then(remeasure, () => {});
  document.fonts?.addEventListener('loadingdone', remeasure);

  return {
    destroy() {
      alive = false;
      document.fonts?.removeEventListener('loadingdone', remeasure);
      view.destroy();
    },
    focus() { view.focus(); },
  };
}
