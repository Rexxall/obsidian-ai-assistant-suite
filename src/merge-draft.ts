// Two notes → one merge draft. The AI only proposes which blocks say the same thing and which
// contradict each other; every line of the draft is copied from the notes by this code, so nothing
// can be reworded, dropped or invented. The two source notes are never written to.

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;

/** Frontmatter text (without the fences) and the body after it. */
export function splitFrontmatter(text) {
	const match = String(text || '').match(FRONTMATTER);
	return match ? { yaml: match[1], body: text.slice(match[0].length) } : { yaml: '', body: String(text || '') };
}

/**
 * The body cut into blocks a reader would see as one unit: a paragraph, a heading, one top-level
 * list item with its children, a quote or callout, a table, a fenced code or math block.
 */
export function splitBlocks(body) {
	const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
	const blocks = [];
	let current = null;
	const close = () => {
		if (current && current.lines.some(l => l.trim())) blocks.push({ kind: current.kind, text: current.lines.join('\n').replace(/\s+$/, '') });
		current = null;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fence = line.match(FENCE) || (line.trim() === '$$' ? [line, '$$'] : null);
		if (fence) {
			close();
			const marker = fence[1];
			const block = [line];
			while (++i < lines.length) {
				block.push(lines[i]);
				if (marker === '$$' ? lines[i].trim() === '$$' : lines[i].trim().startsWith(marker)) break;
			}
			blocks.push({ kind: 'code', text: block.join('\n') });
			continue;
		}
		if (!line.trim()) { close(); continue; }
		if (/^#{1,6}\s/.test(line)) { close(); blocks.push({ kind: 'heading', text: line.trim() }); continue; }
		const kind = /^>/.test(line) ? 'quote' : /^\s*\|/.test(line) ? 'table' : LIST_ITEM.test(line) ? 'item' : /^\s/.test(line) && current?.kind === 'item' ? 'item' : 'text';
		// A new top-level list item, or a change between quote, table and plain text, starts a new block.
		const startsItem = LIST_ITEM.test(line);
		const continues = current && (kind === current.kind || (current.kind === 'item' && /^\s/.test(line))) && !startsItem;
		if (!continues) close();
		if (!current) current = { kind: startsItem ? 'item' : kind, lines: [] };
		current.lines.push(line);
	}
	close();
	return blocks;
}

const normalise = text => String(text).replace(/\s+/g, ' ').trim();

/** Blocks of both notes with ids (A1…, B1…); blocks identical after collapsing spaces are paired here. */
export function prepareBlocks(bodyA, bodyB) {
	const a = splitBlocks(bodyA).map((b, i) => ({ ...b, id: `A${i + 1}` }));
	const b = splitBlocks(bodyB).map((x, i) => ({ ...x, id: `B${i + 1}` }));
	const identical = [];
	const takenB = new Set();
	for (const block of a) {
		const twin = b.find(other => !takenB.has(other.id) && normalise(other.text) === normalise(block.text));
		if (twin) { takenB.add(twin.id); identical.push({ a: block.id, b: twin.id }); }
	}
	return { a, b, identical };
}

/** Why these two notes cannot be merged as they are, or '' when they can. */
export function blocker(textA, textB, limit = 60000) {
	const footnote = /^\[\^[^\]]+\]:/m;
	if (footnote.test(textA) || footnote.test(textB)) return 'footnotes';
	const { body: a } = splitFrontmatter(textA);
	const { body: b } = splitFrontmatter(textB);
	if (!a.trim() || !b.trim()) return 'empty';
	if (a.length + b.length > limit) return 'too-long';
	return '';
}

