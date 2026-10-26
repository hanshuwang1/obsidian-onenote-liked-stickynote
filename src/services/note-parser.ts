import type { StickyNote } from '../types/note';

const headingPattern = /^##\s+(.+?)\s*$/;

export function parseStickyNotes(content: string, filePath: string): StickyNote[] {
	const lines = content.split(/\r?\n/);
	const notes: StickyNote[] = [];
	let currentTitle: string | null = null;
	let currentBody: string[] = [];

	const appendCurrentNote = () => {
		if (currentTitle === null) {
			return;
		}

		const index = notes.length;
		notes.push({
			id: `${filePath}:${index}`,
			title: currentTitle,
			body: currentBody.join('\n').trim(),
			index,
		});
	};

	for (const line of lines) {
		const headingMatch = line.match(headingPattern);
		if (headingMatch) {
			appendCurrentNote();
			const title = headingMatch[1];
            if (title === undefined) {
                continue;
            }

            currentTitle = title;
			currentBody = [];
			continue;
		}

		if (currentTitle !== null) {
			currentBody.push(line);
		}
	}

	appendCurrentNote();
	return notes;
}
