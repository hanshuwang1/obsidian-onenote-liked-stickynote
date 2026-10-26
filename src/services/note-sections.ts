/**
 * 便笺集合文件的章节切分与定位。
 *
 * 解析（note-parser）与序列化（note-serializer）共用这一份实现：两边各写
 * 一遍标题正则，规则一改就会出现"读得出来、写不回去"的偏差。
 *
 * 章节身份用内容（raw）而不是序号：文件里插入/删除别的章节后序号会整体
 * 移位，按序号保存会把内容写到别人的卡片上；而内容只有在"这一条真的被
 * 改动过"时才会变，此时也应拒绝写入（见 locateNoteSection 的返回值约定）。
 */

/** 二级标题：便笺的分隔符。 */
const headingPattern = /^##\s+(.+?)\s*$/;

export interface MarkdownNoteSection {
	/** 章节起始行（含标题行）。 */
	startLine: number;
	/** 章节结束行（不含下一标题行）。 */
	endLine: number;
	title: string;
	body: string;
	/** 章节原文（标题行 + 正文，行以 \n 连接）。 */
	raw: string;
}

/** 把整篇内容切成便笺章节；第一个二级标题之前的内容不属于任何便笺。 */
export function splitNoteSections(content: string): MarkdownNoteSection[] {
	const lines = content.split(/\r?\n/);
	const sections: MarkdownNoteSection[] = [];
	let open: { title: string; startLine: number } | null = null;

	const closeOpenSection = (endLine: number) => {
		if (!open) {
			return;
		}
		const rawLines = lines.slice(open.startLine, endLine);
		sections.push({
			startLine: open.startLine,
			endLine,
			title: open.title,
			body: rawLines.slice(1).join('\n').trim(),
			raw: rawLines.join('\n'),
		});
	};

	for (const [index, line] of lines.entries()) {
		const headingMatch = line.match(headingPattern);
		if (!headingMatch) {
			continue;
		}
		closeOpenSection(index);
		open = { title: headingMatch[1] ?? '', startLine: index };
	}
	closeOpenSection(lines.length);

	return sections;
}

/** 章节身份：内容哈希（+ 完全重复时的出现序号），与章节在文件中的位置无关。 */
export function makeNoteId(
	filePath: string,
	raw: string,
	occurrence: number,
): string {
	const suffix = occurrence > 0 ? `~${occurrence}` : '';
	return `${filePath}#${hashString(raw)}${suffix}`;
}

/** 保存时用来在最新内容里重新找到同一个章节。 */
export interface NoteLocator {
	/** 打开编辑器那一刻该章节的原文。 */
	raw: string;
	/** 内容完全相同的章节的序号。 */
	occurrence: number;
}

/**
 * 在最新内容里重新定位章节；找不到说明这条已经在文件里被改写或删除，
 * 返回 null，调用方必须放弃写入——退化成按序号覆盖会写坏别人的卡片。
 */
export function locateNoteSection(
	sections: MarkdownNoteSection[],
	locator: NoteLocator,
): MarkdownNoteSection | null {
	const matches = sections.filter((section) => section.raw === locator.raw);
	return matches[locator.occurrence] ?? null;
}

/** 32 位滚动哈希（djb2），只用于给章节生成稳定短 id。 */
function hashString(value: string): string {
	let hash = 5381;
	for (let index = 0; index < value.length; index++) {
		hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
	}
	return (hash >>> 0).toString(36);
}