/** The request: only the blocks that were not already paired, each with its id. */
export function buildPrompt({ nameA, nameB, a, b, identical, english }) {
	const pairedA = new Set(identical.map(p => p.a));
	const pairedB = new Set(identical.map(p => p.b));
	const list = blocks => blocks.map(x => `[${x.id}]${x.kind === 'heading' ? ' (heading)' : ''}\n${x.text}`).join('\n\n');
	const restA = a.filter(x => !pairedA.has(x.id));
	const restB = b.filter(x => !pairedB.has(x.id));
	const rules = english
		? `Compare two notes block by block. Do not rewrite anything; only refer to block ids.

Return one JSON object: {"groups":[{"type":"same"|"conflict","title":"short title","a":["A3"],"b":["B2"],"why":"one sentence"}]}

- "same": blocks in A and B that say the same thing in different words. Related topics are not enough.
- "conflict": A and B state different facts about the same thing: numbers, dates, names, conditions, a negation, or opposite opinions. "why" says exactly what differs. Do not decide which one is right.
- If two blocks are about the same thing but any number, date, amount or condition differs, it is a "conflict", never "same".
- Every group has at least one A id and one B id. Use each id at most once. Leave out blocks that have no partner.
- "title": 2–8 words naming the shared subject, in the language of the notes.
- In "why", call the notes A and B; never write block ids such as A3.`
		: `逐块比较两篇笔记。不要改写任何文字，只引用块编号。

只返回一个 JSON 对象：{"groups":[{"type":"same"|"conflict","title":"短标题","a":["A3"],"b":["B2"],"why":"一句话"}]}

- "same"：A 和 B 里换了说法、意思相同的块。只是话题相关不算。
- "conflict"：A 和 B 对同一件事说法不一致：数字、日期、名字、条件、否定，或相反的观点。"why" 写清楚哪里不一致。不要判断谁对。
- 两块讲的是同一件事，但数字、日期、金额或条件有任何不同，就是 "conflict"，不能算 "same"。
- 每组至少有一个 A 的编号和一个 B 的编号。每个编号最多用一次。找不到对应的块不要写。
- "title"：2～12 个字，点出两边共同说的事，用笔记本身的语言。
- "why" 里用 A、B 称呼两篇笔记，不要写 A3 这样的块编号。`;
	return `${rules}

=== A: ${nameA} ===
${list(restA) || '(none)'}

=== B: ${nameB} ===
${list(restB) || '(none)'}`;
}

/** The model's groups, checked: unknown ids, ids used twice and one-sided groups are dropped. */
export function parseGroups(reply, { a, b, identical }) {
	let data;
	const text = String(reply || '').trim();
	try {
		data = JSON.parse(text);
	} catch {
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) throw Object.assign(new Error('The AI reply was not JSON.'), { kind: 'empty' });
		data = JSON.parse(match[0]);
	}
	const known = new Set([...a, ...b].map(x => x.id));
	const used = new Set(identical.flatMap(p => [p.a, p.b]));
	const groups = [];
	for (const raw of Array.isArray(data?.groups) ? data.groups : []) {
		const type = raw?.type === 'conflict' ? 'conflict' : raw?.type === 'same' ? 'same' : null;
		if (!type) continue;
		const take = (ids, side) => (Array.isArray(ids) ? ids : []).map(String).filter(id => id.startsWith(side) && known.has(id) && !used.has(id));
		const ga = [...new Set(take(raw.a, 'A'))];
		const gb = [...new Set(take(raw.b, 'B'))];
		if (!ga.length || !gb.length) continue;
		for (const id of [...ga, ...gb]) used.add(id);
		const order = (ids, list) => ids.sort((x, y) => list.findIndex(v => v.id === x) - list.findIndex(v => v.id === y));
		// 块编号对读者没有意义：万一模型还是写了，去掉数字只留 A、B
		const why = String(raw.why || '').replace(/\b([AB])\d+\b/g, '$1').trim().slice(0, 300);
		groups.push({ type, title: String(raw.title || '').trim().slice(0, 60), why, a: order(ga, a), b: order(gb, b) });
	}
	return groups;
}

const quote = text => text.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');

/**
 * The draft note. `link(side)` gives the wikilink to note A or B; `labels` holds the interface words.
 * Order: conflicts first (they need a decision), then shared content, then what only one note has.
 */
