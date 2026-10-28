const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(text='') {
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{window:{setTimeout,clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto},module,console,TextEncoder,TextDecoder,require:()=>Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]))});
 const p=new module.exports(),file={path:'sample.md',basename:'sample'};let current=text,writes=0,task;
 p.settings={rollbackHistory:[],rollbackRedoHistory:[]};p.saveSettings=async()=>{};
 p.app={vault:{read:async()=>current,getAbstractFileByPath:()=>file,process:async(_,fn)=>{current=fn(current);writes++;}}};
 p.view={getTask:()=>task,updateTask:(_,props)=>Object.assign(task,props),render:()=>{}};
 p.addToHistory=()=>{};p.generateFileId=()=>'';
 return {p,file,set(v){current=v;},get text(){return current;},get writes(){return writes;},task(after){task={id:'t',type:'diff-preview',content:{file,originalContent:current,proposedContent:after}};return task;}};
}
test('exact reconstruction across inserts, deletes, repeated lines, CRLF and final newline',()=>{
 const {p}=fixture();const pairs=[['','x'],['x',''],['a\r\nb\r\n','a\r\nB\r\n'],['a\nb','a\nb\n'],['x\nx\ny\n','x\ny\nx\n']];
 let seed=42;const next=()=>((seed=(seed*1664525+1013904223)>>>0)%5);for(let k=0;k<120;k++)pairs.push([Array.from({length:next()+1},()=>String(next())+'\n').join(''),Array.from({length:next()+1},()=>String(next())+'\n').join('')]);
 for(const [a,b] of pairs){const h=p.buildReviewHunks(a,b);assert.equal(p.composeReviewContent(a,h,[]),a);assert.equal(p.composeReviewContent(a,h,h.map(x=>x.id)),b);}
});
test('partial acceptance changes only the selected range',()=>{
 const {p}=fixture();const a='first\nkeep\nlast\n',b='FIRST\nkeep\nLAST\n',h=p.buildReviewHunks(a,b);
 assert.equal(h.length,2);assert.equal(p.composeReviewContent(a,h,[h[1].id]),'first\nkeep\nLAST\n');
});
test('YAML, fenced code and oversized comparisons are atomic',()=>{
 const {p}=fixture();for(const [a,b] of [['---\ntags: [a]\n---\nbody','---\ntags: [b]\n---\nbody'],['```js\na\n```','```js\nb\n```'],['a\n'.repeat(1001),'b\n'.repeat(1001)]]){const h=p.buildReviewHunks(a,b);assert.equal(h.length,1);assert.equal(h[0].atomic,true);assert.equal(p.composeReviewContent(a,h,[0]),b);}
});
test('accepted subset is snapshotted, exact task undo restores it, duplicate apply is inert',async()=>{
 const f=fixture('one\nkeep\ntwo\n'),t=f.task('ONE\nkeep\nTWO\n');t.content.reviewHunks=f.p.buildReviewHunks(t.content.originalContent,t.content.proposedContent);t.content.reviewSelected=[1];
 await f.p.applyDiffPreview('t');assert.equal(f.text,'one\nkeep\nTWO\n');assert.ok(t.content.reviewSnapshotId);
 await f.p.applyDiffPreview('t');assert.equal(f.writes,1);
 await f.p.undoReviewTask('t');assert.equal(f.text,'one\nkeep\ntwo\n');assert.equal(t.content.applied,false);
});
test('later user edits block both apply and task undo; deselect all writes nothing',async()=>{
 const f=fixture('old'),t=f.task('new');t.content.reviewSelected=[];await f.p.applyDiffPreview('t');assert.equal(f.writes,0);
 t.content.reviewSelected=[0];f.set('user');await f.p.applyDiffPreview('t');assert.equal(f.text,'user');assert.equal(f.writes,0);
 f.set('old');await f.p.applyDiffPreview('t');f.set('new plus user');await f.p.undoReviewTask('t');assert.equal(f.text,'new plus user');assert.equal(t.content.applied,true);
});
