// ==UserScript==
// @name         PG-PASTOR
// @namespace    PG-PASTOR
// @version      0.13
// @description  Local paste library and compact keyword suggestions for Playgama Comment.
// @match        https://playgama.youtrack.cloud/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @updateURL    https://raw.githubusercontent.com/KaX8/PG-PASTOR/main/PG-PASTOR.user.js
// @downloadURL  https://raw.githubusercontent.com/KaX8/PG-PASTOR/main/PG-PASTOR.user.js
// ==/UserScript==

(() => {
  'use strict';

  const DB_KEY = 'pgPasteHelperDB_v1';
  const ENABLED_KEY = 'pgPasteHelperSuggestions_v1';
  const EDITOR_SELECTOR = [
    '[data-test="editor field-Playgama Comment"] [data-test="wysiwyg-editor-content"][contenteditable="true"]',
    '[data-test="editor field-Notes"] [data-test="wysiwyg-editor-content"][contenteditable="true"]'
  ].join(', ');
  const TITLE_LIMIT = 20;
  const MAX_KEYWORD_LENGTH = 320;
  const MAX_PASTES = 5000;
  const HOTKEY = { code: 'Space', ctrl: true, shift: true, alt: false, meta: false };

  function normalize(text) {
    return text.replace(/\u00a0/g, ' ').replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
  }

  function shortTitle(title) {
    const chars = Array.from(title.replace(/\s+/gu, ' ').trim());
    return chars.length > TITLE_LIMIT ? chars.slice(0, TITLE_LIMIT).join('') + '…' : chars.join('');
  }

  function newId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function validatePastes(source) {
    const envelope = typeof source === 'string' ? JSON.parse(source) : source;

    if (!Array.isArray(envelope) && (!envelope || envelope.version !== 1)) {
      throw new Error('Expected a JSON array or an object with version: 1 and pastes: [...].');
    }

    const list = Array.isArray(envelope) ? envelope : envelope.pastes;

    if (!Array.isArray(list) || list.length > MAX_PASTES) {
      throw new Error(`Expected an array of at most ${MAX_PASTES} pastes.`);
    }

    const usedIds = new Set();

    return list.map((item, index) => {
      const label = `Paste ${index + 1}`;

      if (!item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500) {
        throw new Error(`${label}: title must contain 1–500 characters.`);
      }

      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 100000) {
        throw new Error(`${label}: text must contain 1–100000 characters.`);
      }

      if (!Array.isArray(item.keywords) || !item.keywords.length || item.keywords.length > 100) {
        throw new Error(`${label}: keywords must be an array of 1–100 strings.`);
      }

      const keywords = [];
      const seen = new Set();

      for (const key of item.keywords) {
        if (typeof key !== 'string' || !key.trim() || key.length > MAX_KEYWORD_LENGTH || /[\r\n]/u.test(key)) {
          throw new Error(`${label}: each keyword must be a single line of 1–${MAX_KEYWORD_LENGTH} characters.`);
        }

        const cleaned = key.replace(/\s+/gu, ' ').trim();
        const folded = normalize(cleaned);

        if (!seen.has(folded)) {
          keywords.push(cleaned);
          seen.add(folded);
        }
      }

      const id = typeof item.id === 'string' && item.id.trim() ? item.id : newId();

      if (usedIds.has(id)) throw new Error(`${label}: duplicate id.`);

      usedIds.add(id);

      return {
        id,
        title: item.title.replace(/\s+/gu, ' ').trim(),
        text: item.text.replace(/\r\n?/g, '\n'),
        keywords
      };
    });
  }

  function buildIndex(pastes) {
    return pastes.flatMap((paste, order) =>
      paste.keywords.map(keyword => ({
        paste,
        order,
        keyword: normalize(keyword)
      }))
      );
  }

  function findMatches(raw, index) {
    // Only suffixes ending at the caret may replace text. Never match inside a word.
    const startLimit = Math.max(0, raw.length - MAX_KEYWORD_LENGTH);
    const results = new Map();

    for (let start = startLimit; start < raw.length; start++) {
      if (start > 0 && !/[\s.,;:!?()[\]{}"'«»—–/\\]/u.test(raw[start - 1])) continue;

      const suffix = raw.slice(start);
      if (/^\s/u.test(suffix)) continue;

      const query = normalize(suffix);
      const length = Array.from(query.trim()).length;

      if (!length) continue;

      for (const entry of index) {
        const exact = entry.keyword === query;
        let rank;

        if (exact) rank = 0;
        else if (entry.keyword.startsWith(query)) rank = 1;
        else if (entry.keyword.includes(query) && !/\s$/u.test(query)) rank = 2;
        else continue;

        const match = {
          paste: entry.paste,
          rank,
          start,
          raw: suffix,
          order: entry.order
        };

        const existing = results.get(entry.paste.id);

        if (!existing || compareMatches(match, existing) < 0) {
          results.set(entry.paste.id, match);
        }
      }
    }

    return [...results.values()].sort(compareMatches);
  }

  function compareMatches(a, b) {
    return a.rank - b.rank || b.raw.length - a.raw.length || a.order - b.order;
  }

  // UI and editor integration.
  let pastes = [];
  let index = [];
  let loadError = '';
  let enabled = GM_getValue(ENABLED_KEY, true) !== false;
  let current = null;
  let selected = 0;
  let expanded = false;
  let composing = false;
  let inserting = false;
  let queued = false;
  let dismissed = '';
  let managerReturn = null;
  let selectedPasteId = null;
  let menuQueued = false;

  function loadDatabase() {
    try {
      pastes = validatePastes(GM_getValue(DB_KEY, { version: 1, pastes: [] }));
      index = buildIndex(pastes);
      loadError = '';
    } catch (error) {
      pastes = [];
      index = [];
      loadError = `The saved database could not be read: ${error.message} Existing data was preserved.`;
    }
  }

  loadDatabase();

  const host = document.createElement('div');
  host.id = 'pg-paste-helper-root';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');

  style.textContent = `
    :host {
      color-scheme: dark;
      font: 13px/1.45 system-ui, sans-serif;
      color: #e7e9ef;
    }

    * {
      box-sizing: border-box;
    }

    [hidden] {
      display: none !important;
    }

    button, input, textarea {
      font: inherit;
    }

    button {
      border: 1px solid #434956;
      border-radius: 6px;
      background: #2c303b;
      color: inherit;
      padding: 6px 10px;
      cursor: pointer;
    }

    button:hover {
      background: #393f4d;
    }

    button:focus-visible, input:focus, textarea:focus {
      outline: 2px solid #7fa7ff;
      outline-offset: 2px;
    }

    button.primary {
      background: #315db8;
      border-color: #537ad0;
    }

    button.danger {
      color: #ffb6b6;
    }

    input, textarea {
      width: 100%;
      color: inherit;
      background: #181b22;
      border: 1px solid #434956;
      border-radius: 6px;
      padding: 8px;
    }

    textarea {
      resize: vertical;
    }

    label {
      display: block;
      margin: 12px 0 5px;
    }

    .suggest {
      position: fixed;
      pointer-events: auto;
      border: 1px solid #555e70;
      border-radius: 5px;
      padding: 2px;
      background: #242832;
      box-shadow: 0 3px 10px #0005;
    }

    .suggest button {
      display: block;
      width: 100%;
      text-align: left;
      border: 0;
      border-radius: 3px;
      background: transparent;
      padding: 3px 7px;
      white-space: nowrap;
      line-height: 19px;
      font-size: 12px;
    }

    .suggest button.active {
      background: #3b4764;
    }

    .suggest button:hover {
      background: #435272;
    }

    .suggest.expanded {
      max-height: min(250px, 60vh);
      overflow-y: auto;
    }

    .veil {
      position: fixed;
      inset: 0;
      pointer-events: auto;
      background: #0009;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .modal {
      width: min(940px, 100%);
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      background: #222630;
      border: 1px solid #505665;
      border-radius: 12px;
      box-shadow: 0 12px 60px #0009;
      overflow: hidden;
    }

    .header {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid #424754;
    }

    .header h1 {
      margin: 0;
      font-size: 18px;
      flex: 1;
    }

    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 12px 20px;
    }

    .bar input {
      flex: 1;
      min-width: 150px;
    }

    .body {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      min-height: 300px;
      overflow: auto;
      border-top: 1px solid #424754;
    }

    .list {
      border-right: 1px solid #424754;
      padding: 12px;
      overflow: auto;
      max-height: 60vh;
    }

    .list button {
      display: block;
      width: 100%;
      margin-bottom: 6px;
      text-align: left;
      overflow-wrap: anywhere;
    }

    .list button.selected {
      background: #354873;
      border-color: #7fa7ff;
    }

    .detail {
      padding: 18px 20px;
      overflow: auto;
      max-height: 60vh;
    }

    .detail h2 {
      font-size: 17px;
      margin: 0 0 12px;
      overflow-wrap: anywhere;
    }

    .text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #181b22;
      padding: 12px;
      border-radius: 6px;
    }

    .muted {
      color: #aab2c3;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 16px;
    }

    .status {
      padding: 0 20px 12px;
      min-height: 30px;
      color: #aab2c3;
      overflow-wrap: anywhere;
    }

    .error {
      color: #ffb6b6;
    }

    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #292e39;
      border: 1px solid #555e70;
      border-radius: 8px;
      padding: 10px 16px;
      max-width: min(600px, 90vw);
      box-shadow: 0 5px 20px #0005;
      pointer-events: auto;
    }

    @media (max-width: 650px) {
      .veil {
        padding: 10px;
      }

      .body {
        grid-template-columns: 1fr;
      }

      .list {
        max-height: 160px;
        border-right: 0;
        border-bottom: 1px solid #424754;
      }

      .detail {
        max-height: 45vh;
      }
    }
  `;

  shadow.append(style);
  document.documentElement.append(host);

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, handler, className) {
    const node = element('button', text, className);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }

  const suggestion = element('div', undefined, 'suggest');
  suggestion.hidden = true;
  suggestion.setAttribute('role', 'listbox');
  suggestion.setAttribute('aria-label', 'Paste suggestions');
  shadow.append(suggestion);

  // Keep the editor selection when either mouse button is used on a suggestion.
  suggestion.addEventListener('mousedown', event => event.preventDefault());

  suggestion.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (!current) return;

    expanded = !expanded;
    selected = 0;
    renderSuggestions();
  });

  let toastTimer;

  const toastBox = element('div', undefined, 'toast');
  toastBox.hidden = true;
  toastBox.setAttribute('role', 'status');
  shadow.append(toastBox);

  function toast(message) {
    toastBox.textContent = message;
    toastBox.hidden = false;
    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      toastBox.hidden = true;
    }, 4500);
  }

  function editorFor(node) {
    const parent = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return parent?.closest?.(EDITOR_SELECTOR) || null;
  }

  function caretContext() {
    const selection = document.getSelection();
    if (!selection || !selection.isCollapsed || !selection.rangeCount) return null;

    const caret = selection.getRangeAt(0);
    const editor = editorFor(caret.endContainer);

    if (!editor || !editor.contains(document.activeElement) && document.activeElement !== editor) {
      return null;
    }

    let block = caret.endContainer.nodeType === Node.ELEMENT_NODE
    ? caret.endContainer
    : caret.endContainer.parentElement;

    while (
      block &&
      block !== editor &&
      !block.matches('p,pre,h1,h2,h3,h4,h5,h6,li,td,th')
      ) {
      block = block.parentElement;
  }

  if (!block) return null;

  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(caret.endContainer, caret.endOffset);

  const pieces = [];

  function read(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      pieces.push(node.data);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'BR' || node.getAttribute('contenteditable') === 'false') {
        pieces.push('\n');
      } else {
        for (const child of node.childNodes) read(child);
      }
  } else {
    for (const child of node.childNodes) read(child);
  }
}

