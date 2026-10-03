const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class El {
 constructor(tag='div',o={}){this.tag=tag;this.options=o;this.children=[];this.attrs=o.attr||{};this.events={};}
 createEl(tag,o={}){const e=new El(tag,o);this.children.push(e);return e;}createDiv(o){return this.createEl('div',o);}empty(){this.children=[];}addClass(){}setText(text){this.options.text=text;}setAttribute(k,v){this.attrs[k]=v;}
}
function fixture(selected){
 let rendered;const module={exports:{}};
 const stubs=Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]));
 stubs.MarkdownRenderer={render:async(app,text)=>{rendered=text}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8')+'\nmodule.exports={AssistantView,AiAssistantSuite};',{module,console,require:()=>stubs});
 const p=new module.exports.AiAssistantSuite(),v=Object.create(module.exports.AssistantView.prototype),card=new El();v.plugin=p;p.app={};
 const task={id:'preview',content:{file:{path:'demo.md'},originalContent:'# Before\n\nOld paragraph\n',proposedContent:'# After\n\nNew paragraph\n'}};
 task.content.reviewHunks=p.buildReviewHunks(task.content.originalContent,task.content.proposedContent);
 if(selected)task.content.reviewSelected=selected;
 const all=(e=card)=>[e,...e.children.flatMap(all)];v.renderDiffPreviewTask(card,task);
 return {v,p,task,card,all,get rendered(){return rendered;}};
}
test('default preview renders the complete formatted result and does not show hunk columns',()=>{
 const f=fixture();assert.equal(f.rendered,f.task.content.proposedContent);assert.ok(f.all().some(e=>e.options.text==='应用整篇优化'));assert.ok(!f.all().some(e=>e.options.text==='原内容'));assert.ok(f.all().some(e=>e.options.text==='查看具体修改'));
});
test('original tab renders original text without changing the proposed content or accepted selection',()=>{
 const f=fixture();const selection=[...f.task.content.reviewSelected];f.all().find(e=>e.options.text==='原文').onclick();assert.equal(f.rendered,f.task.content.originalContent);assert.deepEqual([...f.task.content.reviewSelected],selection);assert.equal(f.task.content.proposedContent,'# After\n\nNew paragraph\n');
});
test('full article reflects selective acceptance instead of silently restoring skipped changes',()=>{
 const f=fixture([0]);assert.equal(f.rendered,f.p.composeReviewContent(f.task.content.originalContent,f.task.content.reviewHunks,[0]));assert.ok(f.all().some(e=>e.options.text==='应用所选修改'));
});