export function assembleDraft({ a, b, identical, groups, yamlA, yamlB, link, labels, date }) {
	// 原文的标题降三级放进草稿，免得和草稿自己的小节（## 和 ###）混在一起
	const demote = x => (x.kind === 'heading' ? { ...x, text: x.text.replace(/^(#{1,6})/, m => '#'.repeat(Math.min(6, m.length + 3))) } : x);
	a = a.map(demote);
	b = b.map(demote);
	const byId = new Map([...a, ...b].map(x => [x.id, x]));
	const texts = ids => ids.map(id => byId.get(id).text).join('\n\n');
	const inGroup = new Set([...identical.flatMap(p => [p.a, p.b]), ...groups.flatMap(g => [...g.a, ...g.b])]);
	const conflicts = groups.filter(g => g.type === 'conflict');
	const same = groups.filter(g => g.type === 'same');
	const onlyA = a.filter(x => !inGroup.has(x.id));
	const onlyB = b.filter(x => !inGroup.has(x.id));
	const out = [];
	const yamlString = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	out.push('---', 'merge-draft: true', 'merged-from:', `  - ${yamlString(link('A'))}`, `  - ${yamlString(link('B'))}`, `merged-at: ${date}`, '---', '');
	out.push(`> [!info] ${labels.draftTitle}`, `> ${labels.draftIntro(`A ${link('A')}`, `B ${link('B')}`)}`, '');
	if (conflicts.length) {
		out.push(`## ${labels.conflicts}${labels.count(conflicts.length)}`, '');
		for (const g of conflicts) {
			out.push(`### ${g.title || labels.untitled}`, '');
			if (g.why) out.push(`*${labels.aiNote}* ${g.why}`, '');
			out.push(`**A · ${link('A')}**`, '', texts(g.a), '', `**B · ${link('B')}**`, '', texts(g.b), '');
		}
	}
	if (same.length || identical.length) {
		out.push(`## ${labels.shared}${labels.count(same.length + identical.length)}`, '');
		for (const g of same) {
			out.push(`### ${g.title || labels.untitled}`, '', texts(g.a), '', `> [!quote]- ${labels.otherWording(link('B'))}`, quote(texts(g.b)), '', `<small>${labels.source}${link('A')} · ${link('B')}</small>`, '');
		}
		if (identical.length) {
			out.push(`### ${labels.identical}`, '', identical.map(p => byId.get(p.a).text).join('\n\n'), '', `<small>${labels.source}${link('A')} · ${link('B')}</small>`, '');
		}
	}
	if (onlyA.length) out.push(`## ${labels.onlyIn(link('A'))}`, '', onlyA.map(x => x.text).join('\n\n'), '');
	if (onlyB.length) out.push(`## ${labels.onlyIn(link('B'))}`, '', onlyB.map(x => x.text).join('\n\n'), '');
	if (yamlA.trim() || yamlB.trim()) {
		out.push(`## ${labels.properties}`, '');
		for (const [side, yaml] of [['A', yamlA], ['B', yamlB]]) {
			if (!yaml.trim()) continue;
			out.push(`**${link(side)}**`, '', '```yaml', yaml.replace(/\s+$/, ''), '```', '');
		}
	}
	return {
		text: out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n',
		counts: { conflicts: conflicts.length, shared: same.length + identical.length, onlyA: onlyA.length, onlyB: onlyB.length },
	};
}

/**
 * Links copied out of a note keep pointing where they pointed: a heading or block link inside the
 * note itself gets the note's name, and a link whose target would resolve differently from the
 * draft's folder is rewritten. `resolve(linkpath)` finds the file the source note meant;
 * `linkFor(file)` writes the link text that reaches it from the draft.
 */
export function rewriteLinks(text, { selfLink, selfHref, resolve, linkFor, relative }) {
	let out = text.replace(/(!?)\[\[([^\]|#^]*)((?:#|\^)[^\]|]*)?(\|[^\]]*)?\]\]/g, (whole, bang, path, anchor = '', alias = '') => {
		if (!path) return anchor ? `${bang}[[${selfLink}${anchor}${alias}]]` : whole;
		const file = resolve(path);
		if (!file) return whole;
		const target = linkFor(file);
		return target === path ? whole : `${bang}[[${target}${anchor}${alias}]]`;
	});
	out = out.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole, bang, label, href, title = '') => {
		if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return whole;
		if (href.startsWith('#')) return `${bang}[${label}](${encodeURI(selfHref)}${href}${title})`;
		const [path, anchor = ''] = href.split(/(?=#)/);
		let decoded;
		try { decoded = decodeURI(path); } catch { return whole; }
		const file = resolve(decoded);
		if (!file) return whole;
		const next = relative(file);
		return next === decoded ? whole : `${bang}[${label}](${encodeURI(next)}${anchor}${title})`;
	});
	return out;
}

/** Path of `to` written relative to the folder `fromFolder` ('' is the vault root). */
export function relativePath(fromFolder, to) {
	const from = fromFolder ? fromFolder.split('/') : [];
	const parts = to.split('/');
	let i = 0;
	while (i < from.length && i < parts.length - 1 && from[i] === parts[i]) i++;
	return [...from.slice(i).map(() => '..'), ...parts.slice(i)].join('/');
}

/** A short fingerprint, so an undo can tell whether the draft was edited after it was made. */
export function fingerprint(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0') + ':' + text.length;
}
