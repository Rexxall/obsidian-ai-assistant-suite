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
 return {p,file,get text(){return text}};
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
 assert.equal(off.getMetaPrompt('body'),'X body');
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
