export interface StickyNotesSettings {
	collectionFile: string;
	popoutWidth: number;
	popoutHeight: number;
	/**
	 * 便笺最近一次「在本插件里保存」的时间戳（毫秒），键是便笺的内容哈希 id。
	 *
	 * 文件里没有可靠的单条便笺时间来源：整文件 mtime 会让所有卡片显示同一个
	 * 日期，所以在插件侧记下每条便笺自己的保存时间；哈希 id 变了（内容被外部
	 * 改写）就丢弃旧记录，宁可暂时不显示日期，也不显示错的时间。
	 */
	noteModified: Record<string, number>;
}
