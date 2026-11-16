import type { App } from 'obsidian';
import { knowledgePending, type KnowledgeMode, type KnowledgePipeline, type KnowledgeReceipt } from '../core/knowledge';
import type { ReadingItem } from '../core/model';
import { z } from 'zod';
import { withTimeout } from '../core/settings';

// Bump the adapter revision when its contract changes. A local check only
// verifies this interface contract; it does not claim a successful model run.
const compatibilitySchema=z.object({adapter:z.literal(1),version:z.string().min(1).max(100),verifiedAt:z.string().datetime()});
type CompatibilityReceipt=z.infer<typeof compatibilitySchema>;
export interface ClaudianVerificationStore {
  load():Promise<unknown>;
  save(receipt:CompatibilityReceipt):Promise<void>;
}

// Claudian does not publish a cross-plugin message API. Keep this tested-version
// adapter separate, capability checked, and fail closed until a local check passes.
export class ClaudianBridge {
  private queue:Promise<unknown>=Promise.resolve();
  private verified?:CompatibilityReceipt;
  constructor(private app:App,private verificationStore?:ClaudianVerificationStore){}
  async loadVerification(){
    this.verified=undefined;
    try{const result=compatibilitySchema.safeParse(await this.verificationStore?.load());if(result.success)this.verified=result.data;}catch{/* A missing or unreadable receipt never enables an unknown version. */}
  }
  get status():string {
    const reason=this.available();if(reason)return reason;
    const version=(this.app as any).plugins.plugins.realclaudian.manifest.version;
    return this.verified?.version===version?`Claudian ${version} 接续接口验证通过，已保存；可继续使用`:`Claudian ${version} 接续可用（内置已验证版本）`;
  }
  private baseIssue(plugin:any):string {
    if(!plugin)return '请启用 Claudian；材料仍可保存和阅读';
    if(!plugin.settings)return 'Claudian 配置尚未加载，请检查 Claudian 连接设置；材料仍可保存和阅读';
    if(typeof plugin.views?.activateView!=='function'||typeof plugin.views?.getView!=='function')return 'Claudian 接续接口不可用';
    return '';
  }
  private contractIssue(plugin:any):string {
    const view=plugin.views.getView(),manager=view?.getTabManager?.(),host=view?.plugin;
    const methods:[any,string[]][]=[
      [view,['getTabManager','appendToActiveInput','focusActiveInput']],
      [manager,['openConversation','getActiveTab']],
      [host,['createConversation','renameConversation','getConversationSummary','getConversationList','getConversationSync']],
      [host?.conversationLifecycle,['isRunning']],
    ];
    if(methods.some(([object,names])=>names.some(name=>typeof object?.[name]!=='function')))return 'Claudian 会话接续接口不兼容，请更新信息源工作台后重试；材料已保留';
    const tab=manager.getActiveTab();
    if(!tab)return '请先在 Claudian 中打开一个聊天页，再点击验证；无需发送消息';
    if(typeof tab.controllers?.drafts?.capture!=='function'||typeof tab.controllers?.inputController?.sendMessage!=='function'||!Array.isArray(tab.state?.messages)||typeof tab.state?.isStreaming!=='boolean')return 'Claudian 草稿保护或发送接口不兼容，请更新信息源工作台后重试';
    const draft=tab.controllers.drafts.capture();
    if(typeof draft?.content!=='string'||!Array.isArray(draft?.images))return 'Claudian 草稿读取结果不兼容；未改动聊天内容';
    return '';
  }
  verify():Promise<string>{
    const result=this.queue.then(async()=>{
      const plugin=(this.app as any).plugins?.plugins?.realclaudian,base=this.baseIssue(plugin);if(base)throw Error(base);
      const version=plugin.manifest?.version;if(typeof version!=='string'||!version.trim()||version.length>100)throw Error('无法识别 Claudian 版本，请重新启用 Claudian 后验证');
      const unchanged=()=>{if((this.app as any).plugins?.plugins?.realclaudian!==plugin||plugin.manifest?.version!==version)throw Error('验证期间 Claudian 已更新或重载，请重新验证');};
      // Opening the view may prepare its empty composer; never create a stored
      // conversation, alter a draft, or call the native send path as a probe.
      if(!plugin.views.getView()?.getTabManager?.()?.getActiveTab?.())await withTimeout(Promise.resolve(plugin.views.activateView()),10_000,'Claudian 聊天页打开超时，请先手动打开 Claudian 后重新验证');
      unchanged();
      const manager=plugin.views.getView()?.getTabManager?.();
      // A newly enabled/closed-all-tabs view may have no composer yet. Prepare
      // an empty native tab only; do not create a stored material conversation.
      if(!manager?.getActiveTab?.()&&typeof manager?.createTab==='function')await withTimeout(Promise.resolve(manager.createTab()),10_000,'Claudian 空白聊天页准备超时，请先手动打开聊天页后重新验证');
      unchanged();const issue=this.contractIssue(plugin);if(issue)throw Error(issue);
      const receipt:CompatibilityReceipt={adapter:1,version,verifiedAt:new Date().toISOString()};
      if(!this.verificationStore)throw Error('验证结果无法保存，请重新加载信息源工作台后重试');
      await this.verificationStore.save(receipt);unchanged();this.verified=receipt;
      return this.status;
    });this.queue=result.catch(()=>{});return result;
  }
  available():string {
    const plugin=(this.app as any).plugins?.plugins?.realclaudian;
    const issue=this.baseIssue(plugin);if(issue)return issue;
    if(plugin.manifest?.version!=='2.3.17'&&(!this.verified||plugin.manifest?.version!==this.verified.version))return `Claudian ${plugin.manifest?.version??'未知版本'} 尚未验证接续接口；请到「连接与设置 → Claudian 接续」点击验证`;
    try{if(plugin.views.getView())return this.contractIssue(plugin);}catch{return 'Claudian 接续接口检查失败，请在连接与设置中重新验证';}
    return '';
  }
  open(pipeline:KnowledgePipeline,item:ReadingItem,queuedOnly=false,mode?:KnowledgeMode):Promise<string>{
    const result=this.queue.then(()=>this.openOne(pipeline,item,queuedOnly,mode));this.queue=result.catch(()=>{});return result;
  }
  recover(pipeline:KnowledgePipeline,item:ReadingItem):Promise<string>{
    const result=this.queue.then(async()=>{
      const reason=this.available();if(reason)throw new Error(reason);
      const receipt=await pipeline.prepare(item);if(!receipt.conversationId)throw new Error('尚无会话可恢复');
      const currentPlugin=(this.app as any).plugins.plugins.realclaudian;
      const active=currentPlugin.views.getView()?.getTabManager?.()?.getActiveTab?.();
      const last=active?.conversationId===receipt.conversationId?active?.state?.messages?.at(-1):null;
      const rejected=last?.role==='assistant'&&last?.contentBlocks?.some((b:any)=>b.type==='text'&&/^\s*\*\*Error:\*\*/.test(b.content??''));
      const missing=!currentPlugin.chatHost?.getConversationSummary?.(receipt.conversationId);
      if(!receipt.recovery||rejected||missing){
        const plugin=(this.app as any).plugins.plugins.realclaudian,selection=plugin.settings.lastSelectedChatModel;
        if(!selection?.providerId||!selection.model||/flash/i.test(selection.model))throw new Error('请在 Claudian 中选择知识加工模型');
        await plugin.views.activateView();const host=plugin.views.getView()?.plugin;
        const title=`RAW 恢复 · ${item.title}`;
        const orphan=host.getConversationList?.().find((c:any)=>c.id!==receipt.conversationId&&c.title===title&&host.getConversationSync?.(c.id)?.linkedContentPath===receipt.taskPath);
        const created=orphan??await host.createConversation({providerId:selection.providerId,selectedModel:selection.model,linkedContentPath:receipt.taskPath});
        const id=typeof created==='string'?created:created?.id;if(!id)throw new Error('未创建恢复会话');
        await host.renameConversation(id,title);await pipeline.bind(item,id,true);
      }
      return this.openOne(pipeline,item,false);
    });this.queue=result.catch(()=>{});return result;
  }
  private async openOne(pipeline:KnowledgePipeline,item:ReadingItem,queuedOnly:boolean,mode?:KnowledgeMode):Promise<string>{
    const reason=this.available();if(reason)throw new Error(reason);
    let receipt=await pipeline.prepare(item);
    if(mode&&!queuedOnly)receipt=await pipeline.chooseMode(item,mode);
    const wikiFollowup=!!(receipt.submittedAt&&receipt.wikiRequestedAt&&!receipt.wikiSubmittedAt);
    if(queuedOnly&&!knowledgePending(receipt))return '待处理已取消或已提交，没有发送';
    const plugin=(this.app as any).plugins.plugins.realclaudian;
    // An automatic dequeue must wait while the user is composing or receiving
    // a reply in any chat. Explicit clicks may still switch to their material.
    if(queuedOnly){
      const active=plugin.views.getView()?.getTabManager?.()?.getActiveTab?.();
      const draft=active?.controllers?.drafts?.capture?.();
      if(active?.state?.isStreaming||draft?.content?.trim()||draft?.images?.length)return '仍在排队；当前聊天结束且草稿发送后再处理';
    }
    const summaryHost=plugin.chatHost??plugin.views.getView()?.plugin;
    const otherRawRunning=summaryHost?.getConversationList?.().some((conversation:any)=>conversation.id!==receipt.conversationId&&summaryHost.getConversationSync?.(conversation.id)?.linkedContentPath?.includes('/知识接续/')&&summaryHost.conversationLifecycle?.isRunning?.(conversation.id));
    const ownRunning=receipt.conversationId&&summaryHost?.conversationLifecycle?.isRunning?.(receipt.conversationId);
    if((otherRawRunning||wikiFollowup&&ownRunning)&&(!receipt.submittedAt||wikiFollowup)){if(!receipt.submittedAt&&!receipt.queuedAt)await pipeline.markQueued(item);return '已加入知识接续队列；当前 RAW 任务结束后自动交给 Claudian';}
    await plugin.views.activateView();
    if((this.app as any).plugins?.plugins?.realclaudian!==plugin||this.available())throw Error('Claudian 已更新或重载，请重新打开材料；尚未发送指令');
    const view=plugin.views.getView(),manager=view?.getTabManager?.(),host=view?.plugin;
    if(typeof manager?.openConversation!=='function'||typeof host?.createConversation!=='function'||typeof view?.appendToActiveInput!=='function')throw new Error('Claudian 接续接口变化；接续笔记已保留');
    let conversationId=receipt.conversationId;
    if(conversationId && !host.getConversationSummary(conversationId))throw new Error('原 Claudian 会话已删除；请从接续笔记按来源编号恢复，已有 RAW 不会重新登记');
    if(!conversationId){
      // A prior create may have succeeded before the workbench binding save failed.
      const orphan=host.getConversationList?.().find((conversation:any)=>(host.getConversationSync?.(conversation.id)?.linkedContentPath??conversation.linkedContentPath)===receipt.taskPath);
      if(orphan?.id)conversationId=orphan.id;
    }
    if(!conversationId){
      const selection=plugin.settings.lastSelectedChatModel;
      if(!selection?.providerId||!selection.model)throw new Error('请先在 Claudian 中选择知识加工模型');
      if(/flash/i.test(selection.model))throw new Error('请在 Claudian 中选择用于 RAW 的模型；当前 Flash 不用于知识加工');
      const created=await host.createConversation({providerId:selection.providerId,selectedModel:selection.model,linkedContentPath:receipt.taskPath});
      conversationId=typeof created==='string'?created:created?.id;
      if(typeof conversationId!=='string'||!conversationId)throw new Error('Claudian 未返回有效会话编号');
      await host.renameConversation(conversationId,`RAW · ${item.title}`);
    }
    if(receipt.conversationId!==conversationId){
      // Save the identity before loading/dispatch; subsequent clicks reuse it.
      receipt=await pipeline.bind(item,conversationId!);
    }
    if(manager.getActiveTab()?.conversationId!==conversationId)await manager.openConversation(conversationId);
    const tab=manager.getActiveTab();if(tab?.conversationId!==conversationId)throw new Error('Claudian 当前页未切到材料会话；没有发送指令');
    if((receipt.submittedAt || tab.state?.messages?.length)&&!wikiFollowup){view.focusActiveInput();return receipt.wikiSubmittedAt?'已回到此材料的 Claudian 会话，查看 Wiki 加工结果；没有重复发送':'已回到此材料的 Claudian 会话，可以继续讨论；没有重复发送';}
    if(tab.state?.isStreaming || typeof tab.controllers?.inputController?.sendMessage!=='function')throw new Error('Claudian 当前无法接收任务；接续材料已保留');
    const selection=host.getConversationSync?.(conversationId);
    if(/flash/i.test(selection?.selectedModel??selection?.model??''))throw new Error('此材料会话选择了 Flash；请在 Claudian 中改用知识加工模型，任务尚未发送');
    if(typeof tab.controllers?.drafts?.capture!=='function')throw Error('Claudian 草稿保护接口不可用，请重新验证；尚未发送指令');
    if(tab.controllers.sideChatController?.destination==='side')throw Error('请先切回 Claudian 主聊天再接续；侧聊草稿已保留');
    const draft=tab.controllers.drafts.capture();
    if(typeof draft?.content!=='string'||!Array.isArray(draft?.images))throw Error('Claudian 草稿读取结果不兼容，请重新验证；尚未发送指令');
    if(draft?.content?.trim() || draft?.images?.length)throw new Error('此材料会话中已有未发送草稿，已保留；请在 Claudian 中发送或继续编辑');
    // Intent is durable before the native send. Unknown admission is never retried.
    receipt=wikiFollowup?await pipeline.markWikiSubmitted(item):await pipeline.markSubmitted(item,queuedOnly);
    if(!view.appendToActiveInput(wikiFollowup?this.directWikiPrompt(receipt,true):receipt.recovery?`这是用户明确选择的跨会话恢复。读取 [[${receipt.taskPath}]] 中的指定材料身份，核对 ${receipt.sourceId} 最新同 run 的来源档案、Wiki 和讨论回执，恢复已有讨论上下文并简短告知当前阶段。只读这些指定文件，不修改任何业务文件或事件，不重新摄入、新建 run、编译或归纳；不访问其他 Vault、Rocker、Inbox、fanOS或个人记忆。等待用户下一条讨论或具体写入指令。`:this.prompt(receipt)))throw new Error('Claudian 未接收接续指令；提交结果待核对，不自动重发');
    void Promise.resolve(tab.controllers.inputController.sendMessage()).catch(()=>{});
    return receipt.wikiSubmittedAt?'已交给 Claudian 直接归纳 Wiki，无需讨论；完成状态以实际文件和回执为准':'任务已交到 Claudian；加工进度以 RAW 回执为准，可在此继续讨论';
  }
  private directWikiPrompt(receipt:KnowledgeReceipt,followup=false){return `用户已明确点击“直接写入 Wiki（不讨论）”，授权本次指定材料在 08_LLM Wiki 内完成客观归纳与 finalize，无需等待讨论或再次确认。这一明确选择优先于接续笔记中的默认等待讨论。读取 [[${receipt.taskPath}|知识接续任务]]，先核对 ${receipt.sourceId}、材料身份 ${receipt.id} 和版本 ${receipt.version}，按本库 fanos-raw 校验原件、来源引用与已有产物，${followup?'继续已有同一 run，不重新摄入或新建 run':'已有来源复用或恢复，不重复摄入'}。优先补充已有主题页，保留用户修改、争议、覆盖缺口及原文引用，区分作者观点、已验证事实和待验证内容。仅依据指定材料和已核验来源整理，不结合阅读批注或聊天中的个人想法，不把任何分析编造成“帆确认”。按正式协议追加 discussion/skipped 并保留已有讨论事件历史，记录实际 finalize/completed、finalized 回执；如有版本或产物冲突，停止并报告，不覆盖、不擅自重编译。同步同一 run 的来源档案与主题地图状态，实际文件和回执完成后再报告 Wiki 已归纳。整个任务仅限当前 Vault 指定材料和 08_LLM Wiki，不写 fanOS、Inbox、个人记忆或根规则，不访问其他 Vault 或 Rocker。`;}
  private prompt(receipt:KnowledgeReceipt){if(receipt.mode==='direct-wiki')return this.directWikiPrompt(receipt);return `请读取 [[${receipt.taskPath}|知识接续任务]]，按其中范围用本库的 fanos-raw 处理指定材料。先查看 ${receipt.sourceId} 的已有状态，复用或恢复，不重复摄入。默认完成讨论底稿并等待我的交流，不写 fanOS。整个任务仅在当前 Vault 执行，禁止访问其他 Vault 或 Rocker。若后续明确授权具体 fanOS 目标，先展示预览，实际写入与回填后在 08_LLM Wiki/logs/promotions/<本run编号>.json 保存核验回执，格式 {"schema":1,"sourceId":"<来源编号>","runId":"<本run编号>","authorization":"<明确目标授权原文>","targets":[{"path":"<笔记完整相对路径>","hash":"<写入后SHA-256>","role":"note"},{"path":"<看板完整相对路径>","hash":"<写入后SHA-256>","role":"board"}]}。目标限已获授权的01_帆OS非Rocker Markdown文件，笔记回链来源档案及Wiki，看板回链笔记；不因核验回执扩大写入权限。`;}
}
