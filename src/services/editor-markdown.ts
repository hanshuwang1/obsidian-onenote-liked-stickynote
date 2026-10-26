/**
 * 便笺卡片编辑器（contenteditable）DOM 结构的规范化与 Markdown 序列化。
 *
 * 从视图层抽出为纯 DOM 服务：不依赖 Obsidian API，可在任意 Document 中运行，
 * 便于用无头浏览器做 round-trip 回归验证。
 */

/** Markdown 块级元素标签集。 */
const BLOCK_TAGS = new Set([
	'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
	'BLOCKQUOTE', 'PRE', 'HR',
]);

/** 行内序列化时输出 Markdown 标记/HTML 标签的元素。 */
const STYLED_INLINE_TAGS = new Set([
	'B', 'STRONG', 'I', 'EM', 'DEL', 'S', 'STRIKE', 'U',
]);

export function normalizeEditorBlocks(root: HTMLElement): void {
	const document = root.ownerDocument;

	// 递归摊平所有嵌套块级结构：div→p、嵌套 p/div/li 从父块中提升到根级，
	// 保证根的每个直接子节点恰是一个块元素。
	const flatten = (container: HTMLElement) => {
		Array.from(container.childNodes).forEach((child) => {
			if (!(child instanceof HTMLElement)) {
				return;
			}
			flatten(child);
			if (child.tagName === 'DIV') {
				const p = document.createElement('p');
				while (child.firstChild) {
					p.appendChild(child.firstChild);
				}
				child.replaceWith(p);
			}
		});
	};
	flatten(root);

	// 根级裸节点（文本、<b>、<br> 等）包成 p
	const inlineRun: Node[] = [];
	const flush = () => {
		if (!inlineRun.length) {
			return;
		}
		const p = document.createElement('p');
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
		const element = node as HTMLElement;
		const isBlock =
			node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(element.tagName);
		if (isBlock) {
			flush();
		} else {
			inlineRun.push(node);
		}
	});
	flush();

	// 块元素中若残留块元素（如 <p>a<p>b</p></p>），把内层块提升到根级；
	// 列表（ul/ol 内的 li、li 内的子列表）是合法嵌套，不动。
	let changed = true;
	while (changed) {
		changed = false;
		root.querySelectorAll(':scope > * > *').forEach((maybeNested) => {
			if (
				!(maybeNested instanceof HTMLElement) ||
				!BLOCK_TAGS.has(maybeNested.tagName)
			) {
				return;
			}
			const parent = maybeNested.parentElement;
			if (!parent || parent === root) {
				return;
			}
			if (parent.tagName !== 'P' && parent.tagName !== 'DIV') {
				return;
			}
			root.insertBefore(maybeNested, parent.nextSibling);
			changed = true;
		});
	}
}

/**
 * 把 Obsidian markdown 渲染器产出的行内标签归一为 Chromium execCommand
 * 能识别/切换的标签：~~x~~ 被渲染为 <del>，但 strikeThrough 无法解除
 * 非 Chromium 自己创建的 <del>（对 <s> 则可以正常取消），故统一改写为 <s>。
 */
