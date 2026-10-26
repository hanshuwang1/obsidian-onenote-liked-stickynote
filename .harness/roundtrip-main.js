// 无头 Chrome round-trip 验证：自研确定性链路
// markdownToEditorHtml → normalize → htmlToMarkdown 的换行保真。
const ed = window.__ed;

// 新语义下的规范形式：每个非空行独立成段落；连续 `- ` 列表行保持
// 相邻行（同一 ul）。行尾空白差异忽略（markdown 两空格是合法等价形式）。
function stripTrailingWs(text) {
	return text.split('\n').map((l) => l.replace(/[ \t\u00A0]+$/, '')).join('\n').trim();
}

function canonical(md) {
	const lines = stripTrailingWs(md).split('\n').map((l) => l.trim()).filter((l) => l !== '');
	const groups = [];
	let listRun = [];
	for (const line of lines) {
		if (/^[-*+]\s+/.test(line)) {
			listRun.push(line);
			continue;
		}
		if (listRun.length) { groups.push(listRun.join('\n')); listRun = []; }
		groups.push(line);
	}
	if (listRun.length) groups.push(listRun.join('\n'));
	return groups.join('\n\n');
}

const cases = [];
function case_(name, md) { cases.push({ name, md }); }

case_('两行(单换行源)', '第一行\n第二行');
case_('两行(显式硬换行源)', '第一行  \n第二行');
case_('两段落', '第一段。\n\n第二段。');
case_('多行加空行', '第一行\n\n第二行\n第三行');
case_('空正文', '');
case_('删除线', '正常~~删除~~混合');
case_('加粗斜体下划线', '**粗**正常*斜*<u>下</u>');
case_('嵌套标记', '**粗 *斜*** 续');
case_('列表', '- 甲\n- 乙\n- 丙');
case_('混合块', '段落一\n\n- 甲\n- 乙\n\n段落二**粗**');
case_('三行同段(源)', '一\n二\n三');
case_('仅空行', '\n\n\n');
case_('CRLF 源', '第一行\r\n第二行');
case_('混排加粗跨行', '**第一行**\n第二行');

// 直接 DOM 用例：验证 normalize 拆分（Shift+ENTER 产生的 <br> 等）。
const domCases = [];
function domCase_(name, build, expected) { domCases.push({ name, build, expected }); }

domCase_('p内单个br拆分', (doc) => {
	const root = doc.createElement('div');
	const p = root.appendChild(doc.createElement('p'));
	p.append('甲', doc.createElement('br'), '乙');
	return root;
}, '甲\n\n乙');

domCase_('p内多个br拆分', (doc) => {
	const root = doc.createElement('div');
	const p = root.appendChild(doc.createElement('p'));
	p.append('一', doc.createElement('br'), '二', doc.createElement('br'), '三');
	return root;
}, '一\n\n二\n\n三');

domCase_('跨行内标签的br拆分', (doc) => {
	const root = doc.createElement('div');
	const p = root.appendChild(doc.createElement('p'));
	const b = p.appendChild(doc.createElement('b'));
	b.append('粗前', doc.createElement('br'), '粗后');
	return root;
}, '**粗前**\n\n**粗后**');

domCase_('深层嵌套行内链br拆分', (doc) => {
	const root = doc.createElement('div');
	const p = root.appendChild(doc.createElement('p'));
	const b = p.appendChild(doc.createElement('b'));
	const i = b.appendChild(doc.createElement('i'));
	i.append('x', doc.createElement('br'), 'y');
	return root;
}, '***x***\n\n***y***');

domCase_('Enter产物div兄弟', (doc) => {
	const root = doc.createElement('div');
	const d1 = root.appendChild(doc.createElement('div')); d1.textContent = '行一';
	const d2 = root.appendChild(doc.createElement('div')); d2.textContent = '行二';
	return root;
}, '行一\n\n行二');

domCase_('br前格式后半无格式', (doc) => {
	const root = doc.createElement('div');
	const p = root.appendChild(doc.createElement('p'));
	const b = p.appendChild(doc.createElement('b'));
	b.append('加粗');
	p.append(doc.createElement('br'), '普通');
	return root;
}, '**加粗**\n\n普通');

let pass = 0;
const failures = [];
try {
	for (const { name, md } of cases) {
		const roundtrip = (source) => {
			const root = document.createElement('div');
			ed.markdownToEditorHtml(source, root);
			ed.normalizeEditorInlineTags(root);
			ed.normalizeEditorBlocks(root);
			return ed.htmlToMarkdown(root);
		};
		const out = roundtrip(md);
		const out2 = roundtrip(out);
		const a = stripTrailingWs(out);
		const b = stripTrailingWs(out2);
		// 收敛性
		if (a !== b) {
			failures.push({ name: name + ' [不收敛]', phase1: out, phase2: out2 });
			continue;
		}
		// 源结构：规范形式必须一致
		if (a !== canonical(md)) {
			failures.push({ name: name + ' [源结构]', phase1: out, phase2: '(期望 ' + canonical(md) + ')' });
			continue;
		}
		pass++;
	}
	for (const { name, build, expected } of domCases) {
		const root = build(document);
		ed.normalizeEditorInlineTags(root);
		ed.normalizeEditorBlocks(root);
		const out = ed.htmlToMarkdown(root);
		if (stripTrailingWs(out) !== expected) {
			failures.push({ name: name + ' [DOM拆分]', phase1: out, phase2: '(期望 ' + expected + ')' });
			continue;
		}
		pass++;
	}
} catch (error) {
	failures.push({ name: 'HARNESS_ERROR', phase1: String((error && error.stack) || error) });
}
const report = { pass, total: cases.length + domCases.length, failures };
document.title = 'HARNESS_DONE';
const pre = document.createElement('pre');
pre.textContent = JSON.stringify(report, null, 2);
document.body.appendChild(pre);
console.log('HARNESS_RESULT ' + JSON.stringify(report));

