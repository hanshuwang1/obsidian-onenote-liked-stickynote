import type { StickyNote } from '../types/note';
import { makeNoteId, splitNoteSections } from './note-sections';

/**
 * 把便笺集合文件解析成卡片。
 *
 * id 由章节内容哈希生成，不再依赖数组下标：文件里插入/删除别的章节时，
 * 已经打开编辑器的卡片仍然指向原来那一条。
 */
export function parseStickyNotes(
	content: string,
	filePath: string,
): StickyNote[] {
	const occurrences = new Map<string, number>();

	return splitNoteSections(content).map((section, index) => {
		const occurrence = occurrences.get(section.raw) ?? 0;
		occurrences.set(section.raw, occurrence + 1);

		return {
			id: makeNoteId(filePath, section.raw, occurrence),
			title: section.title,
			body: section.body,
			index,
			raw: section.raw,
			occurrence,
		};
	});
}

/**
 * 标题本身就是时间戳时（"新建便笺"写入的 `YYYY-MM-DD HH:mm`）取它当创建时间。
 *
 * 文件里没有可靠的单条便笺时间来源，而整文件 mtime 会让所有卡片显示同一个
 * 日期，所以这里把能确定的时间尽量用上，确定不了就返回 null（不显示日期）。
 */
export function parseTitleTimestamp(title: string): number | null {
	const match = title
		.trim()
		.match(
			/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$|^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/,
		);
	if (!match) {
		return null;
	}

	const [
		,
		year,
		month,
		day,
		hour,
		minute,
		compactYear,
		compactMonth,
		compactDay,
		compactHour,
		compactMinute,
	] = match;
	const parts = {
		year: Number(year ?? compactYear),
		month: Number(month ?? compactMonth),
		day: Number(day ?? compactDay),
		hour: Number(hour ?? compactHour ?? 0),
		minute: Number(minute ?? compactMinute ?? 0),
	};
	if (
		!Number.isInteger(parts.year) ||
		parts.month < 1 ||
		parts.month > 12 ||
		parts.day < 1 ||
		parts.day > 31 ||
		parts.hour > 23 ||
		parts.minute > 59
	) {
		return null;
	}

	const date = new Date(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
	);
	return Number.isNaN(date.getTime()) ? null : date.getTime();
}
