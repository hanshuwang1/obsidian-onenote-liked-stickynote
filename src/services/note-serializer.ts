import {
	locateNoteSection,
	splitNoteSections,
	type NoteLocator,
} from './note-sections';

/** 章节写回文件时的行结构：`## 标题` + 空行 + 正文。 */
function buildSectionLines(title: string, body: string): string[] {
	return [
		`## ${title.trim() || '未命名便笺'}`,
		'',
		...body.replace(/\r/g, '').split('\n'),
	];
}

/**
 * 改写一条便笺。
 *
 * 目标章节按内容（locator）重新定位，不按序号：编辑期间文件里插入/删除过
 * 别的章节时，序号已经不可信，按序号写会把内容盖到别人的卡片上。找不到
 * 目标章节（已被外部改写或删除）返回 null，调用方必须放弃写入。
 */
export function updateStickyNoteInContent(
	content: string,
	locator: NoteLocator,
	title: string,
	body: string,
): string | null {
	const target = locateNoteSection(splitNoteSections(content), locator);
	if (!target) {
		return null;
	}

	const lines = content.split(/\r?\n/);
	lines.splice(
		target.startLine,
		target.endLine - target.startLine,
		...buildSectionLines(title, body),
	);
	// 保留原文的"结尾是否有换行"：改写最后一条便笺时 splice 会吃掉末尾空行，
	// 之前的写法直接丢掉文件尾换行，每次保存都产生无意义的 diff。
	const endsWithNewline = /\r?\n$/.test(content);
	const joined = lines.join('\n').replace(/\n+$/, '');
	return endsWithNewline ? `${joined}\n` : joined;
}

/**
 * 删除一条便笺（同样按内容定位）。
 *
 * 返回 null 表示这条便笺已经不在文件里（被外部改写或删除），调用方应放弃
 * 写入——按序号盲删会删掉别人的卡片。
 */
export function removeStickyNoteFromContent(
	content: string,
	locator: NoteLocator,
): string | null {
	const target = locateNoteSection(splitNoteSections(content), locator);
	if (!target) {
		return null;
	}

	const lines = content.split(/\r?\n/);
	// 章节范围已包含紧随标题内容的空行，直接整段删掉即可，不会留下双空行。
	lines.splice(target.startLine, target.endLine - target.startLine);
	const joined = lines.join('\n').replace(/\n+$/, '');
	if (joined === '') {
		return '';
	}
	return /\r?\n$/.test(content) ? `${joined}\n` : joined;
}

export function appendStickyNote(
	content: string,
	title: string,
	body = '',
): string {
	const separator = content.trimEnd() ? '\n\n' : '';
	return `${content.trimEnd()}${separator}## ${title}\n\n${body}`;
}