read(before.cloneContents());

const text = pieces.join('');
const line = text.slice(text.lastIndexOf('\n') + 1);

return {
  editor,
  caret: caret.cloneRange(),
  line,
  signature: text
};
}

function replacementRange(context, match) {
  const range = context.caret.cloneRange();
  const root = context.editor;

  let remaining = match.raw.length;
  let node = range.endContainer;
  let offset = range.endOffset;

  function previous(item) {
    let candidate = item;

    while (candidate !== root && !candidate.previousSibling) {
      candidate = candidate.parentNode;
    }

    if (!candidate || candidate === root) return null;

    candidate = candidate.previousSibling;

    while (candidate.lastChild && candidate.nodeType !== Node.TEXT_NODE) {
      candidate = candidate.lastChild;
    }

    return candidate;
  }

  if (node.nodeType !== Node.TEXT_NODE) {
    if (offset > 0) {
      node = node.childNodes[offset - 1];

      while (node.lastChild && node.nodeType !== Node.TEXT_NODE) {
        node = node.lastChild;
      }
    } else {
      node = previous(node);
    }

    offset = node?.nodeType === Node.TEXT_NODE ? node.data.length : 0;
  }

  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (remaining <= offset) {
        range.setStart(node, offset - remaining);
        return range.toString() === match.raw ? range : null;
      }

      remaining -= offset;
    }

    node = previous(node);
    offset = node?.nodeType === Node.TEXT_NODE ? node.data.length : 0;
  }

  return null;
}

