const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class El {
 constructor(tag='div',o={}){this.tag=tag;this.options=o;this.children=[];this.style={};this.events={};this.attrs=o.attr||{};}
 createEl(t,o={}){let e=new El(t,o);this.children.push(e);return e;} createDiv(o){return this.createEl('div',o);} createSpan(o){return this.createEl('span',o);} empty(){this.children=[];} addClass(){} toggleClass(){} setText(t){this.options.text=t;} setAttr(k,v){this.attrs[k]=v;} setAttribute(k,v){this.attrs[k]=v;} addEventListener(k,v){this.events[k]=v;}
}
function fixture(file={basename:'Example',path:'Example.md',extension:'md',parent:{path:'/'}}){
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8')+'\nmodule.exports=AssistantView;',{module,console,require:()=>Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]))});
 let runArgs,resolve;const v=Object.create(module.exports.prototype);v.tasks=[];v.containerEl={children:[new El(),new El()]};v.plugin={settings:{oneClickProcessActions:{tagger:true},customActions:[]},app:{workspace:{getActiveFile:()=>file}},getRecentHistory:()=>[],runOneClickSmartProcess:(...a)=>{runArgs=a;return new Promise(r=>resolve=r);}};
 v.renderTask=(el,t)=>el.createEl('article',{text:t.id});v.render();
 const all=(e=v.containerEl.children[1])=>[e,...e.children.flatMap(all)];
 return {v,all,button:text=>all().find(e=>e.tag==='button'&&e.options.text===text),get args(){return runArgs;},finish:()=>resolve()};
}
test('prepare shows the note and work choices without rendering unrelated history/tools',()=>{const f=fixture();assert.ok(f.all().some(e=>e.options.text==='Example'));assert.ok(f.button('生成建议 →'));assert.ok(!f.all().some(e=>e.options.text==='快速操作'));assert.ok(!f.all().some(e=>e.options.text==='待审阅结果'));});
test('missing/non-Markdown note disables generation; no chosen steps also disables it',()=>{for(const file of [null,{extension:'pdf'}])assert.equal(fixture(file).button('生成建议 →').disabled,true);const f=fixture();f.v.sessionActions={};f.v.render();assert.equal(f.button('生成建议 →').disabled,true);});
test('new tasks enter focused review, result switching preserves all tasks',()=>{const f=fixture();f.v.addTask({id:'a',title:'A'});f.v.addTask({id:'b',title:'B'});assert.equal(f.v.workbenchPage,'review');assert.deepEqual(f.all().filter(e=>e.tag==='article').map(e=>e.options.text),['b']);const select=f.all().find(e=>e.tag==='select');select.value='a';select.onchange();assert.deepEqual(f.all().filter(e=>e.tag==='article').map(e=>e.options.text),['a']);assert.equal(f.v.tasks.length,2);});
test('starting a task pins note and selection, prevents duplicate clicks and releases busy state',async()=>{const f=fixture();const button=f.button('生成建议 →');const pending=button.onclick();await button.onclick();assert.equal(f.v.workbenchRunning,true);assert.equal(f.v.workbenchPage,'review');assert.equal(f.args[0].path,'Example.md');assert.equal(f.args[1].tagger,true);f.finish();await pending;assert.equal(f.v.workbenchRunning,false);});
test('cancelling a workbench sequence stops before starting the next model step',async()=>{
 const module={exports:{}};class Notice{setMessage(){} hide(){}}
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{module,console,TextEncoder,TextDecoder,require:()=>({...Object.fromEntries(['Plugin','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}])),Notice})});
 const p=new module.exports();p.app={};p.settings={apiConfigs:[{enabled:true}]};p.hasStoredApiKey=()=>true;let stopped=false,second=0;p.runAiStructurizer=async()=>{stopped=true};p.runAiFurigana=async()=>{second++};
 await p.runOneClickSmartProcess({path:'test.md'},{structurizer:true,furigana:true},()=>stopped);assert.equal(second,0);
});
test('sidebar and workbench share tasks and selection, and clearing one clears both',()=>{
 const module={exports:{}};class ItemView{constructor(leaf){this.leaf=leaf;this.containerEl={children:[new El(),new El()]};}}
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8')+'\nmodule.exports=AssistantView;',{module,console,require:()=>({...Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','TFile'].map(k=>[k,class{}])),ItemView})});
 const plugin={app:{workspace:{on:()=>({})}},refreshAssistantViews:()=>{}};
 const side=new module.exports({},plugin),full=new module.exports({},plugin,true);side.render=()=>{};full.render=()=>{};
 side.addTask({id:'shared',title:'Shared'});assert.equal(full.tasks[0].id,'shared');assert.equal(full.selectedTaskId,'shared');assert.notEqual(side.getViewType(),full.getViewType());full.clear();assert.equal(side.tasks.length,0);
});
test('a picked note remains the processing target even if another editor is active',async()=>{
 const f=fixture();f.v.pinnedFile={basename:'Picked',path:'Picked.md',extension:'md',parent:{path:'/'}};f.v.render();const p=f.button('生成建议 →').onclick();assert.equal(f.args[0].path,'Picked.md');f.finish();await p;
});
test('processing always opens the sidebar even when a legacy workbench is active',async()=>{
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{module,console,require:()=>Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]))});
 const p=new module.exports();const full={view:{expanded:true}},side={view:{expanded:false}},calls=[];
 p.view=full.view;p.refreshAssistantViews=()=>{};p.app={workspace:{getLeavesOfType:t=>[t==='ai-assistant-workbench-view'?full:side],revealLeaf:async l=>calls.push(l),rightSplit:{collapse:()=>calls.push('collapse'),expand:()=>calls.push('expand')}}};
 await p.activateView();assert.equal(calls[0],side);assert.equal(calls[1],'expand');await p.activateView(true);assert.equal(calls[2],full);assert.equal(calls[3],'collapse');
});
test('a custom action for a picked note cannot inherit another editor selection',async()=>{
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{module,console,require:()=>Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]))});
 const p=new module.exports(),picked={path:'Picked.md'},other={path:'Other.md'};p.app={workspace:{getActiveFile:()=>other,activeEditor:{editor:{getSelection:()=>{throw new Error('wrong editor read')}}}},vault:{read:async f=>{assert.equal(f,picked);return 'Picked note content'}}};
 const c=await p.getCurrentActionContext(picked);assert.equal(c.file,picked);assert.equal(c.selection,'');assert.equal(c.originalContent,'Picked note content');
});

