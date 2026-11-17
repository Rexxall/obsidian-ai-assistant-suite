const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class El {
 constructor(tag='div',o={}){this.tag=tag;this.options=o;this.children=[];this.style={};this.events={};this.attrs=o.attr||{};this.textContent=o.text;}
 createEl(t,o={}){const e=new El(t,o);this.children.push(e);return e;} createDiv(o){return this.createEl('div',o);} createSpan(o){return this.createEl('span',o);} empty(){this.children=[];} appendText(){} addClass(){} toggleClass(){} setText(t){this.options.text=t;} setAttr(k,v){this.attrs[k]=v;} addEventListener(k,v){this.events[k]=v;}
}
const all=e=>[e,...e.children.flatMap(all)];

test('stopping a batch skips the remaining notes, keeps finished suggestions and frees the panel',async()=>{
 const module={exports:{}};class Notice{setMessage(){} hide(){}}
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8')+'\nmodule.exports={View:AssistantView,Plugin:module.exports};',{window:{setTimeout:f=>setTimeout(f,0),clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto},module,console,TextEncoder,TextDecoder,require:()=>({...Object.fromEntries(['Plugin','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}])),Notice})});
 const {View,Plugin}=module.exports;
 const p=new Plugin();const v=Object.create(View.prototype);v.tasks=[];v.plugin=p;v.render=()=>{};
 p.view=v;p.refreshAssistantViews=()=>{};p.activateView=async()=>{};p.describeBatchSend=()=>({notes:3,bytes:0,size:'1 KB',destinations:[]});
 const files=['a','b','c'].map(n=>({basename:n,path:n+'.md',extension:'md'}));
 const processed=[];
 p.runOneClickSmartProcess=async file=>{
  processed.push(file.basename);
  v.addTask({id:'s-'+file.basename,type:'one-click',status:'displaying',content:{file,suggestions:{tags:[{final:'t',display:'t',is_new:false}]}}});
  if(file.basename==='a'){
   // The user presses the stop button on the batch card while the first note is being processed.
   const batch=v.tasks.find(t=>t.type==='batch-process');const card=new El();v.renderBatchProcessTask(card,batch);
   const stop=all(card).find(e=>e.tag==='button'&&e.options.cls==='mod-warning interrupt-btn');assert.ok(stop);stop.events.click();
   assert.equal(stop.disabled,true);
   // A re-render while stopping keeps the button disabled instead of offering Stop again.
   const again=new El();v.renderBatchProcessTask(again,batch);assert.equal(all(again).find(e=>e.options.cls==='mod-warning interrupt-btn').disabled,true);
  }
 };
 await p.runBatchProcess(files);
 assert.deepEqual(processed,['a']);
 assert.ok(v.getTask('s-a'),'suggestions made before the stop are kept');
 const batch=v.tasks.find(t=>t.type==='batch-process');
 assert.equal(batch.content.canInterrupt,false);assert.match(batch.content.message,/中断/);
 // Nothing is left marked as running, so review and confirm are available again.
 assert.ok(!v.tasks.some(t=>t.type==='batch-process'&&t.content?.canInterrupt));
 const card=new El();v.renderBatchProcessTask(card,batch);
 assert.ok(!all(card).some(e=>e.options.cls==='mod-warning interrupt-btn'));
 assert.ok(all(card).some(e=>e.tag==='button'&&e.options.text==='关闭'));
});

test('a new batch starts with the stop flag cleared',async()=>{
 const module={exports:{}};class Notice{setMessage(){} hide(){}}
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8')+'\nmodule.exports={View:AssistantView,Plugin:module.exports};',{window:{setTimeout:f=>setTimeout(f,0),clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto},module,console,TextEncoder,TextDecoder,require:()=>({...Object.fromEntries(['Plugin','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}])),Notice})});
 const {View,Plugin}=module.exports;
 const p=new Plugin();const v=Object.create(View.prototype);v.tasks=[];v.plugin=p;v.render=()=>{};
 p.view=v;p.refreshAssistantViews=()=>{};p.activateView=async()=>{};p.describeBatchSend=()=>({notes:2,bytes:0,size:'1 KB',destinations:[]});
 p.batchProcessInterrupted=true;const processed=[];p.runOneClickSmartProcess=async f=>{processed.push(f.basename);};
 await p.runBatchProcess([{basename:'a',path:'a.md'},{basename:'b',path:'b.md'}]);
 assert.deepEqual(processed,['a','b']);
});
