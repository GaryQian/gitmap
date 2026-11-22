// The code view: CodeMirror 6, read-only. This module and everything it imports load on demand
// (CodeView.tsx imports it dynamically), so none of it is in the initial bundle. Colours are CSS
// variables from sidebar.css, so one theme serves dark and light and follows a change of appearance
// without reconfiguring the editor.
import { selectAll } from '@codemirror/commands';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--gm-text)', backgroundColor: 'transparent', fontSize: '12px' },
  // the app's own focus ring is drawn on the content element instead (sidebar.css)
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--gm-font-code)', lineHeight: '1.65', letterSpacing: '0', fontVariantLigatures: 'none',
    overflow: 'auto',
  },
  '.cm-content': { padding: '14px 0 28px', caretColor: 'transparent' },
  '.cm-line': { padding: '0 24px 0 14px' },
  // opaque: the gutter stays put while long lines scroll underneath it
  '.cm-gutters': { backgroundColor: 'var(--gm-sidebar)', color: 'var(--gm-reader-gutter)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 20px', minWidth: '28px' },
  '.cm-cursor, .cm-dropCursor': { display: 'none' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--gm-reader-selection)',
  },
  '.cm-specialChar': { color: 'var(--gm-syn-escape)' },
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
  { tag: t.strikethrough, textDecoration: 'line-through' },
]);

export interface CodeViewOptions {
  text: string;
  /** Picks the language, by name and extension. */
  fileName: string;
  /** Called with the language's display name once it is known; not called for a plain-text file. */
  onLanguage?: (name: string) => void;
}

export interface CodeViewHandle { destroy(): void }

export function mountCodeView(parent: HTMLElement, { text, fileName, onLanguage }: CodeViewOptions): CodeViewHandle {
  const language = new Compartment();
  let alive = true;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      // a file's last line ends with a newline; without this the gutter numbers one line more than the file has
      doc: text.replace(/\r?\n$/, ''),
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        // not editable, so not focusable by default: make it reachable, and scrollable, from the keyboard
        EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': `Contents of ${fileName}`, 'aria-readonly': 'true' }),
        lineNumbers(),
        highlightSpecialChars(),
        drawSelection(),
        keymap.of([{ key: 'Mod-a', run: selectAll }]),
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
  };
}
