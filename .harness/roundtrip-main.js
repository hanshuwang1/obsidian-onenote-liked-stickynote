// 无头 Chrome round-trip 验证：自研确定性链路
// markdownToEditorHtml → normalize → htmlToMarkdown 的换行保真。
const ed = window.__ed;

// 规范化比较：忽略行尾空白差异（markdown 行尾两空格是合法的等价形式）、
// 首尾空白；但保留换行结构。
function normalizeLines(text) {
	return text.split('\n').map((l) => l.replace(/[ \t\u00A0]+$/, '')).join('\n').trim();
}

const cases = [];
function case_(name, md) { cases.push({ name, md }); }

case_('两行硬换行', '第一行\n第二行');
case_('两行硬换行(显式)', '第一行  \n第二行');
case_('两段落', '第一段。\n\n第二段。');
case_('多行加空行', '第一行\n\n第二行\n第三行');
case_('空正文', '');
case_('删除线', '正常~~删除~~混合');
case_('加粗斜体下划线', '**粗**正常*斜*<u>下</u>');
case_('列表', '- 甲\n- 乙\n- 丙');
case_('混合块', '段落一\n\n- 甲\n- 乙\n\n段落二**粗**');
case_('三行同段', '一\n二\n三');
case_('仅空行', '\n\n\n');

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
		const a = normalizeLines(out);
		const b = normalizeLines(out2);
		// 收敛性
		if (a !== b) {
			failures.push({ name: name + ' [不收敛]', phase1: out, phase2: out2 });
			continue;
		}
		// 源结构：换行结构必须与源一致（显式两空格形式视为等价）
		if (a !== normalizeLines(md)) {
			failures.push({ name: name + ' [源结构]', phase1: out, phase2: '(偏离源 md)' });
			continue;
		}
		pass++;
	}
} catch (error) {
	failures.push({ name: 'HARNESS_ERROR', phase1: String((error && error.stack) || error) });
}
const report = { pass, total: cases.length, failures };
document.title = 'HARNESS_DONE';
const pre = document.createElement('pre');
pre.textContent = JSON.stringify(report, null, 2);
document.body.appendChild(pre);
console.log('HARNESS_RESULT ' + JSON.stringify(report));
