"use strict";
var __edBundle = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var editor_markdown_exports = {};
  __export(editor_markdown_exports, {
    htmlToMarkdown: () => htmlToMarkdown,
    markdownToEditorHtml: () => markdownToEditorHtml,
    normalizeEditorBlocks: () => normalizeEditorBlocks,
    normalizeEditorInlineTags: () => normalizeEditorInlineTags
  });
  const BLOCK_TAGS = /* @__PURE__ */ new Set([
    "P",
    "DIV",
    "LI",
    "UL",
    "OL",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "BLOCKQUOTE",
    "PRE",
    "HR"
  ]);
  const STYLED_INLINE_TAGS = /* @__PURE__ */ new Set([
    "B",
    "STRONG",
    "I",
    "EM",
    "DEL",
    "S",
    "STRIKE",
    "U"
  ]);
  function normalizeEditorBlocks(root) {
    const document = root.ownerDocument;
    const flatten = (container) => {
      Array.from(container.childNodes).forEach((child) => {
        if (!(child instanceof HTMLElement)) {
          return;
        }
        flatten(child);
        if (child.tagName === "DIV") {
          const p = document.createElement("p");
          while (child.firstChild) {
            p.appendChild(child.firstChild);
          }
          child.replaceWith(p);
        }
      });
    };
    flatten(root);
    const inlineRun = [];
    const flush = () => {
      if (!inlineRun.length) {
        return;
      }
      const p = document.createElement("p");
      const first = inlineRun[0];
      const parent = first?.parentNode;
      if (!parent) {
        inlineRun.length = 0;
        return;
      }
      parent.insertBefore(p, first);
      inlineRun.forEach((node) => p.appendChild(node));
      inlineRun.length = 0;
    };
    Array.from(root.childNodes).forEach((node) => {
      const element = node;
      const isBlock = node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(element.tagName);
      if (isBlock) {
        flush();
      } else {
        inlineRun.push(node);
      }
    });
    flush();
    let changed = true;
    while (changed) {
      changed = false;
      root.querySelectorAll(":scope > * > *").forEach((maybeNested) => {
        if (!(maybeNested instanceof HTMLElement) || !BLOCK_TAGS.has(maybeNested.tagName)) {
          return;
        }
        const parent = maybeNested.parentElement;
        if (!parent || parent === root) {
          return;
        }
        if (parent.tagName !== "P" && parent.tagName !== "DIV") {
          return;
        }
        root.insertBefore(maybeNested, parent.nextSibling);
        changed = true;
      });
    }
  }
  function normalizeEditorInlineTags(root) {
    root.querySelectorAll("del, strike").forEach((node) => {
      const s = node.ownerDocument.createElement("s");
      while (node.firstChild) {
        s.appendChild(node.firstChild);
      }
      node.replaceWith(s);
    });
  }
  const INLINE_PATTERNS = [
    { pattern: /\*\*([^*]+)\*\*/, tag: "strong" },
    { pattern: /\*([^*]+)\*/, tag: "em" },
    { pattern: /~~([^~]+)~~/, tag: "s" },
    { pattern: /<u>([\s\S]*?)<\/u>/, tag: "u" }
  ];
  function appendInlineMarkdown(target, text) {
    const doc = target.ownerDocument;
    let best = null;
    for (const { pattern, tag } of INLINE_PATTERNS) {
      const match = pattern.exec(text);
      const content = match?.[1];
      if (match && content !== void 0 && (!best || match.index < best.index)) {
        best = {
          index: match.index,
          length: match[0].length,
          content,
          tag
        };
      }
    }
    if (!best) {
      target.appendChild(doc.createTextNode(text));
      return;
    }
    if (best.index > 0) {
      target.appendChild(doc.createTextNode(text.slice(0, best.index)));
    }
    const styled = doc.createElement(best.tag);
    appendInlineMarkdown(styled, best.content);
    target.appendChild(styled);
    appendInlineMarkdown(target, text.slice(best.index + best.length));
  }
  function markdownToEditorHtml(markdown, container) {
    container.replaceChildren();
    const doc = container.ownerDocument;
    const lines = markdown.replace(/\r/g, "").split("\n");
    const blocks = [];
    let current = [];
    for (const line of lines) {
      if (line.trim() === "") {
        if (current.length > 0) {
          blocks.push(current);
          current = [];
        }
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) {
      blocks.push(current);
    }
    for (const block of blocks) {
      const isList = block.every((line) => /^[-*+] /.test(line));
      if (isList) {
        const ul = doc.createElement("ul");
        for (const line of block) {
          const li = doc.createElement("li");
          appendInlineMarkdown(li, line.replace(/^[-*+] /, ""));
          ul.appendChild(li);
        }
        container.appendChild(ul);
        continue;
      }
      const p = doc.createElement("p");
      block.forEach((line, index) => {
        if (index > 0) {
          p.appendChild(doc.createElement("br"));
        }
        appendInlineMarkdown(p, line);
      });
      container.appendChild(p);
    }
  }
  function htmlToMarkdown(element) {
    const inlineConvert = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ?? "";
      }
      if (!(node instanceof HTMLElement)) {
        return Array.from(node.childNodes).map(inlineConvert).join("");
      }
      if (node.tagName === "BR") {
        return "\n";
      }
      if (!STYLED_INLINE_TAGS.has(node.tagName)) {
        return Array.from(node.childNodes).map(inlineConvert).join("");
      }
      const content = Array.from(node.childNodes).map(inlineConvert).join("");
      switch (node.tagName) {
        case "STRONG":
        case "B":
          return `**${content}**`;
        case "EM":
        case "I":
          return `*${content}*`;
        case "DEL":
        case "S":
        case "STRIKE":
          return `~~${content}~~`;
        case "U":
          return `<u>${content}</u>`;
        default:
          return content;
      }
    };
    const blockConvert = (node) => {
      if (!(node instanceof HTMLElement) || !BLOCK_TAGS.has(node.tagName)) {
        return inlineConvert(node);
      }
      if (node.tagName === "UL" || node.tagName === "OL") {
        return Array.from(node.childNodes).map(blockConvert).join("").trimEnd() + "\n\n";
      }
      const content = inlineConvert(node).replace(/[ \t\u00A0]+\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "").replace(/\n/g, "  \n");
      if (node.tagName === "LI") {
        return `- ${content}
`;
      }
      return `${content}

`;
    };
    return Array.from(element.childNodes).map(blockConvert).join("").replace(/\n{3,}/g, "\n\n").trim();
  }
  return __toCommonJS(editor_markdown_exports);
})();
