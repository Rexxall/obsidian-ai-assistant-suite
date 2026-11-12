const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const plain=v=>JSON.parse(JSON.stringify(v));
function fixture(settings={}){
 const module={exports:{}};const classes=Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]));
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{window:{setTimeout,clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto},module,console,TextEncoder,TextDecoder,require:()=>({...classes,parseYaml:JSON.parse,stringifyYaml:JSON.stringify})});
 const p=new module.exports();
 const folders=new Set(['10 - Projects','10 - Projects/TOEFL','20 - Inputs','40 - Obsidian','40 - Obsidian/Templates','99 - ToDo']);
 const file={path:'99 - ToDo/note.md',name:'note.md',basename:'note',parent:{path:'99 - ToDo'}};
 let text='---\n{"status":"🔍","tags":["C/科研"]}\n---\nBody';
 p.settings={rollbackHistory:[],rollbackRedoHistory:[],ignoredFolders:'',...settings};p.saveSettings=async()=>{};p.addToHistory=()=>{};p.generateFileId=()=>'';
 p.app={
  metadataCache:{getTags:()=>({'#Type/笔记':40,'#C/科研/文献':3,'#C/科研':12,'#misc':90}),getFileCache:()=>({frontmatter:{tags:['C/科研']}})},
  vault:{read:async()=>text,process:async(_,fn)=>{text=fn(text);},getAllLoadedFiles:()=>[...folders].map(path=>({path,children:[]})).concat([{path:'/',children:[]},file]),
   getAbstractFileByPath:path=>path===file.path?file:folders.has(path)?{children:[]}:null,createFolder:async path=>folders.add(path)},
  fileManager:{renameFile:async(_,path)=>{file.path=path;}}
 };
 return {p,file,get text(){return text},set text(v){text=v}};
}

test('without vault settings tags are only cleaned: vault spelling, no duplicates, nothing already on the note',()=>{
 const {p}=fixture();
 assert.deepEqual(plain(p.refineTags(['#type/笔记','Type/笔记','C/科研','new tag','misc'],['Type/笔记','C/科研','misc'],['C/科研'])),['Type/笔记','new-tag','misc']);
});

test('allowed roots drop tags outside them, and the vault list is ordered by use',()=>{
 const {p}=fixture({taggerAllowedRoots:'C\nType/'});
 assert.deepEqual(plain(p.refineTags(['misc','Learning/英语','C/新/主题','Type/笔记'],[],[])),['C/新/主题','Type/笔记']);
 assert.deepEqual(plain(p.vaultTagsByUse()),['Type/笔记','C/科研','C/科研/文献']);
});

test('keeping only the child tag drops parents of suggested or existing tags',()=>{
 const {p}=fixture({taggerDropParentTags:true});
 assert.deepEqual(plain(p.refineTags(['C/科研/文献','C/科研/文献/检索','C','Type/笔记'],[],['Type/笔记/AINote'])),['C/科研/文献/检索']);
});

test('folder suggestions are checked against the vault, never land in ignored folders, and can be limited to existing ones',()=>{
 const {p}=fixture({ignoredFolders:'40 - Obsidian\n99 - ToDo'});
 const raw=[{path:'/10 - Projects/TOEFL/',is_new:true},{path:'20 - Inputs/新主题',is_new:false},{path:'40 - Obsidian/Templates',is_new:false},{path:'10 - Projects/TOEFL'}];
 assert.deepEqual(plain(p.refineFolderSuggestions(raw)),[{path:'10 - Projects/TOEFL',is_new:false},{path:'20 - Inputs/新主题',is_new:true}]);
 p.settings.moverExistingOnly=true;
 assert.deepEqual(plain(p.refineFolderSuggestions(raw)),[{path:'10 - Projects/TOEFL',is_new:false}]);
 assert.deepEqual(plain(p.vaultFolderPaths()),['10 - Projects','10 - Projects/TOEFL','20 - Inputs']);
});

test('an ignored folder only hides itself and its subfolders, not folders that share its prefix',()=>{
 const {p}=fixture({ignoredFolders:'10 - Projects/TOEFL'});
 assert.equal(p.isIgnoredFolder('10 - Projects/TOEFL-Prep'),false);
 assert.equal(p.isIgnoredFolder('10 - Projects/TOEFL/Reading'),true);
});