function hideSuggestions() {
  suggestion.hidden = true;
  suggestion.replaceChildren();
  current = null;
  expanded = false;
  selected = 0;
}

function updateSuggestions() {
  queued = false;

  if (!enabled || composing || inserting || !veil.hidden || loadError) {
    return hideSuggestions();
  }

  const context = caretContext();
  if (!context) return hideSuggestions();

  if (dismissed === context.signature && dismissedEditor === context.editor) {
    return hideSuggestions();
  }

  dismissed = '';

  const matches = findMatches(context.line, index);
  if (!matches.length) return hideSuggestions();

  const same = current?.context.editor === context.editor &&
  current.context.signature === context.signature;

  current = { context, matches };

  if (!same) {
    expanded = false;
    selected = 0;
  }

  renderSuggestions();
}

let dismissedEditor = null;

function scheduleSuggestions() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(updateSuggestions);
}

function positionSuggestions() {
  if (!current || suggestion.hidden) return;

  if (!current.context.editor.isConnected || !caretContext()) {
    return hideSuggestions();
  }

  let rect = current.context.caret.getClientRects()[0] ||
  current.context.caret.getBoundingClientRect();

  if (!rect || rect.height === 0) {
    rect = current.context.editor.getBoundingClientRect();
  }

  const width = suggestion.offsetWidth;
  const height = suggestion.offsetHeight;

  let top = rect.bottom + 3;

  if (top + height > innerHeight - 8) {
    top = rect.top - height - 3;
  }

  suggestion.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
  suggestion.style.top = `${Math.max(8, top)}px`;
}

