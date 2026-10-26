// 真实键盘 + execCommand 格式按钮组合场景（复刻 renderEditor 的完整 DOM 结构）
const path = require('path');

(async () => {
	const puppeteer = require('puppeteer-core');
	const browser = await puppeteer.launch({
		executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
		headless: 'new',
		args: ['--disable-gpu'],
	});
	const page = await browser.newPage();
	const url = 'file:///' + path.resolve(__dirname, 'realkeys-page.html').replace(/\\/g, '/');
	await page.goto(url);

	// 完整复刻 renderEditor：markdownToEditorHtml + inlineTags 归一 + placeCaretAtEnd + focus
	const setup = (initialMd) => page.evaluate((md) => {
		const ed = window.__ed;
		document.querySelectorAll('[contenteditable]').forEach((n) => n.remove());
		const card = document.createElement('div');
		card.className = 'onenote-sticky-note-card onenote-sticky-note-card-editing';
		const container = document.createElement('div');
		container.className = 'onenote-sticky-note-editor-body';
		container.setAttribute('contenteditable', 'true');
		card.appendChild(container);
		document.body.appendChild(card);
		ed.markdownToEditorHtml(md, container);
		ed.normalizeEditorInlineTags(container);
		// placeCaretAtEnd 复刻
		const selection = document.getSelection();
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		let lastTextNode = walker.nextNode();
		while (walker.nextNode()) lastTextNode = walker.currentNode;
		if (lastTextNode) {
			const range = document.createRange();
			range.setStart(lastTextNode, lastTextNode.textContent.length);
			range.collapse(true);
			selection.removeAllRanges();
			selection.addRange(range);
		}
		container.focus();
		return container.innerHTML;
	}, initialMd);

	// toggleLineFormat 复刻：getCurrentLineElement + select line + execCommand + restoreCaret
	const toggleFormat = (command) => page.evaluate((cmd) => {
		const input = document.querySelector('[contenteditable]');
		const selection = document.getSelection();
		const anchorNode = selection.anchorNode;
		const anchorElement = anchorNode instanceof HTMLElement ? anchorNode : anchorNode?.parentElement;
		const lineElement = anchorElement?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, div') ?? null;
		if (!lineElement) return 'noline';
		// getTextOffset 复刻
		const getTextOffset = (root, node, offset) => {
			if (!node || !root.contains(node)) return 0;
			const range = document.createRange();
			range.selectNodeContents(root);
			range.setEnd(node, offset);
			return range.toString().length;
		};
		const caretOffset = getTextOffset(lineElement, selection.anchorNode, selection.anchorOffset);
		const lineRange = document.createRange();
		lineRange.selectNodeContents(lineElement);
		selection.removeAllRanges();
		selection.addRange(lineRange);
		document.execCommand(cmd);
		// restoreCaret 复刻
		const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT);
		let remaining = caretOffset;
		let textNode = walker.nextNode();
		while (textNode) {
			const length = textNode.textContent.length;
			if (remaining <= length) {
				const range = document.createRange();
				range.setStart(textNode, remaining);
				range.collapse(true);
				selection.removeAllRanges();
				selection.addRange(range);
				return 'ok:' + input.innerHTML;
			}
			remaining -= length;
			textNode = walker.nextNode();
		}
		return 'nocaret:' + input.innerHTML;
	}, command);

	const save = () => page.evaluate(() => {
		const ed = window.__ed;
		const container = document.querySelector('[contenteditable]');
		ed.normalizeEditorBlocks(container);
		return { dom: container.innerHTML, md: ed.htmlToMarkdown(container) };
	});

	// 场景C：空便笺 → 输入 → 加粗该行 → 回车 → 输入第二行 → 保存
	console.log('C setup:', await setup(''));
	await page.keyboard.type('第一行内容');
	console.log('C bold:', await toggleFormat('bold'));
	await page.keyboard.press('Enter');
	await page.keyboard.type('第二行内容');
	console.log('C save:', JSON.stringify(await save()));

	// 场景D：已有加粗+两行 → 打开 → 回车 → 第三行 → 保存（上轮 bug 的重测）
	console.log('D setup:', await setup('**粗体行**\n普通行'));
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await page.keyboard.type('第三行');
	console.log('D save:', JSON.stringify(await save()));

	// 场景E：对已有加粗行取消加粗后回车
	console.log('E setup:', await setup('**要取消的行**'));
	await page.keyboard.press('Home');
	console.log('E unbold:', await toggleFormat('bold'));
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await page.keyboard.type('新行');
	console.log('E save:', JSON.stringify(await save()));

	// 场景F：删除线往返（上上轮 bug）
	console.log('F setup:', await setup('~~删除行~~'));
	await page.keyboard.press('Home');
	console.log('F unstrike:', await toggleFormat('strikeThrough'));
	console.log('F save:', JSON.stringify(await save()));

	// 场景G（新语义回归）：用户原始 bug 场景——空便笺输入一行、Enter、
	// 输入第二行、保存。期望两行以段落边界（\n\n）持久化，重开后仍是两行。
	console.log('G setup:', await setup(''));
	await page.keyboard.type('第一行');
	await page.keyboard.press('Enter');
	await page.keyboard.type('第二行');
	console.log('G save:', JSON.stringify(await save()));

	// 场景H：Shift+Enter（软换行）→ 保存 → 重开 → 再保存，期望收敛。
	console.log('H setup:', await setup(''));
	await page.keyboard.type('软换行前');
	await page.keyboard.down('Shift');
	await page.keyboard.press('Enter');
	await page.keyboard.up('Shift');
	await page.keyboard.type('软换行后');
	const h1 = await save();
	console.log('H save1:', JSON.stringify(h1));
	console.log('H setup2:', await setup(h1.md));
	const h2 = await save();
	console.log('H save2:', JSON.stringify(h2));
	console.log('H 收敛:', h1.md === h2.md);

	// 场景I：三行 + 中间空行 + 列表，保存后重开再保存（收敛 + 行数保真）
	const iMd = '行一\n\n- 列甲\n- 列乙\n\n行二';
	console.log('I setup:', await setup(iMd));
	const i1 = await save();
	console.log('I save1:', JSON.stringify(i1));
	console.log('I setup2:', await setup(i1.md));
	const i2 = await save();
	console.log('I save2:', JSON.stringify(i2));
	console.log('I 收敛:', i1.md === i2.md);

	await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