test('vault rules reach every prompt only when set; structure and title prompts get the standing notes alone',()=>{
 const base={taggerPrompt:'T {{existing_tags}} {{content}} {{count}}',moverPrompt:'M {{folder_list}} {{content}} {{count}}',metaPrompt:'X {{content}}',structurizerPrompt:'S {{content}}',taggerSuggestionsCount:5,moverSuggestionsCount:3};
 const off=fixture(base).p;
 assert.equal(off.getTaggerPrompt(['a'],'body'),'T a body 5');
 assert.ok(off.getMetaPrompt('body').startsWith('X body'));
 assert.doesNotMatch(off.getMetaPrompt('body'),/库的规矩|标签只能/);
 const {p}=fixture({...base,taggerAllowedRoots:'C\nP',taggerDropParentTags:true,moverExistingOnly:true,vaultConventions:'正文从二级标题开始。'});
 assert.match(p.getTaggerPrompt(['a'],'body'),/C\/、P\//);
 assert.match(p.getMoverPrompt(['x'],'body'),/不要创造新路径/);
 for(const prompt of [p.getMetaPrompt('body'),p.getStructurizerPrompt('body'),p.getTitleOnlyPrompt('body')]){
  assert.match(prompt,/正文从二级标题开始/);
  assert.doesNotMatch(prompt,/标签只能以这些根开头/);
 }
});

test('applying properties writes no empty fields and fills defaults only where the note has none',async()=>{
 const f=fixture({metaFieldDefaults:'{"status":"❌","learning_status":"raw","tags":["x"]}'});
 const task={id:'s',type:'one-click',content:{file:f.file,originalContent:f.text}};
 await f.p.applyNoteGroup({file:f.file,tasks:[task]},{originalTaskId:'s',meta:{title:'新标题',summary:'',tldr:'  '},tags:[],useMeta:true,useTags:false,useFolder:false,rename:false});
 const fm=JSON.parse(f.text.split('\n')[1]);
 assert.deepEqual(fm,{status:'🔍',tags:['C/科研'],title:'新标题',learning_status:'raw'});
});

test('broken default YAML adds nothing instead of failing the write',()=>{
 const {p}=fixture({metaFieldDefaults:'status: [unclosed'});
 assert.deepEqual(plain(p.fillFieldDefaults({a:1})),{a:1});
});

test('unticking the added properties in the review leaves them out',async()=>{
 const f=fixture({metaFieldDefaults:'{"learning_status":"raw"}'});
 const task={id:'s',type:'one-click',content:{file:f.file,originalContent:f.text}};
 await f.p.applyNoteGroup({file:f.file,tasks:[task]},{originalTaskId:'s',meta:{title:'T'},tags:[],useMeta:true,skipDefaults:true,useTags:false,useFolder:false,rename:false});
 assert.equal(JSON.parse(f.text.split('\n')[1]).learning_status,undefined);
});

test('added properties can be limited to inbox folders, judged by where the note sits before it moves',async()=>{
 const scoped=fixture({metaFieldDefaults:'{"learning_status":"raw"}',metaFieldDefaultsFolders:'99 - ToDo/Inbox\n/Clippings/'});
 assert.equal(scoped.p.fieldDefaultsApplyTo('99 - ToDo/Inbox/a.md'),true);
 assert.equal(scoped.p.fieldDefaultsApplyTo('99 - ToDo/Inbox/sub/a.md'),true);
 assert.equal(scoped.p.fieldDefaultsApplyTo('99 - ToDo/Inbox-old/a.md'),false);
 assert.equal(scoped.p.fieldDefaultsApplyTo('Clippings/a.md'),true);
 assert.equal(scoped.p.fieldDefaultsApplyTo('top.md'),false);
 const task={id:'s',type:'one-click',content:{file:scoped.file,originalContent:scoped.text}};
 await scoped.p.applyNoteGroup({file:scoped.file,tasks:[task]},{originalTaskId:'s',meta:{title:'T'},tags:[],useMeta:true,useTags:false,useFolder:true,folder:'99 - ToDo/Inbox',rename:false});
 assert.equal(JSON.parse(scoped.text.split('\n')[1]).learning_status,undefined,'a note outside the inbox gets nothing even when moved into it');
 const open=fixture({metaFieldDefaults:'{"learning_status":"raw"}'});
 assert.equal(open.p.fieldDefaultsApplyTo('anywhere/a.md'),true);
});

const ithacaStyles={styleSubtitleClass:'ih-sub',styleCardClass:'ih-card',styleCardFolders:'50 - Cards',styleAgedRules:'1095 ih-aged-2\n365 ih-aged'};
const daysAgo=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);