function renderSuggestions() {
  if (!current) return;

  selected = Math.min(selected, current.matches.length - 1);
  suggestion.replaceChildren();
  suggestion.classList.toggle('expanded', expanded);

  const visible = expanded ? current.matches : current.matches.slice(0, 1);

  visible.forEach((match, itemIndex) => {
    const row = button(
      shortTitle(match.paste.title),
      () => insertPaste(match),
      itemIndex === selected ? 'active' : ''
      );

    row.tabIndex = -1;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-label', match.paste.title);
    row.setAttribute('aria-selected', String(itemIndex === selected));

    suggestion.append(row);
  });

  suggestion.hidden = false;
  positionSuggestions();

  if (expanded) {
    suggestion.children[selected]?.scrollIntoView({ block: 'nearest' });
  }
}

function insertPaste(match) {
  if (!current || inserting || composing) return;

  const live = caretContext();

  if (
    !live ||
    live.editor !== current.context.editor ||
    live.signature !== current.context.signature
    ) {
    hideSuggestions();
  return toast('The cursor moved. Type the keyword again.');
}

const range = replacementRange(live, match);

if (!range) {
  return toast('The keyword range could not be selected.');
}

const editor = live.editor;
const selection = document.getSelection();
const pasteText = match.paste.text.replace(/\r\n?/g, '\n');

inserting = true;
hideSuggestions();

editor.focus({ preventScroll: true });
selection.removeAllRanges();
selection.addRange(range);

try {
  let inserted = false;

  if (pasteText.includes('\n')) {
      // Escape HTML to prevent user text from being interpreted as markup.
    const escapeHTML = value => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

      // Preserve line breaks without creating additional paragraphs.
    const html = pasteText
    .split('\n')
    .map(escapeHTML)
    .join('<br>');

    inserted = document.execCommand('insertHTML', false, html);
  } else {
      // Keep native text insertion for single-line snippets.
    inserted = document.execCommand('insertText', false, pasteText);
  }

  if (!inserted) {
    toast('The editor did not confirm insertion. Check the comment before retrying.');
  }
} catch (error) {
  toast(`Insertion failed: ${error.message}`);
} finally {
    // Allow YouTrack to process the editor changes.
  setTimeout(() => {
    inserting = false;

    const context = caretContext();
    dismissed = context?.signature || '';
    dismissedEditor = editor;
  }, 80);
}
}

