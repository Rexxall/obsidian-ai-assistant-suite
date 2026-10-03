const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class El {
 constructor(tag='div',o={}){this.tag=tag;this.options=o;this.children=[];this.style={};this.events={};this.attrs=o.attr||{};}
 createEl(t,o={}){let e=new El(t,o);this.children.push(e);return e;} createDiv(o){return this.createEl('div',o);} createSpan(o){return this.createEl('span',o);} empty(){this.children=[];} addClass(){} setText(t){this.options.text=t;} setAttr(k,v){this.attrs[k]=v;} setAttribute(k,v){this.attrs[k]=v;} addEventListener(k,v){this.events[k]=v;}
}
function fixture(file={basename:'Example',path:'Example.md',extension:'md',parent:{path:'/'}}){
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8')+'\nmodule.exports=AssistantView;',{module,console,require:()=>Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]))});
 let runArgs,resolve;const v=Object.create(module.exports.prototype);v.tasks=[];v.containerEl={children:[new El(),new El()]};v.plugin={settings:{oneClickProcessActions:{tagger:true},customActions:[]},app:{workspace:{getActiveFile:()=>file}},getRecentHistory:()=>[],runOneClickSmartProcess:(...a)=>{runArgs=a;return new Promise(r=>resolve=r);}};
 v.renderTask=(el,t)=>el.createEl('article',{text:t.id});v.render();
 const all=(e=v.containerEl.children[1])=>[e,...e.children.flatMap(all)];
 return {v,all,button:text=>all().find(e=>e.tag==='button'&&e.options.text===text),get args(){return runArgs;},finish:()=>resolve()};
}
test('prepare shows the note and work choices without rendering unrelated history/tools',()=>{const f=fixture();assert.ok(f.all().some(e=>e.options.text==='Example'));assert.ok(f.button('生成修改建议 →'));assert.ok(!f.all().some(e=>e.options.text==='快速操作'));assert.ok(!f.all().some(e=>e.options.text==='待审阅结果'));});
test('missing/non-Markdown note disables generation; no chosen steps also disables it',()=>{for(const file of [null,{extension:'pdf'}])assert.equal(fixture(file).button('生成修改建议 →').disabled,true);const f=fixture();f.v.sessionActions={};f.v.render();assert.equal(f.button('生成修改建议 →').disabled,true);});
test('new tasks enter focused review, result switching preserves all tasks',()=>{const f=fixture();f.v.addTask({id:'a',title:'A'});f.v.addTask({id:'b',title:'B'});assert.equal(f.v.workbenchPage,'review');assert.deepEqual(f.all().filter(e=>e.tag==='article').map(e=>e.options.text),['b']);const select=f.all().find(e=>e.tag==='select');select.value='a';select.onchange();assert.deepEqual(f.all().filter(e=>e.tag==='article').map(e=>e.options.text),['a']);assert.equal(f.v.tasks.length,2);});
test('starting a task pins note and selection, prevents duplicate clicks and releases busy state',async()=>{const f=fixture();const button=f.button('生成修改建议 →');const pending=button.onclick();await button.onclick();assert.equal(f.v.workbenchRunning,true);assert.equal(f.v.workbenchPage,'review');assert.equal(f.args[0].path,'Example.md');assert.equal(f.args[1].tagger,true);f.finish();await pending;assert.equal(f.v.workbenchRunning,false);});
test('cancelling a workbench sequence stops before starting the next model step',async()=>{
 const module={exports:{}};class Notice{setMessage(){} hide(){}}
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{module,console,TextEncoder,TextDecoder,require:()=>({...Object.fromEntries(['Plugin','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}])),Notice})});
 const p=new module.exports();p.app={};p.settings={apiConfigs:[{enabled:true}]};p.hasStoredApiKey=()=>true;let stopped=false,second=0;p.runAiStructurizer=async()=>{stopped=true};p.runAiFurigana=async()=>{second++};
 await p.runOneClickSmartProcess({path:'test.md'},{structurizer:true,furigana:true},()=>stopped);assert.equal(second,0);
});
