const headingPattern = /^##\s+(.+?)\s*$/;

function getHeadingIndexes(lines: string[]): number[] {
	return lines.reduce<number[]>((indexes, line, index) => {
		if (headingPattern.test(line)) {
			indexes.push(index);
		}
		return indexes;
	}, []);
}

export function updateStickyNoteInContent(
	content: string,
	noteIndex: number,
	title: string,
	body: string,
): string {
	const lines = content.split(/\r?\n/);
	const headingIndexes = getHeadingIndexes(lines);
	const start = headingIndexes[noteIndex];
	if (start === undefined) {
		return content;
	}

	const end = headingIndexes[noteIndex + 1] ?? lines.length;
	const replacement = [`## ${title.trim() || '未命名便笺'}`, '', ...body.replace(/\r/g, '').split('\n')];
	lines.splice(start, end - start, ...replacement);
	return lines.join('\n').replace(/\n+$/, '\n');
}

export function appendStickyNote(
	content: string,
	title: string,
	body = '',
): string {
	const separator = content.trimEnd() ? '\n\n' : '';
	return `${content.trimEnd()}${separator}## ${title}\n\n${body}`;
}