function setEnabled(value) {
  try {
    GM_setValue(ENABLED_KEY, value);
  } catch (error) {
    return toast(`Could not save the setting: ${error.message}`);
  }

  enabled = value;

  if (!enabled) {
    hideSuggestions();
  } else {
    dismissed = '';
    scheduleSuggestions();
  }

  updateToggleLabels();
  toast(`Suggestions ${enabled ? 'enabled' : 'disabled'}`);
}

const veil = element('div', undefined, 'veil');
veil.hidden = true;

const modal = element('section', undefined, 'modal');
modal.setAttribute('role', 'dialog');
modal.setAttribute('aria-modal', 'true');
modal.setAttribute('aria-label', 'Paste Helper');

const header = element('div', undefined, 'header');
header.append(element('h1', 'Paste Helper'), button('Close', closeManager));

const toolbar = element('div', undefined, 'bar');

const search = element('input');
search.type = 'search';
search.placeholder = 'Search titles, keywords or text';
search.setAttribute('aria-label', 'Search pastes');

const toggleButton = button('', () => setEnabled(!enabled));

toolbar.append(
  search,
  button('Add paste', () => editPaste()),
  button('Import JSON', importJSON),
  button('Export JSON', exportJSON),
  toggleButton
  );

const body = element('div', undefined, 'body');
const list = element('div', undefined, 'list');
const detail = element('div', undefined, 'detail');
const status = element('div', undefined, 'status');

status.setAttribute('role', 'status');

body.append(list, detail);
modal.append(header, toolbar, body, status);
veil.append(modal);
shadow.append(veil);

veil.addEventListener('click', event => {
  if (event.target === veil) closeManager();
});

search.addEventListener('input', renderList);

const managerKeys = new Set();

