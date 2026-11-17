// Two notes → one merge draft. The AI only proposes which blocks say the same thing and which
// contradict each other; every line of the draft is copied from the notes by this code, so nothing
// can be reworded, dropped or invented. The two source notes are never written to.

import { at, list as items, str } from './vendor/rex-ai-kit/json';

export type BlockKind = 'code' | 'heading' | 'quote' | 'table' | 'item' | 'text';

/** One unit of a note body, as `splitBlocks` cuts it. */
export interface Block {
	kind: BlockKind;
	text: string;
}

/** A block with its id: A1, A2… for the first note, B1… for the second. */
export interface PreparedBlock extends Block {
	id: string;
}

/** Ids of an A block and a B block that are the same text. */
export interface BlockPair {
	a: string;
	b: string;
}

export interface PreparedBlocks {
	a: PreparedBlock[];
	b: PreparedBlock[];
	identical: BlockPair[];
}

export type GroupType = 'same' | 'conflict';

/** One checked group from the AI: blocks of A and B that say the same thing or contradict. */
export interface Group {
	type: GroupType;
	title: string;
	why: string;
	a: string[];
	b: string[];
}

export type Side = 'A' | 'B';

export interface PromptInput extends PreparedBlocks {
	nameA: string;
	nameB: string;
	english: boolean;
}

/** Interface words for the draft. */
export interface MergeLabels {
	draftTitle: string;
	draftIntro: (a: string, b: string) => string;
	conflicts: string;
	shared: string;
	identical: string;
	onlyIn: (link: string) => string;
	properties: string;
	otherWording: (link: string) => string;
	source: string;
	count: (n: number) => string;
	aiNote: string;
	untitled: string;
}

export interface DraftInput extends PreparedBlocks {
	groups: Group[];
	yamlA: string;
	yamlB: string;
	link: (side: Side) => string;
	labels: MergeLabels;
	date: string;
}

export interface DraftCounts {
	conflicts: number;
	shared: number;
	onlyA: number;
	onlyB: number;
}

export interface Draft {
	text: string;
	counts: DraftCounts;
}

/** How `rewriteLinks` reaches files; `F` is whatever `resolve` finds (a TFile in the plugin). */
export interface LinkContext<F> {
	selfLink: string;
	selfHref: string;
	resolve: (linkpath: string) => F | null | undefined;
	linkFor: (file: F) => string;
	relative: (file: F) => string;
}