test('sidebar puts five functions directly on the main surface and keeps secondary entries in More',()=>{const f=fixture();assert.equal(f.all().filter(e=>e.attrs['data-action']).length,5);assert.equal(f.all().filter(e=>e.options.cls==='mist-view').length,2);assert.ok(!f.all().some(e=>['at-art','at-document','aw-presets','aw-orb'].includes(e.options.cls)));const more=f.all().find(e=>e.options.cls==='mist-more');assert.ok(more);assert.ok(more.children.some(e=>e.options.text==='更多'));assert.ok(f.all(more).some(e=>e.options.text==='设置'));});

test('note review expands metadata and tags together and retains edits across render',()=>{
 const file={basename:'Note',path:'Note.md',extension:'md',parent:{path:'/'}};const f=fixture(file);
 f.v.addTask({id:'combined',type:'one-click',status:'displaying',content:{file,originalContent:'Body',suggestions:{meta:{title:'Suggested',summary:'Summary',tldr:'Short'},tags:[{final:'topic'}]}}});
 assert.ok(f.all().some(e=>e.options.cls==='mist-paper'));
 assert.ok(f.all().some(e=>e.options.cls==='mist-chips'));
 const title=f.all().find(e=>e.tag==='textarea');title.value='My title';title.oninput();f.v.render();assert.equal(f.all().find(e=>e.tag==='textarea').value,'My title');
 assert.ok(f.all().find(e=>e.tag==='button'&&/^确认这篇 · \d+ 项$/.test(e.options.text||'')));
 f.v.workbenchPage='queue';f.v.render();assert.equal(f.all().filter(e=>e.options.cls==='mist-queue-row').length,1);
});
test('existing non-note tools remain reachable when note results exist',()=>{
 const file={path:'a.md',basename:'a',parent:{path:'/'}};const f=fixture();
 f.v.tasks=[{id:'note',type:'one-click',content:{file,suggestions:{}}}];
 f.v.addTask({id:'custom',type:'custom-action',status:'displaying',content:{text:'Result'}});
 assert.ok(f.all().some(e=>e.tag==='article'&&e.options.text==='custom'));
});

test('the one-line request reaches the AI call and the pills toggle what will be done',async()=>{
 const f=fixture();
 const ask=f.all().find(e=>e.tag==='textarea'&&e.attrs['aria-label']==='补充要求');
 ask.value='标签尽量用库里已有的';ask.oninput();
 const pill=f.all().find(e=>e.attrs['data-action']==='meta');assert.equal(pill.attrs['aria-pressed'],'false');pill.onclick();
 assert.equal(f.all().find(e=>e.attrs['data-action']==='meta').attrs['aria-pressed'],'true');
 const p=f.button('生成建议 →').onclick();assert.equal(f.args[3],'标签尽量用库里已有的');assert.equal(f.args[1].meta,true);f.finish();await p;
});
test('a tag tapped off stays out of the draft and the count follows',()=>{
 const file={basename:'Note',path:'Note.md',extension:'md',parent:{path:'/'}};const f=fixture(file);
 f.v.addTask({id:'combined',type:'one-click',status:'displaying',content:{file,originalContent:'Body',suggestions:{tags:[{final:'keep'},{final:'drop'}]}}});
 f.all().find(e=>e.tag==='button'&&e.options.text==='#drop').onclick();
 const group=f.v.getNoteGroups()[0];assert.deepEqual(f.v.noteDraft(group).tags,['keep']);
 assert.ok(f.all().some(e=>e.tag==='button'&&e.options.text==='#drop'&&e.options.cls==='mist-chip is-off'));
 assert.ok(f.button('确认这篇 · 1 项'));
});