function interceptManagerKeys(event) {
  const key = event.code || event.key;
  const alreadyIntercepted = managerKeys.has(key);

  if (veil.hidden && !alreadyIntercepted) return;

  if (event.type === 'keydown') managerKeys.add(key);
  if (event.type === 'keyup') managerKeys.delete(key);

    // Stop page shortcuts before the event reaches document or React handlers.
    // Native typing, clipboard shortcuts and editing remain enabled.
  event.stopImmediatePropagation();

  if (event.type !== 'keydown' || veil.hidden || event.isComposing) return;

  if (
    event.code === HOTKEY.code &&
    event.ctrlKey === HOTKEY.ctrl &&
    event.shiftKey === HOTKEY.shift &&
    event.altKey === HOTKEY.alt &&
    event.metaKey === HOTKEY.meta
    ) {
    event.preventDefault();

  if (!event.repeat) setEnabled(!enabled);

  return;
}

if (event.key === 'Escape') {
  event.preventDefault();
  closeManager();
  return;
}

if (event.key === 'Tab') {
  const nodes = [...modal.querySelectorAll('button,input,textarea')]
  .filter(node => !node.disabled && node.getClientRects().length);

  const first = nodes[0];
  const last = nodes[nodes.length - 1];

  if (event.shiftKey && shadow.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && shadow.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
}

for (const eventName of ['keydown', 'keypress', 'keyup']) {
  window.addEventListener(eventName, interceptManagerKeys, true);
}

window.addEventListener('blur', () => managerKeys.clear());

function managerStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function openManager() {
  if (!veil.hidden) return search.focus();

  const selection = document.getSelection();

  managerReturn = {
    element: document.activeElement,
    range: selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
  };

  hideSuggestions();
  veil.hidden = false;
  search.value = '';

  renderList();
  showPaste(pastes.find(paste => paste.id === selectedPasteId));

  managerStatus(
    loadError || `${pastes.length} pastes · Ctrl+Shift+Space toggles suggestions`,
    Boolean(loadError)
    );

  search.focus();
}

function closeManager() {
  veil.hidden = true;

  const previous = managerReturn;
  managerReturn = null;

  if (previous?.element?.isConnected) {
    previous.element.focus({ preventScroll: true });
  }

  if (
    previous?.range?.startContainer.isConnected &&
    previous.range.endContainer.isConnected
    ) {
    const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(previous.range);

  const context = caretContext();
  dismissed = context?.signature || '';
  dismissedEditor = context?.editor || null;
}
}

function renderList() {
  const query = normalize(search.value.trim());

  const visible = pastes.filter(paste =>
    normalize([paste.title, paste.text, ...paste.keywords].join('\n')).includes(query)
    );

  list.replaceChildren();

  for (const paste of visible) {
    const row = button(
      paste.title,
      () => {
        selectedPasteId = paste.id;
        renderList();
        showPaste(paste);
      },
      paste.id === selectedPasteId ? 'selected' : ''
      );

    list.append(row);
  }

  if (!visible.length) {
    list.append(element(
      'p',
      pastes.length ? 'No matches.' : 'No pastes yet. Click Add paste.',
      'muted'
      ));
  }
}

function showPaste(paste) {
  detail.replaceChildren();

  if (!paste) {
    detail.append(element('p', 'Select a paste or add your first one.', 'muted'));
    return;
  }

  const actions = element('div', undefined, 'actions');

  actions.append(
    button('Edit', () => editPaste(paste)),
    button('Copy', () => copyPaste(paste)),
    button('Delete', () => {
      if (!confirm(`Delete “${paste.title}”?`)) return;

      if (!saveDatabase(pastes.filter(item => item.id !== paste.id))) return;

      selectedPasteId = null;
      renderList();
      showPaste(null);
      managerStatus('Paste deleted.');
    }, 'danger')
    );

  detail.append(
    element('h2', paste.title),
    element('div', paste.text, 'text'),
    element('p', `Keywords: ${paste.keywords.join(' · ')}`, 'muted'),
    actions
    );
}

function editPaste(paste) {
  detail.replaceChildren();
  const form = element('form');

  function field(label, tag, value, rows) {
    const input = element(tag);
    const id = `pgph-${newId()}`;

    input.id = id;
    input.value = value;
    input.required = true;

    if (rows) input.rows = rows;

    const caption = element('label', label);
    caption.htmlFor = id;
    form.append(caption, input);

    return input;
  }

  form.append(element('h2', paste ? 'Edit paste' : 'Add paste'));

  const title = field('Title', 'input', paste?.title || '');
  title.maxLength = 500;

  const text = field(
    'Text (plain text, line breaks supported)',
    'textarea',
    paste?.text || '',
    10
    );
  text.maxLength = 100000;

  const keywords = field(
    'Keywords / phrases — one per line',
    'textarea',
    paste?.keywords.join('\n') || '',
    4
    );

  const actions = element('div', undefined, 'actions');
  const submit = element('button', 'Save', 'primary');
  submit.type = 'submit';

  actions.append(
    submit,
    button('Cancel', () =>
      showPaste(pastes.find(item => item.id === selectedPasteId))
      )
    );

  form.append(actions);

  form.addEventListener('submit', event => {
    event.preventDefault();

    const item = {
      id: paste?.id || newId(),
      title: title.value,
      text: text.value,
      keywords: keywords.value
      .split(/\r?\n/)
      .map(key => key.trim())
      .filter(Boolean)
    };

    let clean;

    try {
      clean = validatePastes([item])[0];
    } catch (error) {
      return managerStatus(error.message, true);
    }

    const next = paste
    ? pastes.map(existing => existing.id === paste.id ? clean : existing)
    : [...pastes, clean];

    if (!saveDatabase(next)) return;

    selectedPasteId = clean.id;
    renderList();
    showPaste(clean);
    managerStatus('Paste saved.');
  });

  detail.append(form);
  title.focus();
}

function saveDatabase(next) {
  if (loadError) {
    managerStatus(
      'The stored database is invalid. Repair it before saving; existing data will not be overwritten.',
      true
      );
    return false;
  }

  try {
    const validated = validatePastes(next);
    GM_setValue(DB_KEY, { version: 1, pastes: validated });

    pastes = validated;
    index = buildIndex(pastes);
    dismissed = '';
    hideSuggestions();

    return true;
  } catch (error) {
    managerStatus(`Could not save: ${error.message}`, true);
    return false;
  }
}

async function copyPaste(paste) {
  try {
    await navigator.clipboard.writeText(paste.text);
    managerStatus('Copied.');
  } catch {
    const field = element('textarea');
    field.value = paste.text;
    field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;';

    shadow.append(field);
    field.focus();
    field.select();

    let copied = false;

    try {
      copied = document.execCommand('copy');
    } catch {
        // Keep the manual copy instruction.
    }

    field.remove();

    managerStatus(
      copied ? 'Copied.' : 'Copy was blocked. Select the paste text and press Ctrl+C.',
      !copied
      );
  }
}

function downloadJSON(contents, filename) {
  const url = URL.createObjectURL(new Blob(
    [JSON.stringify(contents, null, 2)],
    { type: 'application/json;charset=utf-8' }
    ));

  const anchor = element('a');
  anchor.href = url;
  anchor.download = filename;

  shadow.append(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportJSON() {
  if (loadError) {
    downloadJSON(GM_getValue(DB_KEY), 'playgama-pastes-recovery.json');
    return managerStatus('Exported the unreadable data for recovery.', true);
  }

  downloadJSON({ version: 1, pastes }, 'playgama-pastes.json');
  managerStatus('JSON exported.');
}

function importJSON() {
  const input = element('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.hidden = true;

  shadow.append(input);

  input.addEventListener('cancel', () => input.remove(), { once: true });

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();

    if (!file) return;

    if (file.size > 20 * 1024 * 1024) {
      return managerStatus('The JSON file must be smaller than 20 MB.', true);
    }

    try {
      const imported = validatePastes(await file.text());

      const fingerprint = item => JSON.stringify([
        item.title,
        item.text,
        [...item.keywords].map(normalize).sort()
      ]);

      const seen = new Set(pastes.map(fingerprint));
      const additions = [];

      for (const item of imported) {
        const key = fingerprint(item);

        if (seen.has(key)) continue;

        seen.add(key);
        additions.push({ ...item, id: newId() });
      }

      if (!saveDatabase([...pastes, ...additions])) return;

      renderList();
      showPaste(pastes.find(item => item.id === selectedPasteId));

      managerStatus(
    `Imported ${additions.length} pastes. Skipped ${imported.length - additions.length} duplicates. Existing pastes were kept.`
    );
    } catch (error) {
      managerStatus(`Import failed: ${error.message}`, true);
    }
  }, { once: true });

  input.click();
}

function updateToggleLabels() {
  const label = `Suggestions: ${enabled ? 'On' : 'Off'}`;
  toggleButton.textContent = label;

  for (const node of document.querySelectorAll('[data-pgph-toggle]')) {
    if (node.textContent !== label) node.textContent = label;
  }
}

function injectProfileMenu() {
  menuQueued = false;

    // Match the observed menu labels; do not depend on YouTrack's generated classes.
  for (const popup of document.querySelectorAll('[data-test~="ring-popup"]')) {
    if (popup.querySelector('[data-pgph-menu]')) continue;

    const items = [...popup.querySelectorAll('a,button,[role="menuitem"]')];
    const label = node => node.textContent.replace(/\s+/gu, ' ').trim();
    const profile = items.find(node => label(node) === 'Profile');

    if (
      !profile ||
      !items.some(node => ['Log out', 'Switch user'].includes(label(node)))
      ) {
      continue;
  }

  let container = profile.closest('[role="menu"],ul');

  if (!container || !popup.contains(container)) {
    container = popup;
  }

  const panel = element('div');
  panel.dataset.pgphMenu = '1';
  panel.style.cssText = 'border-top:1px solid #8885;margin-top:4px;padding:4px 0;';

  const open = button('Paste Helper', openManager);
  const toggle = button(
`Suggestions: ${enabled ? 'On' : 'Off'}`,
() => setEnabled(!enabled)
);

  toggle.dataset.pgphToggle = '1';

  const menuStyle = element('style');
  menuStyle.textContent = `
        [data-pgph-menu] button:hover,
        [data-pgph-menu] button:focus-visible {
          background: var(
            --navigation-link-background-color,
            var(--ring-selected-background-color, rgba(255, 255, 255, 0.08))
          ) !important;
        }
  `;
  panel.append(menuStyle);

  for (const control of [open, toggle]) {
    control.style.cssText = 'display:block;width:100%;padding:7px 14px;text-align:left;background:transparent;color:var(--ring-white-text-color, #fff);border:0;font:inherit;cursor:pointer;';
    panel.append(control);
  }

  container.append(panel);
}
}

const menuObserver = new MutationObserver(records => {
  if (menuQueued || !records.some(record => record.type === 'childList')) return;

  menuQueued = true;
  requestAnimationFrame(injectProfileMenu);
});

menuObserver.observe(document.body, { childList: true, subtree: true });

injectProfileMenu();
updateToggleLabels();

document.addEventListener('input', event => {
  if (editorFor(event.target) && !inserting) {
    dismissed = '';
    scheduleSuggestions();
  }
}, true);

document.addEventListener('compositionstart', event => {
  if (editorFor(event.target)) {
    composing = true;
    hideSuggestions();
  }
}, true);

document.addEventListener('compositionend', event => {
  if (editorFor(event.target)) {
    composing = false;
    scheduleSuggestions();
  }
}, true);

document.addEventListener('selectionchange', scheduleSuggestions);
document.addEventListener('focusin', scheduleSuggestions);

document.addEventListener('mousedown', event => {
  if (!event.composedPath().includes(host) && !editorFor(event.target)) {
    hideSuggestions();
  }
}, true);

window.addEventListener('blur', hideSuggestions);
window.addEventListener('resize', positionSuggestions);
window.addEventListener('scroll', positionSuggestions, true);

document.addEventListener('keydown', event => {
  if (event.isComposing || composing) return;

  if (
    event.code === HOTKEY.code &&
    event.ctrlKey === HOTKEY.ctrl &&
    event.shiftKey === HOTKEY.shift &&
    event.altKey === HOTKEY.alt &&
    event.metaKey === HOTKEY.meta
    ) {
    event.preventDefault();
  event.stopImmediatePropagation();

  if (!event.repeat) setEnabled(!enabled);

  return;
}

if (!current || suggestion.hidden || !editorFor(event.target)) return;

if (event.key === 'Escape') {
  event.preventDefault();
  event.stopImmediatePropagation();

  dismissed = current.context.signature;
  dismissedEditor = current.context.editor;

  hideSuggestions();
} else if (
  expanded &&
  (event.key === 'ArrowDown' || event.key === 'ArrowUp')
  ) {
  event.preventDefault();
  event.stopImmediatePropagation();

  selected = (
    selected +
    (event.key === 'ArrowDown' ? 1 : -1) +
    current.matches.length
    ) % current.matches.length;

  renderSuggestions();
} else if (
  event.key === 'Enter' &&
  !event.ctrlKey &&
  !event.altKey &&
  !event.metaKey &&
  !event.shiftKey
  ) {
  event.preventDefault();
  event.stopImmediatePropagation();

  insertPaste(current.matches[expanded ? selected : 0]);
}
}, true);

GM_registerMenuCommand('Paste Helper', openManager);

GM_registerMenuCommand(
  'Suggestions: toggle (Ctrl+Shift+Space)',
  () => setEnabled(!enabled)
  );

if (typeof GM_addValueChangeListener === 'function') {
  GM_addValueChangeListener(DB_KEY, (_key, _old, _value, remote) => {
    if (!remote) return;

    loadDatabase();
    hideSuggestions();

    if (!veil.hidden) {
      renderList();
      showPaste(pastes.find(item => item.id === selectedPasteId));

      managerStatus(
        loadError || 'Database updated in another tab.',
        Boolean(loadError)
        );
    }
  });

  GM_addValueChangeListener(ENABLED_KEY, (_key, _old, value, remote) => {
    if (!remote) return;

    enabled = value !== false;
    updateToggleLabels();

    if (!enabled) hideSuggestions();
    else scheduleSuggestions();
  });
}

if (loadError) {
  toast('Paste Helper: saved data could not be read. Open the manager to export it for recovery.');
}
})();
