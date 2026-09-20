const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element {
 constructor(tag='div',options={}){this.tag=tag;this.options=options;this.children=[];this.style={};this.events={};}
 createEl(tag,options){const child=new Element(tag,options);this.children.push(child);return child;}
 createDiv(options){return this.createEl('div',options);}
 addEventListener(event,callback){this.events[event]=callback;}
}
test('quick actions are named native buttons and retain their original callbacks',()=>{
 const module={exports:{}};const context={module,console,require:()=>Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]))};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8')+'\nmodule.exports=AssistantView;',context);
 let undone=0,redone=0;
 const view=Object.create(module.exports.prototype);view.plugin={settings:{customActions:[]},rollbackLastChange:()=>undone++,redoLastRollback:()=>redone++};
 const root=new Element();view.renderQuickActions(root);
 const grid=root.children[0].children.find(c=>c.options.cls==='ai-assistant-action-grid');
 assert.equal(grid.children.length,4);
 for(const button of grid.children){assert.equal(button.tag,'button');assert.equal(button.options.attr.type,'button');assert.ok(button.options.attr['aria-label']);}
 grid.children[0].events.click();grid.children[1].events.click();assert.equal(undone,1);assert.equal(redone,1);
});