test('without style classes in settings nothing is offered',()=>{
 const {p,file}=fixture();
 assert.deepEqual(plain(p.styleProposals(file,{tldr:'x',date:'2001-01-01'},{useFolder:true,folder:'50 - Cards'},'')),[]);
});

test('style classes are offered from settings: subtitle, card by destination, and the longest age rule met',()=>{
 const {p,file}=fixture(ithacaStyles);
 const out=plain(p.styleProposals(file,{date:daysAgo(400),cssclasses:['wide']},{useMeta:true,meta:{tldr:'一句话'},useFolder:true,folder:'50 - Cards/Concepts'},'Body'));
 assert.deepEqual(out.map(x=>[x.key,x.cls]),[['sub','ih-sub'],['card','ih-card'],['aged','ih-aged']]);
 assert.equal(plain(p.styleProposals(file,{date:daysAgo(1200)},{},''))[0].cls,'ih-aged-2');
 assert.deepEqual(plain(p.styleProposals(file,{tldr:'t',date:daysAgo(10),cssclasses:'ih-card'},{useFolder:true,folder:'50 - Cards'},'<span class="ih-sub">t</span>')),[],'nothing already there is offered again');
});

test('only ticked style items are written: span on the first line, cssclasses kept and the older age class replaced',async()=>{
 const f=fixture(ithacaStyles);
 f.text='---\n{"date":"'+daysAgo(1200)+'","cssclasses":["wide","ih-aged"],"tldr":"A < B & C"}\n---\n\nBody';
 const task={id:'s',type:'one-click',content:{file:f.file,originalContent:f.text}};
 await f.p.applyNoteGroup({file:f.file,tasks:[task]},{originalTaskId:'s',meta:{},tags:[],useMeta:false,useTags:false,useFolder:false,rename:false,style:{sub:true,aged:true}});
 const [,yaml,,...rest]=f.text.split('\n');
 assert.deepEqual(JSON.parse(yaml).cssclasses,['wide','ih-aged-2']);
 assert.equal(rest.join('\n'),'\n<span class="ih-sub">A &lt; B &amp; C</span>\n\nBody','the blank line under the frontmatter stays, as in the notebook kit');
});

test('unticked style items change nothing',async()=>{
 const f=fixture(ithacaStyles);const before=f.text;
 const task={id:'s',type:'one-click',content:{file:f.file,originalContent:f.text}};
 await assert.rejects(f.p.applyNoteGroup({file:f.file,tasks:[task]},{originalTaskId:'s',meta:{tldr:'x'},tags:[],useMeta:false,useTags:false,useFolder:false,rename:false,style:{sub:false}}),/没有选中/);
 assert.equal(f.text,before);
});

test('subtitle placement and cssclasses follow the Ithaca notebook kit',()=>{
 const {p}=fixture(ithacaStyles);
 assert.equal(p.insertSubtitleLine('Body\n','ih-sub','x'),'<span class="ih-sub">x</span>\n\nBody\n');
 assert.equal(p.insertSubtitleLine('\n\nBody','ih-sub','x'),'\n\n<span class="ih-sub">x</span>\n\nBody');
 assert.equal(p.insertSubtitleLine('','ih-sub','x'),'<span class="ih-sub">x</span>\n');
 assert.equal(p.insertSubtitleLine('\n','ih-sub','x'),'\n<span class="ih-sub">x</span>\n');
 assert.equal(p.hasSpanClass('a <span class="ih-sub">t</span>','ih-sub'),true);
 assert.equal(p.hasSpanClass('<span class="ih-mg ih-sub">t</span> class="ih-sub"','ih-sub'),false,'only an exact class counts, like the kit');
 const both={cssclass:'old',cssclasses:['a']};p.applyStyleProposals(both,'',[{key:'card',cls:'ih-card'}]);
 assert.deepEqual(plain(both),{cssclass:'old',cssclasses:['a','ih-card']},'cssclass is left alone when cssclasses exists');
 const legacy={cssclass:'wide ih-aged'};p.applyStyleProposals(legacy,'',[{key:'aged',cls:'ih-aged-2',remove:['ih-aged']}]);
 assert.deepEqual(plain(legacy),{cssclasses:['wide','ih-aged-2']},'old field moves over and the same group keeps one');
});

