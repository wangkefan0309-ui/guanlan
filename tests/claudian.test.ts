import { describe,it,expect } from 'vitest';
import { ClaudianBridge, type ClaudianVerificationStore } from '../src/plugin/claudian';
import { KnowledgePipeline } from '../src/core/knowledge';
import { ReadingLibrary } from '../src/core/library';
import type {FileStore} from '../src/core/model';
async function setup(){
 const data=new Map<string,Uint8Array>();let fail='';const files:FileStore={read:async path=>data.has(path)?new TextDecoder().decode(data.get(path)):null,readBinary:async path=>data.get(path)??null,write:async(path,text)=>{if(fail&&path.includes(fail))throw new Error('磁盘失败');data.set(path,new TextEncoder().encode(text));},writeBinary:async(path,bytes)=>{data.set(path,bytes);}};
 const library=new ReadingLibrary(files,'09_测试'),pipeline=new KnowledgePipeline(files,library.root);
 const item=await library.import({title:'材料',source:'测试',identity:'test:1',topic:'ai-learning',kind:'markdown',body:'正文',coverage:'full',capturedAt:new Date().toISOString(),original:{extension:'md',base64:Buffer.from('正文').toString('base64')}});
 let sent=0,created=0,draft='',wrongTab=false;const conversations:any[]=[];const tab:any={conversationId:null,state:{messages:[],isStreaming:false},controllers:{drafts:{capture:()=>({content:draft,images:[]})},inputController:{sendMessage:()=>{sent++;tab.state.messages.push({role:'user',content:draft});draft='';}}}};
 const host={getConversationSummary:(id:string)=>conversations.find(c=>c.id===id),getConversationList:()=>conversations.map(c=>({id:c.id})),getConversationSync:(id:string)=>conversations.find(c=>c.id===id),conversationLifecycle:{isRunning:(_id:string)=>false},renameConversation:async()=>{},createConversation:async(options:any)=>{const result={id:`conv-${++created}`,...options};conversations.push(result);return result;}};
 const manager={openConversation:async(id:string)=>{const previous=conversations.find(c=>c.id===tab.conversationId);if(previous)previous.messages=tab.state.messages;tab.conversationId=wrongTab?'other':id;tab.state.messages=conversations.find(c=>c.id===tab.conversationId)?.messages??[];},getActiveTab:()=>tab};
 const view={plugin:host,getTabManager:()=>manager,appendToActiveInput:(text:string)=>{draft+=text;return true;},focusActiveInput:()=>{}};
 const plugin:any={chatHost:host,manifest:{version:'2.3.17'},settings:{lastSelectedChatModel:{providerId:'codex',model:'gpt-6.1-sol'}},views:{activateView:async()=>{},getView:()=>view}};
 const app:any={plugins:{plugins:{realclaudian:plugin}}};
 return{files,item,pipeline,bridge:new ClaudianBridge(app),app,plugin,conversations,tab,counts:()=>({sent,created}),setFail:(value:string)=>{fail=value;},setDraft:(value:string)=>{draft=value;},setWrong:()=>{wrongTab=true;}};
}
describe('Claudian 适配的用户体验与失败恢复',()=>{
 it('Claudian 配置未加载时显示原因并保留材料，不创建或发送会话',async()=>{
  const s=await setup();delete s.plugin.settings;expect(s.bridge.available()).toContain('配置尚未加载');await expect(s.bridge.open(s.pipeline,s.item,false,'direct-wiki')).rejects.toThrow('配置尚未加载');expect(s.counts()).toEqual({sent:0,created:0});
 });
 it('直接归纳明确授权客观 Wiki 完成，重复点击和重启均不重复发送',async()=>{
  const s=await setup();await Promise.all([s.bridge.open(s.pipeline,s.item,false,'direct-wiki'),s.bridge.open(s.pipeline,s.item,false,'direct-wiki')]);
  const receipt=(await s.pipeline.receipt(s.item))!;expect(receipt.mode).toBe('direct-wiki');expect(receipt.wikiSubmittedAt).toBeTruthy();
  const prompt=s.tab.state.messages[0].content;expect(prompt).toContain('无需等待讨论或再次确认');expect(prompt).toContain('finalize/completed');expect(prompt).toContain('不结合阅读批注或聊天中的个人想法');expect(prompt).toContain('不写 fanOS');
  await new ClaudianBridge(s.app).open(s.pipeline,s.item);expect(s.counts()).toEqual({sent:1,created:1});
 });
 it('直接归纳的排队选择持久保存，重启自动出队沿用选择',async()=>{
  const s=await setup();let running=true;s.conversations.push({id:'other',linkedContentPath:'09_测试/知识接续/other.md'});s.plugin.chatHost.conversationLifecycle.isRunning=(id:string)=>id==='other'&&running;
  await s.bridge.open(s.pipeline,s.item,false,'direct-wiki');expect(s.counts().sent).toBe(0);expect((await s.pipeline.receipt(s.item))?.mode).toBe('direct-wiki');
  running=false;const restored=new KnowledgePipeline(s.files,'09_测试');await new ClaudianBridge(s.app).open(restored,s.item,true);expect(s.tab.state.messages[0].content).toContain('无需等待讨论');expect(s.counts()).toEqual({sent:1,created:1});
 });
 it('已交付讨论底稿的材料复用原会话，直接归纳仅追加一次同 run 指令',async()=>{
  const s=await setup();await s.bridge.open(s.pipeline,s.item);const original=(await s.pipeline.receipt(s.item))!;
  await Promise.all([s.bridge.open(s.pipeline,s.item,false,'direct-wiki'),s.bridge.open(s.pipeline,s.item,false,'direct-wiki')]);
  expect(s.counts()).toEqual({sent:2,created:1});expect((await s.pipeline.receipt(s.item))?.conversationId).toBe(original.conversationId);expect(s.tab.state.messages[1].content).toContain('继续已有同一 run');
 });
 it('原任务仍在运行时直接归纳先排队，可取消；取消不会撤销已有提交',async()=>{
  const s=await setup();await s.bridge.open(s.pipeline,s.item);s.plugin.chatHost.conversationLifecycle.isRunning=()=>true;
  expect(await s.bridge.open(s.pipeline,s.item,false,'direct-wiki')).toContain('队列');expect(s.counts().sent).toBe(1);
  await s.pipeline.cancelQueued(s.item);expect((await s.pipeline.receipt(s.item))?.submittedAt).toBeTruthy();s.plugin.chatHost.conversationLifecycle.isRunning=()=>false;
  await new ClaudianBridge(s.app).open(s.pipeline,s.item,true);expect(s.counts().sent).toBe(1);
  await s.bridge.open(s.pipeline,s.item,false,'direct-wiki');expect(s.counts().sent).toBe(2);
 });
 it('已有讨论的直接归纳自动出队等待用户草稿，保存发送意图失败时不碰输入框',async()=>{
  const s=await setup();await s.bridge.open(s.pipeline,s.item);await s.pipeline.chooseMode(s.item,'direct-wiki');s.setDraft('我尚未写完的想法');
  expect(await s.bridge.open(s.pipeline,s.item,true)).toContain('仍在排队');expect(s.counts().sent).toBe(1);s.setDraft('');s.setFail('/_工作台/知识接续/');
  await expect(s.bridge.open(s.pipeline,s.item,true)).rejects.toThrow('磁盘失败');expect(s.counts().sent).toBe(1);expect((await s.pipeline.receipt(s.item))?.wikiSubmittedAt).toBeUndefined();
  s.setFail('');await s.bridge.open(s.pipeline,s.item,true);expect(s.counts().sent).toBe(2);
 });
 it('直接归纳追加发送失败时保留未知意图，重复点击不重新发送',async()=>{
  const s=await setup();await s.bridge.open(s.pipeline,s.item);let attempts=0;s.tab.controllers.inputController.sendMessage=()=>{attempts++;return Promise.reject(new Error('未知'));};
  await s.bridge.open(s.pipeline,s.item,false,'direct-wiki');await new ClaudianBridge(s.app).open(s.pipeline,s.item,false,'direct-wiki');expect(attempts).toBe(1);expect((await s.pipeline.receipt(s.item))?.wikiSubmittedAt).toBeTruthy();
 });
 it('未选择直接归纳的旧材料仍默认等待讨论',async()=>{
  const s=await setup();await s.bridge.open(s.pipeline,s.item);expect(s.tab.state.messages[0].content).toContain('默认完成讨论底稿');expect((await s.pipeline.receipt(s.item))?.wikiSubmittedAt).toBeUndefined();
 });
 it('用户明确跨会话恢复保留旧会话，只发送只读恢复指令，重复点击不复制任务',async()=>{const s=await setup();await s.bridge.open(s.pipeline,s.item);const old=(await s.pipeline.receipt(s.item))!.conversationId;await Promise.all([s.bridge.recover(s.pipeline,s.item),s.bridge.recover(s.pipeline,s.item)]);const receipt=(await s.pipeline.receipt(s.item))!;expect(receipt.previousConversationId).toBe(old);expect(receipt.conversationId).not.toBe(old);expect(receipt.recovery).toBe(true);expect(s.counts()).toEqual({sent:2,created:2});expect(s.tab.state.messages.at(-1).content).toContain('不重新摄入');expect(s.conversations.some(c=>c.id===old)).toBe(true);});
 it('自动出队不切走正在写草稿或接收回复的聊天，空闲后恢复且只提交一次',async()=>{const s=await setup();await s.pipeline.prepare(s.item);await s.pipeline.markQueued(s.item);s.tab.conversationId='user-chat';s.setDraft('还没有写完的问题');expect(await s.bridge.open(s.pipeline,s.item,true)).toContain('仍在排队');expect(s.counts()).toEqual({sent:0,created:0});expect(s.tab.conversationId).toBe('user-chat');s.setDraft('');s.tab.state.isStreaming=true;expect(await s.bridge.open(s.pipeline,s.item,true)).toContain('仍在排队');expect(s.counts().created).toBe(0);s.tab.state.isStreaming=false;await new ClaudianBridge(s.app).open(s.pipeline,s.item,true);expect(s.counts()).toEqual({sent:1,created:1});});
 it('已绑定空会话改成 Flash 后也不能加工 RAW，保留待提交记录',async()=>{const s=await setup();await s.pipeline.prepare(s.item);await s.pipeline.bind(s.item,'existing');s.conversations.push({id:'existing',selectedModel:'deepseek-flash'});await expect(s.bridge.open(s.pipeline,s.item)).rejects.toThrow('Flash');expect(s.counts().sent).toBe(0);expect((await s.pipeline.receipt(s.item))?.submittedAt).toBeUndefined();});
 it('原生发送结果未知且没有消息回执时，重试只打开会话不自动再发',async()=>{const s=await setup();let attempts=0;s.tab.controllers.inputController.sendMessage=()=>{attempts++;return Promise.reject(new Error('提供方结果未知'));};await s.bridge.open(s.pipeline,s.item);await s.bridge.open(s.pipeline,s.item);expect(attempts).toBe(1);expect((await s.pipeline.receipt(s.item))?.submittedAt).toBeTruthy();});
 it('另一 RAW 正在加工时持久化排队，不建聊天或抢焦点；取消后后台不能发送，空闲后只提交一次',async()=>{const s=await setup();let running=true;s.conversations.push({id:'other',linkedContentPath:'09_测试/知识接续/other.md'});s.plugin.chatHost.conversationLifecycle.isRunning=(id:string)=>id==='other'&&running;expect(await s.bridge.open(s.pipeline,s.item)).toContain('队列');expect(s.counts()).toEqual({sent:0,created:0});expect((await s.pipeline.receipt(s.item))?.queuedAt).toBeTruthy();await s.pipeline.cancelQueued(s.item);running=false;await new ClaudianBridge(s.app).open(s.pipeline,s.item,true);expect(s.counts().sent).toBe(0);running=true;await s.bridge.open(s.pipeline,s.item);running=false;await s.bridge.open(s.pipeline,s.item,true);expect(s.counts()).toEqual({sent:1,created:1});});
 it('已有用户草稿不被覆盖或自动发出',async()=>{const s=await setup();s.setDraft('我正在写的问题');await expect(s.bridge.open(s.pipeline,s.item)).rejects.toThrow('已有未发送草稿');expect(s.counts().sent).toBe(0);});
 it('并发点击同材料只创建并发送一次，重启后继续同一会话',async()=>{const s=await setup();await Promise.all([s.bridge.open(s.pipeline,s.item),s.bridge.open(s.pipeline,s.item)]);expect(s.counts()).toEqual({sent:1,created:1});await new ClaudianBridge(s.app).open(s.pipeline,s.item);expect(s.counts().sent).toBe(1);});
 it('绑定保存失败后按关联文件恢复空会话，不制造第二会话或重复请求',async()=>{const s=await setup();await s.pipeline.prepare(s.item);s.setFail('/_工作台/知识接续/');await expect(s.bridge.open(s.pipeline,s.item)).rejects.toThrow('磁盘失败');expect(s.counts()).toEqual({sent:0,created:1});s.setFail('');await s.bridge.open(s.pipeline,s.item);expect(s.counts()).toEqual({sent:1,created:1});});
 it('发送意图保存失败时不碰输入框，恢复保存后只提交一次',async()=>{const s=await setup();await s.pipeline.prepare(s.item);await s.pipeline.bind(s.item,'existing');s.conversations.push({id:'existing'});s.setFail('/_工作台/知识接续/');await expect(s.bridge.open(s.pipeline,s.item)).rejects.toThrow('磁盘失败');s.setFail('');await s.bridge.open(s.pipeline,s.item);expect(s.counts().sent).toBe(1);});
 it('不存在、不兼容、Flash、会话删除及切页失败都不发送',async()=>{const s=await setup();delete s.app.plugins.plugins.realclaudian;await expect(s.bridge.open(s.pipeline,s.item)).rejects.toThrow('启用 Claudian');s.app.plugins.plugins.realclaudian=s.plugin;s.plugin.manifest.version='3.0.0';await expect(s.bridge.open(s.pipeline,s.item)).rejects.toThrow('尚未验证');s.plugin.manifest.version='2.3.17';s.plugin.settings.lastSelectedChatModel.model='deepseek-flash';await expect(s.bridge.open(s.pipeline,s.item)).rejects.toThrow('Flash');s.plugin.settings.lastSelectedChatModel.model='gpt-6.1-sol';s.setWrong();await expect(s.bridge.open(s.pipeline,s.item)).rejects.toThrow('没有发送');expect(s.counts().sent).toBe(0);s.conversations.length=0;await expect(s.bridge.open(s.pipeline,s.item)).rejects.toThrow('会话已删除');});
});

