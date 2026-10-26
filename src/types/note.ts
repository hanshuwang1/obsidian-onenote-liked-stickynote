export interface StickyNote {
	/** 章节身份：内容哈希，与文件中的位置无关。 */
	id: string;
	title: string;
	body: string;
	/** 章节在文件中的序号，仅用于「最近的笔记」排序。 */
	index: number;
	/** 章节原文（含标题行），保存时据此重新定位。 */
	raw: string;
	/** 内容完全相同的重复章节的序号。 */
	occurrence: number;
}
