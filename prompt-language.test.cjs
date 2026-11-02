const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function load(language,stored={}){
 const module={exports:{}};
 const obsidian=Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]));
 obsidian.getLanguage=()=>language;
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{window:{setTimeout,clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto},module,console,TextEncoder,TextDecoder,btoa,atob,escape,unescape,require:()=>obsidian});
 const p=new module.exports();p.loadData=async()=>JSON.parse(JSON.stringify(stored));p.saveData=async()=>{};
 return p;
}
const cjk=/[㐀-鿿]/;
test('an English interface sends the default prompts in English',async()=>{
 const p=load('en');await p.loadSettings();
 for(const prompt of [p.getStructurizerPrompt('Some text'),p.getMetaPrompt('Some text',true,true),p.getTaggerPrompt(['a/b'],'Some text'),p.getMoverPrompt(['Notes'],'Some text'),p.getTitleOnlyPrompt('Some text'),p.getSmartActionPrompt('summarize','Some text'),p.getMetaTaskDescription(true,false)]){
  assert.doesNotMatch(prompt,cjk,prompt.slice(0,80));
 }
 p.settings.taggerExistingOnly=true;assert.match(p.getTaggerPrompt(['a/b'],'Some text'),/Extra rule/);
});
test('a Chinese interface keeps the Chinese prompts',async()=>{
 const p=load('zh');await p.loadSettings();
 assert.match(p.getStructurizerPrompt('正文'),/笔记结构化编辑/);
 assert.match(p.getMetaPrompt('正文'),/内容分析和总结专家/);
});
test('an edited prompt is sent as written, whatever the interface language',async()=>{
 const p=load('en',{taggerPrompt:'我的提示词 {{content}}'});await p.loadSettings();
 assert.equal(p.getTaggerPrompt([],'X'),'我的提示词 X');
});
test('tag translation keeps the target language chosen in settings',async()=>{
 const p=load('en',{taggerTranslationTargetLanguage:'日本語'});await p.loadSettings();
 const prompt=p.getTranslationPrompt(['machine learning']);
 assert.match(prompt,/日本語 tag/);assert.match(prompt,/machine learning/);
});