test('a one-line summary with line breaks becomes one line, and an older age class is never downgraded',()=>{
 const {p,file}=fixture(ithacaStyles);
 assert.equal(plain(p.styleProposals(file,{tldr:'a\nb'},{},''))[0].text,'a b');
 assert.deepEqual(plain(p.styleProposals(file,{date:daysAgo(500),cssclasses:['ih-aged-2']},{},'')),[]);
 assert.equal(plain(p.styleProposals(file,{date:daysAgo(1200),cssclasses:['ih-aged']},{},''))[0].cls,'ih-aged-2');
});

test('with allowed roots a bare root is not a tag, neither in the vault list nor in suggestions',()=>{
 const {p}=fixture({taggerAllowedRoots:'C\nType'});
 p.app.metadataCache.getTags=()=>({'#Type':9,'#Type/笔记':4,'#C':3,'#C/科研':2});
 assert.deepEqual(plain(p.vaultTagsByUse()),['Type/笔记','C/科研']);
 assert.deepEqual(plain(p.refineTags(['Type','C/新'],[],[])),['C/新']);
});

test('the language hint names the script the note is written in, so English notes are not summarised in Chinese',()=>{
 const {p}=fixture();
 assert.equal(p.noteScript('sync w/ Mika, Tom, Ana — launch date??? tom says 21st, mika thinks too early. agreed: 28th'),'latin');
 assert.equal(p.noteScript('木曜定例。リリース日を28日に決定しました。担当者を確認する。'),'ja');
 assert.equal(p.noteScript('周四和小林阿哲陈姐开会，上线日期最后定28号。'),'zh');
 assert.equal(p.noteScript('中文笔记里夹几个 English words 和 [[Some Linked Note With Long English Name]] https://example.com/long/english/path'),'zh');
 assert.equal(p.noteScript('```\nconst a = 1\n```'),'');
 assert.match(p.languageHintBlock('This note is all in English and long enough to count as English text.'),/英文等拉丁字母文字/);
 assert.equal(p.languageHintBlock(''),'');
 p.settings={metaPrompt:'X {{content}}'};
 assert.match(p.getMetaPrompt('sync w/ Mika, Tom, Ana — launch date??? tom says 21st, mika thinks too early.'),/不要翻译/);
});

test('title hint asks for the topic but keeps names that are the topic',()=>{
 const {p}=fixture();
 const hint=p.titleHintBlock();
 assert.match(hint,/主要讲什么/);
 assert.match(hint,/人名、日期是主题的一部分时照常写/);
 assert.match(p.getTitleOnlyPrompt('随便一段内容'),/\*\*标题:\*\*/);
 p.settings={metaPrompt:'X {{content}}'};
 assert.match(p.getMetaPrompt('随便一段内容'),/\*\*标题:\*\*/);
});