interface OpenBlock {
	kind: BlockKind;
	lines: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;

/** Frontmatter text (without the fences) and the body after it. */
export function splitFrontmatter(text: string): { yaml: string; body: string } {
	const match = String(text || '').match(FRONTMATTER);
	return match ? { yaml: match[1], body: text.slice(match[0].length) } : { yaml: '', body: String(text || '') };
}

/**
 * The body cut into blocks a reader would see as one unit: a paragraph, a heading, one top-level
 * list item with its children, a quote or callout, a table, a fenced code or math block.
 */
export function splitBlocks(body: string): Block[] {
	const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
	const blocks: Block[] = [];
	// Widened on purpose: `close()` resets it inside a closure, which narrowing cannot see.
	let current = null as OpenBlock | null;
	const close = (): void => {
		if (current && current.lines.some(l => l.trim())) blocks.push({ kind: current.kind, text: current.lines.join('\n').replace(/\s+$/, '') });
		current = null;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fence: string[] | null = line.match(FENCE) || (line.trim() === '$$' ? [line, '$$'] : null);
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
		const kind: BlockKind = /^>/.test(line) ? 'quote' : /^\s*\|/.test(line) ? 'table' : LIST_ITEM.test(line) ? 'item' : /^\s/.test(line) && current?.kind === 'item' ? 'item' : 'text';
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

const normalise = (text: string): string => String(text).replace(/\s+/g, ' ').trim();

/** Blocks of both notes with ids (A1…, B1…); blocks identical after collapsing spaces are paired here. */
export function prepareBlocks(bodyA: string, bodyB: string): PreparedBlocks {
	const a = splitBlocks(bodyA).map((b, i) => ({ ...b, id: `A${i + 1}` }));
	const b = splitBlocks(bodyB).map((x, i) => ({ ...x, id: `B${i + 1}` }));
	const identical: BlockPair[] = [];
	const takenB = new Set<string>();
	for (const block of a) {
		const twin = b.find(other => !takenB.has(other.id) && normalise(other.text) === normalise(block.text));
		if (twin) { takenB.add(twin.id); identical.push({ a: block.id, b: twin.id }); }
	}
	return { a, b, identical };
}

/** Why these two notes cannot be merged as they are, or '' when they can. */
export function blocker(textA: string, textB: string, limit = 60000): '' | 'footnotes' | 'empty' | 'too-long' {
	const footnote = /^\[\^[^\]]+\]:/m;
	if (footnote.test(textA) || footnote.test(textB)) return 'footnotes';
	const { body: a } = splitFrontmatter(textA);
	const { body: b } = splitFrontmatter(textB);
	if (!a.trim() || !b.trim()) return 'empty';
	if (a.length + b.length > limit) return 'too-long';
	return '';
}

/** The request: only the blocks that were not already paired, each with its id. */
export function buildPrompt({ nameA, nameB, a, b, identical, english }: PromptInput): string {
	const pairedA = new Set(identical.map(p => p.a));
	const pairedB = new Set(identical.map(p => p.b));
	const list = (blocks: PreparedBlock[]): string => blocks.map(x => `[${x.id}]${x.kind === 'heading' ? ' (heading)' : ''}\n${x.text}`).join('\n\n');
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
export function parseGroups(reply: string | null | undefined, { a, b, identical }: PreparedBlocks): Group[] {
	let data: unknown;
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
	const groups: Group[] = [];
	for (const raw of items(at(data, 'groups'))) {
		const rawType = at(raw, 'type');
		const type = rawType === 'conflict' ? 'conflict' : rawType === 'same' ? 'same' : null;
		if (!type) continue;
		const take = (ids: unknown, side: Side): string[] => items(ids).map(String).filter(id => id.startsWith(side) && known.has(id) && !used.has(id));
		const ga = [...new Set(take(at(raw, 'a'), 'A'))];
		const gb = [...new Set(take(at(raw, 'b'), 'B'))];
		if (!ga.length || !gb.length) continue;
		for (const id of [...ga, ...gb]) used.add(id);
		const order = (ids: string[], list: PreparedBlock[]): string[] => ids.sort((x, y) => list.findIndex(v => v.id === x) - list.findIndex(v => v.id === y));
		// 块编号对读者没有意义：万一模型还是写了，去掉数字只留 A、B
		const why = field(at(raw, 'why')).replace(/\b([AB])\d+\b/g, '$1').trim().slice(0, 300);
		groups.push({ type, title: field(at(raw, 'title')).trim().slice(0, 60), why, a: order(ga, a), b: order(gb, b) });
	}
	return groups;
}

/** A field of the AI reply as text: strings as they are, non-zero numbers and `true` spelled out, anything else empty. */
const field = (v: unknown): string => str(v) ?? ((typeof v === 'number' || typeof v === 'boolean') && v ? String(v) : '');

const quote = (text: string): string => text.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');

/**
 * The draft note. `link(side)` gives the wikilink to note A or B; `labels` holds the interface words.
 * Order: conflicts first (they need a decision), then shared content, then what only one note has.
 */
export function assembleDraft({ a, b, identical, groups, yamlA, yamlB, link, labels, date }: DraftInput): Draft {
	// 原文的标题降三级放进草稿，免得和草稿自己的小节（## 和 ###）混在一起
	const demote = (x: PreparedBlock): PreparedBlock => (x.kind === 'heading' ? { ...x, text: x.text.replace(/^(#{1,6})/, m => '#'.repeat(Math.min(6, m.length + 3))) } : x);
	a = a.map(demote);
	b = b.map(demote);
	const byId = new Map([...a, ...b].map(x => [x.id, x]));
	const texts = (ids: string[]): string => ids.map(id => byId.get(id)!.text).join('\n\n');
	const inGroup = new Set([...identical.flatMap(p => [p.a, p.b]), ...groups.flatMap(g => [...g.a, ...g.b])]);
	const conflicts = groups.filter(g => g.type === 'conflict');
	const same = groups.filter(g => g.type === 'same');
	const onlyA = a.filter(x => !inGroup.has(x.id));
	const onlyB = b.filter(x => !inGroup.has(x.id));
	const out: string[] = [];
	const yamlString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
			out.push(`### ${labels.identical}`, '', identical.map(p => byId.get(p.a)!.text).join('\n\n'), '', `<small>${labels.source}${link('A')} · ${link('B')}</small>`, '');
		}
	}
	if (onlyA.length) out.push(`## ${labels.onlyIn(link('A'))}`, '', onlyA.map(x => x.text).join('\n\n'), '');
	if (onlyB.length) out.push(`## ${labels.onlyIn(link('B'))}`, '', onlyB.map(x => x.text).join('\n\n'), '');
	if (yamlA.trim() || yamlB.trim()) {
		out.push(`## ${labels.properties}`, '');
		for (const [side, yaml] of [['A', yamlA], ['B', yamlB]] as const) {
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
export function rewriteLinks<F>(text: string, { selfLink, selfHref, resolve, linkFor, relative }: LinkContext<F>): string {
	let out = text.replace(/(!?)\[\[([^\]|#^]*)((?:#|\^)[^\]|]*)?(\|[^\]]*)?\]\]/g, (whole: string, bang: string, path: string, anchor: string = '', alias: string = ''): string => {
		if (!path) return anchor ? `${bang}[[${selfLink}${anchor}${alias}]]` : whole;
		const file = resolve(path);
		if (!file) return whole;
		const target = linkFor(file);
		return target === path ? whole : `${bang}[[${target}${anchor}${alias}]]`;
	});
	out = out.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole: string, bang: string, label: string, href: string, title: string = ''): string => {
		if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return whole;
		if (href.startsWith('#')) return `${bang}[${label}](${encodeURI(selfHref)}${href}${title})`;
		const [path, anchor = ''] = href.split(/(?=#)/);
		let decoded: string;
		try { decoded = decodeURI(path); } catch { return whole; }
		const file = resolve(decoded);
		if (!file) return whole;
		const next = relative(file);
		return next === decoded ? whole : `${bang}[${label}](${encodeURI(next)}${anchor}${title})`;
	});
	return out;
}

/** Path of `to` written relative to the folder `fromFolder` ('' is the vault root). */
export function relativePath(fromFolder: string, to: string): string {
	const from = fromFolder ? fromFolder.split('/') : [];
	const parts = to.split('/');
	let i = 0;
	while (i < from.length && i < parts.length - 1 && from[i] === parts[i]) i++;
	return [...from.slice(i).map(() => '..'), ...parts.slice(i)].join('/');
}

/** A short fingerprint, so an undo can tell whether the draft was edited after it was made. */
export function fingerprint(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0') + ':' + text.length;
}