describe('Claudian 更新后的本地接口验证',()=>{
 async function candidate(){const s=await setup();s.plugin.manifest.version='2.3.27';let saved:unknown=null;
  const store:ClaudianVerificationStore={load:async()=>saved,save:async value=>{saved=structuredClone(value);}};
  return {...s,store,bridge:new ClaudianBridge(s.app,store),saved:()=>saved};
 }
 it('新版本显式验证后解锁并持久保存，重启复用，重复接续仍只发送一次',async()=>{
  const s=await candidate();s.setDraft('用户尚未发送的草稿');expect(s.bridge.available()).toContain('尚未验证');
  expect(await s.bridge.verify()).toContain('验证通过');expect(s.counts()).toEqual({sent:0,created:0});expect(s.tab.conversationId).toBeNull();
  expect(s.tab.controllers.drafts.capture().content).toBe('用户尚未发送的草稿');
  const restored=new ClaudianBridge(s.app,s.store);await restored.loadVerification();expect(restored.available()).toBe('');
  await expect(restored.open(s.pipeline,s.item)).rejects.toThrow('已有未发送草稿');s.setDraft('');
  await restored.open(s.pipeline,s.item);await restored.open(s.pipeline,s.item);expect(s.counts()).toEqual({sent:1,created:1});
  s.plugin.manifest.version='2.3.28';expect(restored.available()).toContain('尚未验证');await expect(restored.open(s.pipeline,s.item)).rejects.toThrow('尚未验证');
 });
 it('未打开聊天时只打开视图验证，不新建会话或发送消息',async()=>{
  const s=await candidate(),view=s.plugin.views.getView();let opened=0;s.plugin.views.getView=()=>opened?view:null;s.plugin.views.activateView=async()=>{opened++;};
  await s.bridge.verify();expect(opened).toBe(1);expect(s.counts()).toEqual({sent:0,created:0});
 });
 it('已存在视图但没有聊天页时自动准备空白页，不创建材料会话或发送消息',async()=>{
  const s=await candidate(),manager=s.plugin.views.getView().getTabManager();let ready=false,opened=0,prepared=0;
  manager.getActiveTab=()=>ready?s.tab:null;manager.createTab=async()=>{prepared++;ready=true;};s.plugin.views.activateView=async()=>{opened++;};
  await s.bridge.verify();expect(opened).toBe(1);expect(prepared).toBe(1);expect(s.bridge.available()).toBe('');expect(s.counts()).toEqual({sent:0,created:0});
 });
 it('缺少任一会话、草稿、发送和队列保护接口时拒绝保存',async()=>{
  for(const key of ['createConversation','renameConversation','getConversationSummary','getConversationList','getConversationSync']){
   const s=await candidate();delete s.plugin.chatHost[key];await expect(s.bridge.verify()).rejects.toThrow('不兼容');expect(s.saved()).toBeNull();expect(s.bridge.available()).toContain('尚未验证');
  }
  for(const breakContract of [(s:any)=>delete s.plugin.chatHost.conversationLifecycle.isRunning,(s:any)=>delete s.tab.controllers.drafts.capture,(s:any)=>delete s.tab.controllers.inputController.sendMessage,(s:any)=>s.tab.state.messages=null,(s:any)=>s.tab.controllers.drafts.capture=()=>({content:'missing images'})]){
   const s=await candidate();breakContract(s);await expect(s.bridge.verify()).rejects.toThrow('不兼容');expect(s.saved()).toBeNull();expect(s.counts()).toEqual({sent:0,created:0});
  }
 });
 it('配置未加载、插件禁用、未知版本和空聊天页均给出可操作原因',async()=>{
  const s=await candidate();delete s.plugin.settings;await expect(s.bridge.verify()).rejects.toThrow('配置尚未加载');s.plugin.settings={};
  delete s.plugin.manifest.version;expect(s.bridge.available()).toContain('尚未验证');await expect(s.bridge.verify()).rejects.toThrow('无法识别');s.plugin.manifest.version='2.3.27';
  s.plugin.views.getView().getTabManager().getActiveTab=()=>null;await expect(s.bridge.verify()).rejects.toThrow('打开一个聊天页');
  delete s.app.plugins.plugins.realclaudian;await expect(s.bridge.verify()).rejects.toThrow('启用 Claudian');expect(s.saved()).toBeNull();
 });
 it('保存失败不解锁，修复存储后可再次验证',async()=>{
  const s=await candidate();let fail=true;const save=s.store.save;s.store.save=async r=>{if(fail)throw Error('磁盘失败');await save(r);};
  await expect(s.bridge.verify()).rejects.toThrow('磁盘失败');expect(s.bridge.available()).toContain('尚未验证');fail=false;await s.bridge.verify();expect(s.bridge.available()).toBe('');
 });
 it('损坏、不匹配或旧适配版本回执均不放行；读取失败仍可显式重验',async()=>{
  const s=await candidate();for(const stored of [null,{},'bad',{adapter:1,version:'2.3.26',verifiedAt:new Date().toISOString()},{adapter:0,version:'2.3.27',verifiedAt:new Date().toISOString()}]){
   s.store.load=async()=>stored;const restored=new ClaudianBridge(s.app,s.store);await restored.loadVerification();expect(restored.available()).toContain('尚未验证');
  }
  s.store.load=async()=>{throw Error('读取失败');};await s.bridge.loadVerification();await s.bridge.verify();expect(s.bridge.available()).toBe('');
 });
 it('视图打开期间更新、重载，或保存期间升级时不解锁',async()=>{
  for(const replacement of [false,true]){const s=await candidate(),view=s.plugin.views.getView();s.plugin.views.getView=()=>null;s.plugin.views.activateView=async()=>{s.plugin.views.getView=()=>view;if(replacement)s.app.plugins.plugins.realclaudian={...s.plugin};else s.plugin.manifest.version='2.3.28';};await expect(s.bridge.verify()).rejects.toThrow('更新或重载');expect(s.saved()).toBeNull();}
  const s=await candidate();s.store.save=async()=>{s.plugin.manifest.version='2.3.28';};await expect(s.bridge.verify()).rejects.toThrow('更新或重载');expect(s.bridge.available()).toContain('尚未验证');
 });
 it('验证后运行接口变化仍保留发送意图与用户草稿，侧聊不能接收 RAW 任务',async()=>{
  const s=await candidate();await s.bridge.verify();s.tab.controllers.drafts.capture=()=>({content:''});await expect(s.bridge.open(s.pipeline,s.item)).rejects.toThrow('草稿读取结果不兼容');expect((await s.pipeline.receipt(s.item))?.submittedAt).toBeUndefined();
  s.tab.controllers.drafts.capture=()=>({content:'',images:[]});s.tab.controllers.sideChatController={destination:'side'};await expect(s.bridge.open(s.pipeline,s.item)).rejects.toThrow('主聊天');expect(s.counts().sent).toBe(0);
 });
});