const MARKS='> [!summary] 一句话结论\n> [!quote] 原话\n> [!timeline] 有先后的安排\n<span class="ih-arrow">所以</span> 连接因果';
test('notebook marks reach the structure prompt only when listed, with the card limit and short properties',()=>{
 const off=fixture({structurizerPrompt:'S {{content}}'}).p;assert.equal(off.getStructurizerPrompt('body'),'S body');
 const {p}=fixture({structurizerPrompt:'S {{content}}',structurizerMarks:MARKS,structurizerMaxCards:3});
 const prompt=p.getStructurizerPrompt('body',{channel:'小雨',summary:'长摘要',date:'2026-11-01'});
 assert.match(prompt,/最多 3 张纸片/);assert.match(prompt,/\[!timeline\]/);assert.match(prompt,/channel: 小雨/);assert.doesNotMatch(prompt,/长摘要/);
});
test('notebook output keeps listed marks, strips the rest, caps cards, drops repeated property lines and counts reworded sentences',()=>{
 const {p}=fixture({structurizerMarks:MARKS,structurizerMaxCards:2});
 const original='**tldr:** 一句话\n给予自己的时间再多都不算多，这是我学到的。\n每天上午先做规划再处理客户的事情。';
 const out=['**tldr:** 一句话','> [!summary] 结论','> 给予自己的时间再多都不算多，这是我学到的。','','> [!tip] 提示','> 每天上午先做规划再处理客户的事情。','','> [!quote]','> 别的','<span class="ih-circ">圈</span> <span class="ih-arrow">所以</span>'].join('\n');
 const r=p.cleanNotebookMarks(out,original,{tldr:'一句话'});
 assert.equal(r.stats.dupLines,1);assert.equal(r.stats.cards,2);assert.equal(r.stats.removed,2);assert.equal(r.stats.changed,0);
 assert.doesNotMatch(r.text,/\[!tip\]/);assert.match(r.text,/> \*\*提示\*\*/);assert.doesNotMatch(r.text,/ih-circ/);assert.match(r.text,/ih-arrow/);assert.doesNotMatch(r.text,/tldr/);
 const changed=p.cleanNotebookMarks('> [!summary] 结论\n> 时间多一点总是好的。',original,{tldr:'一句话'});assert.equal(changed.stats.changed,2);
 assert.equal(fixture({}).p.cleanNotebookMarks('x','x').text,'x');
});
test('notebook output drops a copied property block and stamps whose text is not in the properties',()=>{
 const marks=MARKS+'\n<span class="ih-postmark">频道名<br>日期</span> 频道和日期取自属性\n<span class="ih-barcode">时间 · 视频ID</span> 视频 ID 取自属性';
 const {p}=fixture({structurizerMarks:marks});
 const out='---\ntitle: X\n---\n正文第一段。\n<span class="ih-postmark">旅居普吉</span>\n<span class="ih-postmark">小雨<br>2026-11-01</span>\n<span class="ih-barcode">时间 · 视频ID</span>';
 const r=p.cleanNotebookMarks(out,'正文第一段。',{title:'旅居普吉',channel:'小雨',date:'2026-11-01'});
 assert.doesNotMatch(r.text,/title: X/);assert.doesNotMatch(r.text,/旅居普吉/);assert.match(r.text,/小雨<br>2026-11-01/);assert.doesNotMatch(r.text,/视频ID/);assert.equal(r.stats.removed,2);
});
test('notebook output drops an unclosed copied property block and bold-colon repeats',()=>{
 const {p}=fixture({structurizerMarks:MARKS});
 const r=p.cleanNotebookMarks('---\ntitle: X\nstatus: ❌\n\n## 核心想法\n**tldr:** 重复\n正文。','正文。',{tldr:'a'});
 assert.match(r.text,/^\n?## 核心想法/);assert.doesNotMatch(r.text,/tldr|status/);assert.equal(r.stats.dupLines,1);
});
test('a subtitle line at the top of the note survives a notebook tidy',()=>{
 const {p}=fixture({structurizerMarks:MARKS});
 const r=p.cleanNotebookMarks('## 核心想法\n正文。','<span class="ih-sub">副题</span>\n\n正文。',{});
 assert.match(r.text,/^<span class="ih-sub">副题<\/span>\n\n## 核心想法/);
});
test('property lines echoed from the prompt at the top of the reply are dropped',()=>{
 const {p}=fixture({structurizerMarks:MARKS});
 const r=p.cleanNotebookMarks('title: 旅居\nstatus: ❌\n\n<span class="ih-sub">副</span>\n\n正文。','<span class="ih-sub">副</span>\n\n正文。',{title:'旅居',status:'❌'});
 assert.match(r.text,/^<span class="ih-sub">副<\/span>/);
});
test('the condense switch changes only the wording rule, and lines stay real newlines',()=>{
 const strict=fixture({structurizerPrompt:'S {{content}}',structurizerMarks:MARKS}).p.getStructurizerPrompt('b');
 const loose=fixture({structurizerPrompt:'S {{content}}',structurizerMarks:MARKS,structurizerCondense:true}).p.getStructurizerPrompt('b');
 assert.match(strict,/不要缩写。\n- 原文已有/);assert.match(loose,/不要再在正文里写一遍。\n- 原文已有/);assert.doesNotMatch(loose,/\\n/);
});
test('videos, images and links the note never had are dropped from a notebook tidy',()=>{
 const {p}=fixture({structurizerMarks:MARKS});
 const r=p.cleanNotebookMarks('<iframe src="https://www.youtube.com/embed/FAKE" allowfullscreen></iframe>\n正文 [来源](https://real.example/a) 和 [编的](https://fake.example/b)。\n![图](https://fake.example/c.png)','正文 [来源](https://real.example/a)。',{});
 assert.doesNotMatch(r.text,/iframe|fake\.example/);assert.match(r.text,/\[来源\]\(https:\/\/real\.example\/a\)/);assert.match(r.text,/和 编的。/);assert.equal(r.stats.removed,3);
});
test('a per-run choice overrides the condense setting for that run only',()=>{
 const {p}=fixture({structurizerPrompt:'S {{content}}',structurizerMarks:MARKS,structurizerCondense:false});
 p.condenseOverride=true;assert.match(p.getStructurizerPrompt('b'),/压进纸片的段落不要再在正文里写一遍/);
 p.condenseOverride=undefined;assert.match(p.getStructurizerPrompt('b'),/不要缩写/);
});