export function normalizeEditorInlineTags(root: HTMLElement): void {
	root.querySelectorAll('del, strike').forEach((node) => {
		const s = node.ownerDocument.createElement('s');
		while (node.firstChild) {
			s.appendChild(node.firstChild);
		}
		node.replaceWith(s);
	});
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/** 行内标记模式：与 htmlToMarkdown 的行内序列化严格互逆。 */
const INLINE_PATTERNS: ReadonlyArray<{ pattern: RegExp; tag: string }> = [
	{ pattern: /\*\*([^*]+)\*\*/, tag: 'strong' },
	{ pattern: /\*([^*]+)\*/, tag: 'em' },
	{ pattern: /~~([^~]+)~~/, tag: 's' },
	{ pattern: /<u>([\s\S]*?)<\/u>/, tag: 'u' },
];

/**
 * 行内 markdown → DOM 节点（纯 DOM 构建，不用 innerHTML，天然免注入）。
 * 递归支持嵌套标记（如 **粗 *斜***）。
 */
function appendInlineMarkdown(target: HTMLElement, text: string): void {
	const doc = target.ownerDocument;
	let best: { index: number; length: number; content: string; tag: string } | null =
		null;
	for (const { pattern, tag } of INLINE_PATTERNS) {
		const match = pattern.exec(text);
		const content = match?.[1];
		if (match && content !== undefined && (!best || match.index < best.index)) {
			best = {
				index: match.index,
				length: match[0].length,
				content,
				tag,
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

/**
 * 便笺 markdown → 编辑器 DOM（确定性，不依赖 Obsidian 渲染器）。
 *
 * 之前编辑器复用 MarkdownRenderer，但其 DOM 形状不受控（段内换行、
 * 硬换行的输出结构随版本变化），序列化回来会丢换行。这里用与
 * htmlToMarkdown 严格互逆的规则自行构建：
 * - 空行分块；每块要么全为 `- ` 列表行（→ ul/li），要么是一个段落；
 * - 段内行以 <br> 连接（保存时序列化为硬换行 `  \n`）。
 */
export function markdownToEditorHtml(
	markdown: string,
	container: HTMLElement,
): void {
	container.replaceChildren();
	const doc = container.ownerDocument;
	const lines = markdown.replace(/\r/g, '').split('\n');

	const blocks: string[][] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (line.trim() === '') {
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
			const ul = doc.createElement('ul');
			for (const line of block) {
				const li = doc.createElement('li');
				appendInlineMarkdown(li, line.replace(/^[-*+] /, ''));
				ul.appendChild(li);
			}
			container.appendChild(ul);
			continue;
		}
		const p = doc.createElement('p');
		block.forEach((line, index) => {
			if (index > 0) {
				p.appendChild(doc.createElement('br'));
			}
			appendInlineMarkdown(p, line);
		});
		container.appendChild(p);
	}
}

/**
 * 编辑器 DOM → Markdown。
 *
 * 换行语义：`<p>` 之间输出空行（段落边界）；`<p>` 内部的 `<br>` 输出
 * 行尾两空格 + 换行（Markdown 硬换行）。空段落输出空行。Obsidian 默认
 * （非严格换行）把段内单个 `\n` 渲染为空格，因此单个 `\n` 会在重新
 * 渲染时丢失换行 —— 段内换行必须写成硬换行。
 */
export function htmlToMarkdown(element: HTMLElement): string {
	const inlineConvert = (node: Node): string => {
		if (node.nodeType === Node.TEXT_NODE) {
			return node.textContent ?? '';
		}
		if (!(node instanceof HTMLElement)) {
			return Array.from(node.childNodes).map(inlineConvert).join('');
		}
		if (node.tagName === 'BR') {
			return '\n';
		}
		if (!STYLED_INLINE_TAGS.has(node.tagName)) {
			// 未加标记的元素（<span>、<code> 等）直接拼接子内容。
			return Array.from(node.childNodes).map(inlineConvert).join('');
		}
		const content = Array.from(node.childNodes)
			.map(inlineConvert)
			.join('');
		switch (node.tagName) {
			case 'STRONG':
			case 'B':
				return `**${content}**`;
			case 'EM':
			case 'I':
				return `*${content}*`;
			case 'DEL':
			case 'S':
			case 'STRIKE':
				return `~~${content}~~`;
			case 'U':
				return `<u>${content}</u>`;
			default:
				return content;
		}
	};

	const blockConvert = (node: Node): string => {
		if (!(node instanceof HTMLElement) || !BLOCK_TAGS.has(node.tagName)) {
			return inlineConvert(node);
		}

		if (node.tagName === 'UL' || node.tagName === 'OL') {
			// 列表后同样输出空行分隔，否则紧随的段落会被拼到最后一项同一行。
			return (
				Array.from(node.childNodes)
					.map(blockConvert)
					.join('')
					.trimEnd() + '\n\n'
			);
		}

		// 行首/行尾的 <br> 是残留结构（空行除外），去掉再按段落语义拼接。
		const content = inlineConvert(node)
			.replace(/[ \t\u00A0]+\n/g, '\n')
			.replace(/^\n+/, '')
			.replace(/\n+$/, '')
			.replace(/\n/g, '  \n');
		if (node.tagName === 'LI') {
			return `- ${content}\n`;
		}
		return `${content}\n\n`;
	};

	return Array.from(element.childNodes)
		.map(blockConvert)
		.join('')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
