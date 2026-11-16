// Merge draft: blocks, the AI's groups checked, the draft copied word for word, links kept, safe undo.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function load(){
 const module={exports:{}};
 const obsidian=Object.fromEntries(['Plugin','Notice','PluginSettingTab','SettingPage','Setting','FuzzySuggestModal','Modal','ItemView','TFile','Component'].map(k=>[k,class{}]));
 obsidian.getLanguage=()=>'en';obsidian.Platform={isDesktopApp:false};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{window:{setTimeout,clearTimeout,crypto:globalThis.crypto},module,console,URL,AbortController,require:()=>obsidian,createFragment:fn=>{const f={appendText(){},createEl:()=>({addEventListener(){}})};fn(f);return f;}});
 return module.exports;
}
const Plugin=load();const M=Plugin.mergeDraft;
const plain=v=>JSON.parse(JSON.stringify(v));

test('blocks follow what a reader sees: paragraphs, headings, list items, code, tables, quotes',()=>{
 const body='# Plan\n\nWe move on March 1.\nThe landlord wants notice.\n\n- boxes\n  - twenty\n- movers\n\n```js\na\n\nb\n```\n\n| a | b |\n|---|---|\n\n> [!note]\n> keep keys\n';
 assert.deepEqual(plain(M.splitBlocks(body).map(b=>b.kind)),['heading','text','item','item','code','table','quote']);
 assert.equal(M.splitBlocks(body)[2].text,'- boxes\n  - twenty');
 assert.equal(M.splitBlocks(body)[4].text,'```js\na\n\nb\n```');
});
test('identical blocks are paired locally and never sent',()=>{
 const p=M.prepareBlocks('Same  line.\n\nOnly A.','Other.\n\nSame line.');
 assert.deepEqual(plain(p.identical),[{a:'A1',b:'B2'}]);
 const prompt=M.buildPrompt({nameA:'a',nameB:'b',...p,english:true});
 assert.ok(!prompt.includes('Same'));assert.match(prompt,/\[A2\]\nOnly A\./);assert.match(prompt,/\[B1\]\nOther\./);
});
test('footnotes, empty notes and very long notes are stopped before anything is sent',()=>{
 assert.equal(M.blocker('a[^1]\n\n[^1]: note','b'),'footnotes');
 assert.equal(M.blocker('---\ntags: x\n---\n','b'),'empty');
 assert.equal(M.blocker('x'.repeat(40000),'y'.repeat(30000)),'too-long');
 assert.equal(M.blocker('a','b'),'');
});
test('the AI groups are checked: unknown ids, reused ids and one-sided groups are dropped',()=>{
 const blocks=M.prepareBlocks('a1\n\na2\n\na3','b1\n\nb2');
 const reply='```json\n{"groups":[{"type":"same","title":"T","a":["A2","A1"],"b":["B1"]},{"type":"conflict","a":["A1"],"b":["B2"]},{"type":"same","a":["A9"],"b":["B2"]},{"type":"conflict","a":["A3"],"b":["B2"],"why":"A3 and B2: dates differ"},{"type":"maybe","a":["A3"],"b":["B1"]}]}\n```';
 const groups=M.parseGroups(reply,blocks);
 assert.deepEqual(plain(groups),[{type:'same',title:'T',why:'',a:['A1','A2'],b:['B1']},{type:'conflict',title:'',why:'A and B: dates differ',a:['A3'],b:['B2']}]);
 assert.throws(()=>M.parseGroups('no json here',blocks),e=>e.kind==='empty');
});
test('the draft copies every block once, word for word, conflicts first, with sources',()=>{
 const A='# Plan\n\nMove on **March 1**.\n\nBook movers.\n\nShared exactly.';const B='We move on March 3.\n\nShared exactly.\n\nCall the bank.';
 const blocks=M.prepareBlocks(A,B);
 const groups=[{type:'conflict',title:'Move date',why:'1 vs 3',a:['A2'],b:['B1']}];
 const labels={draftTitle:'Merge draft',draftIntro:(a,b)=>`From ${a} and ${b}.`,conflicts:'Contradictions',shared:'Shared',identical:'Identical',onlyIn:l=>`Only in ${l}`,properties:'Properties',otherWording:l=>`How ${l} puts it`,source:'Source: ',count:n=>` (${n})`,aiNote:'AI note:',untitled:'Untitled'};
 const d=M.assembleDraft({...blocks,groups,yamlA:'tags: [move]',yamlB:'',link:s=>s==='A'?'[[Plan "A"]]':'[[Notes]]',labels,date:'2026-11-16'});
 assert.deepEqual(plain(d.counts),{conflicts:1,shared:1,onlyA:2,onlyB:1});
 assert.match(d.text,/\n#### Plan\n/,'source headings sit below the draft sections');assert.match(d.text,/## Contradictions \(1\)/);
 for(const piece of ['Move on **March 1**.','Book movers.','We move on March 3.','Call the bank.'])assert.equal(d.text.split(piece).length-1,1,piece);
 assert.equal(d.text.split('Shared exactly.').length-1,1);
 assert.ok(d.text.indexOf('## Contradictions')<d.text.indexOf('## Shared'));
 assert.match(d.text,/merged-from:\n  - "\[\[Plan \\"A\\"\]\]"\n  - "\[\[Notes\]\]"/);
 assert.match(d.text,/```yaml\ntags: \[move\]\n```/);
});
test('links inside a copied block keep pointing at the same place',()=>{
 const files={'Projects/Box list':{path:'Projects/Box list.md'},'img.png':{path:'B folder/img.png'}};
 const out=M.rewriteLinks('See [[#Costs]], [[#^b1|that]], [[Box list]], ![](img.png), [x](#Costs) and [web](https://a.test/x).',{
  selfLink:'Notes',selfHref:'../B folder/Notes.md',
  resolve:p=>p==='Box list'?files['Projects/Box list']:p==='img.png'?files['img.png']:null,
  linkFor:f=>f.path==='Projects/Box list.md'?'Projects/Box list':f.path,
  relative:f=>M.relativePath('A folder',f.path)});
 assert.equal(out,'See [[Notes#Costs]], [[Notes#^b1|that]], [[Projects/Box list]], ![](../B%20folder/img.png), [x](../B%20folder/Notes.md#Costs) and [web](https://a.test/x).');
 assert.equal(M.relativePath('','a/b.md'),'a/b.md');assert.equal(M.relativePath('a/b','a/c.md'),'../c.md');
});

function vault(files){
 const store=new Map(Object.entries(files));const trashed=[];const created=[];
 const file=path=>store.has(path)?{path,basename:path.split('/').pop().replace(/\.md$/,''),extension:'md',parent:{path:path.includes('/')?path.slice(0,path.lastIndexOf('/')):'/'},stat:{size:store.get(path).length}}:null;
 const app={
  vault:{read:async f=>store.get(f.path),create:async(path,text)=>{store.set(path,text);created.push(path);return file(path);},getAbstractFileByPath:file},
  metadataCache:{resolvedLinks:{},fileToLinktext:f=>f.basename,getFirstLinkpathDest:()=>null},
  fileManager:{trashFile:async f=>{trashed.push(f.path);store.delete(f.path);}},
  workspace:{getLeaf:()=>({openFile:async()=>{}})},
 };
 return {app,store,trashed,created,file};
}
function plugin(v,reply){
 const p=new Plugin();p.app=v.app;p.settings={apiConfigs:[{id:'d',ai:{provider:'ollama',model:'m'}}],mergeDrafts:[]};p.saveSettings=async()=>{};
 p.makeApiRequest=async()=>reply;return p;
}
test('creating a draft leaves both notes byte for byte, and refuses a stale preview',async()=>{
 const v=vault({'A/One.md':'---\ntags: a\n---\nAlpha.\n\nShared.','B/Two.md':'Beta.\n\nShared.'});
 const p=plugin(v,'{"groups":[{"type":"conflict","title":"Greek","a":["A1"],"b":["B1"],"why":"alpha vs beta"}]}');
 const result=await p.generateMergeDraft(v.file('A/One.md'),v.file('B/Two.md'));
 assert.equal(result.path,'A/Merge draft - One + Two.md');assert.equal(result.counts.conflicts,1);
 const before=[...v.store.entries()].map(e=>e.join('|'));
 await p.createMergeDraft(result);
 assert.deepEqual(v.created,['A/Merge draft - One + Two.md']);
 for(const entry of before)assert.ok([...v.store.entries()].map(e=>e.join('|')).includes(entry),'source unchanged');
 const again=await p.generateMergeDraft(v.file('A/One.md'),v.file('B/Two.md'));
 assert.equal(again.path,'A/Merge draft - One + Two 2.md','never overwrites');
 v.store.set('B/Two.md','Beta changed.\n\nShared.');
 await assert.rejects(p.createMergeDraft(again),/changed after the preview/);
});
test('undo removes only an untouched, unlinked draft',async()=>{
 const v=vault({'A/One.md':'Alpha.','B/Two.md':'Beta.'});
 const p=plugin(v,'{"groups":[]}');
 const make=async()=>{const r=await p.generateMergeDraft(v.file('A/One.md'),v.file('B/Two.md'));await p.createMergeDraft(r);return r.path;};
 const first=await make();
 assert.equal(await p.undoMergeDraft(),true);assert.deepEqual(v.trashed,[first]);assert.equal(p.settings.mergeDrafts.length,0);
 const edited=await make();v.store.set(edited,v.store.get(edited)+'\nmy note');
 assert.equal(await p.undoMergeDraft(),false);assert.ok(v.store.has(edited));
 v.store.delete(edited);p.settings.mergeDrafts=[];
 const linked=await make();v.app.metadataCache.resolvedLinks={'Elsewhere.md':{[linked]:1}};
 assert.equal(await p.undoMergeDraft(),false);assert.ok(v.store.has(linked));
});
test('two notes with nothing in common need no AI request',async()=>{
 const v=vault({'One.md':'Same.','Two.md':'Same.'});let asked=false;
 const p=plugin(v,'{}');p.makeApiRequest=async()=>{asked=true;return '{}';};
 const r=await p.generateMergeDraft(v.file('One.md'),v.file('Two.md'));
 assert.equal(asked,false);assert.equal(r.counts.shared,1);assert.equal(r.path,'Merge draft - One + Two.md');
});
test('choosing the same note twice is refused',async()=>{
 const v=vault({'One.md':'a'});const p=plugin(v,'{}');
 await assert.rejects(p.generateMergeDraft(v.file('One.md'),v.file('One.md')),e=>e.kind==='merge');
});
test('a note that cannot be merged is named before anything is sent',async()=>{
 const v=vault({'Plan.md':'a[^1]\n\n[^1]: n','Two.md':'b','Empty.md':'---\nx: 1\n---\n'});const p=plugin(v,'{}');let asked=false;p.makeApiRequest=async()=>{asked=true;return '{}';};
 assert.deepEqual(plain(await p.mergeBlocker(v.file('Plan.md'),v.file('Two.md'))),{text:'"Plan" has footnotes. Their numbers would clash, so this version does not merge notes with footnotes.',side:'A'});
 assert.equal((await p.mergeBlocker(v.file('Two.md'),v.file('Empty.md'))).side,'B');
 await assert.rejects(p.generateMergeDraft(v.file('Two.md'),v.file('Empty.md')),e=>e.kind==='merge'&&e.side==='B');
 assert.equal(asked,false);assert.equal(await p.mergeBlocker(v.file('Two.md'),v.file('Plan.md')).then(r=>r.side),'B');
});
