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

/**
 * 跨窗口安全的“元素节点”判定。
 *
 * Obsidian 的 popout 是 window.open 出来的独立 window，也就是独立的 realm：
 * 它的 HTMLElement 与主窗口的不是同一个构造函数，`node instanceof HTMLElement`
 * 在弹窗里恒为 false。而弹窗正是本插件唯一的运行环境，这类判断一旦失效，
 * 归一化与序列化会整体静默退化——嵌套块不展开、块边界被当成行内内容拼接、
 * `<b>` 等格式标记被丢弃，表现为“回车换行全部丢失、正文并成一行”。
 *
 * `nodeType` 是数值常量（1 = ELEMENT_NODE），跨 realm 永远成立。
 */
function isElementNode(node: Node): node is HTMLElement {
	return node.nodeType === Node.ELEMENT_NODE;
}

export function normalizeEditorBlocks(root: HTMLElement): void {
	const document = root.ownerDocument;

	// 递归摊平所有嵌套块级结构：div→p、嵌套 p/div/li 从父块中提升到根级，
	// 保证根的每个直接子节点恰是一个块元素。
	const flatten = (container: HTMLElement) => {
		Array.from(container.childNodes).forEach((child) => {
			if (!isElementNode(child)) {
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
			if (!isElementNode(maybeNested) || !BLOCK_TAGS.has(maybeNested.tagName)) {
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

	// 把 p/li 内的 <br>（Shift+Enter 产生）拆成兄弟块，使每个块恰是
	// “一行”。br 与块之间可能隔着行内标签（<b>a<br>b</b>），拆分时
	// 克隆行内祖先链，前后两半各自保持格式。祖先链中出现块标签则说明
	// 该 br 属于嵌套块内部（由其宿主块自行处理），跳过。
	// 逐个重新查询：拆分会新建块、搬移节点，快照式遍历会漏掉新块里
	// 后续的 br；isConnected 不可用（root 可能游离于文档之外）。
	let br: HTMLBRElement | null = root.querySelector('p br, li br');
	while (br) {
		const block = br.closest('p, li');
		if (!block) {
			break;
		}
		const chain: HTMLElement[] = [];
		let escaped = false;
		for (let cur = br.parentNode; cur && cur !== block; cur = cur.parentNode) {
			if (!isElementNode(cur) || BLOCK_TAGS.has(cur.tagName)) {
				escaped = true;
				break;
			}
			chain.unshift(cur);
		}
		if (escaped || (br.parentNode === null)) {
			break;
		}
		const doc = root.ownerDocument;
		const newBlock = doc.createElement(block.tagName);
		const afterHosts: HTMLElement[] = [newBlock];
		for (const ancestor of chain) {
			const clone = ancestor.cloneNode(false) as HTMLElement;
			(afterHosts[afterHosts.length - 1] ?? newBlock).appendChild(clone);
			afterHosts.push(clone);
		}
		// 自内向外逐层：把“当前节点”之后的兄弟搬入对应克隆层。
		// j = chain.length 对应最内层克隆（chain 为空时即 newBlock 本体，
		// 承接 br 的直接兄弟）；j 递减到 0 时承接 c0 之后的块级兄弟。
		let current: Node = br;
		for (let j = chain.length; j >= 0; j--) {
			const host = afterHosts[j] ?? newBlock;
			const siblings: Node[] = [];
			for (let sib = current.nextSibling; sib; sib = sib.nextSibling) {
				siblings.push(sib);
			}
			for (const sib of siblings) {
				host.appendChild(sib);
			}
			if (j > 0) {
				current = chain[j - 1] as Node;
			}
		}
		br.remove();
		block.parentNode?.insertBefore(newBlock, block.nextSibling);
		br = root.querySelector('p br, li br');
	}
}

/**
 * 把编辑器内可能出现的行内标签归一为 Chromium execCommand 能识别/切换
 * 的标签：~~x~~ 的 <del>、markdown 渲染器的 <strong>/<em> 都统一改写为
 * <s>/<b>/<i>（unstrike/unbold 对非 Chromium 自建标签不可靠）。
 */
export function normalizeEditorInlineTags(root: HTMLElement): void {
	const replacements: Record<string, string> = {
		del: 's',
		strike: 's',
		strong: 'b',
		em: 'i',
	};
	root.querySelectorAll('del, strike, strong, em').forEach((node) => {
		const replacementTag = replacements[node.tagName.toLowerCase()];
		if (!replacementTag) return;
		const replacement = node.ownerDocument.createElement(replacementTag);
		while (node.firstChild) {
			replacement.appendChild(node.firstChild);
		}
		node.replaceWith(replacement);
	});
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/** 行内标记模式：与 htmlToMarkdown 的行内序列化严格互逆。产出标签
 * 统一为 Chromium execCommand 可靠切换的 b/i/s/u。
 */
const INLINE_PATTERNS: ReadonlyArray<{ pattern: RegExp; tag: string }> = [
	{ pattern: /\*\*([^*]+)\*\*/, tag: 'b' },
	{ pattern: /\*([^*]+)\*/, tag: 'i' },
	{ pattern: /~~([^~]+)~~/, tag: 's' },
	{ pattern: /<u>([\s\S]*?)<\/u>/, tag: 'u' },
];

/** 行内 markdown → DOM 节点（纯 DOM 构建，不用 innerHTML，天然免注入）。
 * 递归支持嵌套标记（如 **粗 *斜***）。产出标签用 b/i/s/u（而非
 * strong/em/del）：编辑器靠 Chromium execCommand 切换格式，unbold/
 * unstrike 对非 Chromium 自建标签（strong/del）不可靠。
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
 * htmlToMarkdown 严格互逆的规则自行构建：**每个非空行独立成块**——
 * `- ` 开头的行 → ul/li，其余行 → <p>。空行只是分隔符，不保留
 * （保存时所有行边界统一写为段落边界）。
 */
export function markdownToEditorHtml(
	markdown: string,
	container: HTMLElement,
): void {
	container.replaceChildren();
	const doc = container.ownerDocument;
	const lines = markdown.replace(/\r/g, '').split('\n');

	let ul: HTMLUListElement | null = null;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line === '') {
			ul = null;
			continue;
		}
		const listMatch = line.match(/^[-*+]\s+(.*)$/);
		if (listMatch) {
			if (!ul) {
				ul = doc.createElement('ul');
				container.appendChild(ul);
			}
			const li = doc.createElement('li');
			appendInlineMarkdown(li, listMatch[1] ?? '');
			ul.appendChild(li);
			continue;
		}
		ul = null;
		const p = doc.createElement('p');
		appendInlineMarkdown(p, line);
		container.appendChild(p);
	}
}

/**
 * 编辑器 DOM → Markdown。
 *
 * 换行语义：`<p>`/`<li>` 边界输出空行（段落边界）。行尾两空格硬换行
 * 依赖渲染器保留行尾空白，在 Linter 类插件/编辑器自动裁剪下会退化为
 * 单 `\n`，非严格换行设置下重渲染就会折叠成一行——因此段内换行
 * （Shift+Enter 的 `<br>` 已在 normalize 阶段拆成独立块）统一序列化
 * 为段落边界，完全不依赖行尾空格。
 */
export function htmlToMarkdown(element: HTMLElement): string {
	const inlineConvert = (node: Node): string => {
		if (node.nodeType === Node.TEXT_NODE) {
			return node.textContent ?? '';
		}
		if (!isElementNode(node)) {
			// 非元素节点（文本已在上方处理，其余如注释节点）直接拼接子内容。
			return Array.from(node.childNodes).map(inlineConvert).join('');
		}
		if (node.tagName === 'BR') {
			return '\n';
		}
		if (BLOCK_TAGS.has(node.tagName)) {
			// 兜底：块级元素出现在行内位置（normalize 被跳过或 DOM 形状超出
			// 预期）时，仍用段落边界隔开，绝不让两行静默拼成一行。
			// 不递归到 blockConvert：它会回头用 inlineConvert 处理同一节点，
			// 形成无限递归。
			const inner = Array.from(node.childNodes).map(inlineConvert).join('');
			return `\n\n${inner}\n\n`;
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
		if (!isElementNode(node) || !BLOCK_TAGS.has(node.tagName)) {
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
		// （normalize 阶段已把段内 <br> 拆成独立块，此处理论无 `\n`；
		// 兜底仍按段落边界处理，绝不再产出依赖行尾空格的硬换行。）
		const content = inlineConvert(node)
			.replace(/[ \t\u00A0]+\n/g, '\n')
			.replace(/^\n+/, '')
			.replace(/\n+$/, '')
			.replace(/\n/g, '\n\n');
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
