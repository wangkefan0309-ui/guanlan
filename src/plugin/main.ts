import { ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, SuggestModal, TFile, TFolder, requestUrl, normalizePath, addIcon } from 'obsidian';
import type { App, WorkspaceLeaf } from 'obsidian';
import { ReadingLibrary } from '../core/library';
import { canonicalIdentity, checkReadingPath, feedSchema, materialSchema, readingRoot, topicLabels, topics, webUrl } from '../core/model';
import type { FileStore, ReadingItem, Topic } from '../core/model';
import type { ChatMessage } from '../core/daily-model';
import { apiBase, dailyOptions, parseSettings, restoreSettings, settingsDefaults, settingsError, withTimeout, type Settings } from '../core/settings';
import { beijingDate, buildReviewBatch, DailyReviewSession, itemKey, makeDailyPlan, reviewContext, type ReviewResponse } from '../core/daily';
import { AutoSync } from '../core/auto-sync';
import { Workbench, currentCategory, type WorkbenchHost, type SettingsSection } from '../ui/workbench';
import { registeredSources } from '../core/source-registry';
import { collectionStatusUrl, subscriptionUpdateSchema, subscriptionsViewSchema, type SubscriptionConfig, type SubscriptionsView } from '../core/subscriptions';
import { collectionIssueKind, redactCollectionError, subscriptionStatusText } from '../core/subscription-health';
import { checkAndSyncSubscriptions } from '../core/subscription-refresh';
import { youtubeAccessUpdateSchema, youtubeAccessViewSchema, type YoutubeAccessView } from '../core/youtube-access';
import { defaultCategories, categoriesSchema, type SourceCategory } from '../core/categories';
import { makeSourceConfig, resolvedSourceSchema, useConfiguredBilibiliFeed, type ResolvedSource } from '../core/source-management';
import { ExplorationLibrary, explorationRunSummary, searchResultSchema, type ExplorationRecommendation } from '../core/exploration';
import { subscriptionDiscoveryCandidates } from '../core/discovery-supply';
import { deepseekSearchRequest, parseDeepseekSearch } from '../core/deepseek-search';
import { discoveryGoals, discoveryTopics } from '../core/discovery-topics';
import { mergeExplorationSearch } from '../core/exploration-merge';
import { socialDataStatusSchema } from '../core/socialdata-contract';
import { freeXStatusSchema } from '../core/free-x-contract';
import { KnowledgePipeline, knowledgePending, wikiPath, promotionPath, type KnowledgeMode } from '../core/knowledge';
import { parseSubtitles, transcriptMaterial, videoIdentity } from '../core/transcript';
import { ClaudianBridge } from './claudian';
import {storageRoot,preflightStorage} from '../core/storage';
import { updatesForDay } from '../core/subscription-days';
import { WORKBENCH_ICON_ID, WORKBENCH_ICON_SVG } from './workbench-icon';
import { WORKBENCH_NAME } from '../ui/workbench-brand';

const VIEW = 'source-workbench';
class VaultStore implements FileStore {
  constructor(private app: App, private root: string, private writeGuard:()=>void=()=>{},private afterWrite:()=>Promise<void>=async()=>{}) {}
  private check(path: string) { storageRoot(this.root,this.app.vault.configDir);checkReadingPath(this.root,path);if(normalizePath(path)!==path)throw new Error('存储路径未规范化，请检查目录'); }
  async read(path: string) { this.check(path); const file = this.app.vault.getAbstractFileByPath(path); if (!file) {if(await this.app.vault.adapter.exists(path))throw new Error('已有路径的大小写或缓存不一致，请等待文件列表加载后重试');return null;} if (!(file instanceof TFile)) throw new Error('目标路径不是文件'); return this.app.vault.read(file); }
  async readBinary(path: string) { this.check(path); const file = this.app.vault.getAbstractFileByPath(path); if (!file) {if(await this.app.vault.adapter.exists(path))throw new Error('已有路径的大小写或缓存不一致，请等待文件列表加载后重试');return null;} if (!(file instanceof TFile)) throw new Error('目标路径不是文件'); return new Uint8Array(await this.app.vault.readBinary(file)); }
  private async folders(path: string) {
    this.writeGuard();
    const parts = path.split('/'); parts.pop(); let current = '';
    // Reject a later parent collision before creating any earlier directory.
    for(let i=1;i<=parts.length;i++){const existing=this.app.vault.getAbstractFileByPath(parts.slice(0,i).join('/'));if(existing&&!(existing instanceof TFolder))throw new Error('目录被同名文件占用');}
    for (const part of parts) { current = current ? `${current}/${part}` : part; const existing = this.app.vault.getAbstractFileByPath(current); if (!existing) { try { await this.app.vault.createFolder(current); } catch(error) { if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error; } } else if (!(existing instanceof TFolder)) throw new Error('目录被同名文件占用'); }
  }
  async write(path: string, contents: string, expected?: string | null) {
    this.check(path); await this.folders(path); const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      if (expected === null) throw new Error(`文件已被修改，已保留原内容：${path}`);
      await this.app.vault.process(file,current=> {this.writeGuard();if(file.path!==path)throw new Error('写入目标已移动，保留原内容');this.check(file.path);if (expected !== undefined && current !== expected) throw new Error(`文件已被修改，已保留原内容：${path}`); return contents; });
    } else if (!file) {
      if (typeof expected === 'string') throw new Error('文件已被移动或删除，请重试');
      await this.app.vault.create(path,contents);
    } else throw new Error('写入目标不是文件');
    await this.afterWrite();
  }
  async writeBinary(path: string, contents: Uint8Array) { this.check(path); await this.folders(path); if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`原件已被修改，已保留：${path}`); await this.app.vault.createBinary(path,Uint8Array.from(contents).buffer);await this.afterWrite(); }
  async remove(path:string){this.check(path);if(!path.startsWith(`${this.root}/_工作台/待提交/`)) throw new Error('只允许清理工作台导入恢复记录');const file=this.app.vault.getAbstractFileByPath(path);if(file instanceof TFile) await this.app.vault.delete(file);}
}
export default class SourceWorkbench extends Plugin implements WorkbenchHost {
  settings: Settings = { ...settingsDefaults };
  library!: ReadingLibrary;
  sources: WorkbenchHost['sources'] = registeredSources.map(source => ({ ...source, publicationDates:source.platform==='wechat'?{}:undefined, subscriptionStatus: undefined as string | undefined }));
  categories = defaultCategories();
  subscriptionSummary = '';
  collectionScope?:SubscriptionsView['collectionScope'];
  catchupDays?: number;
  collectionStartedAt?:string;
  collectionStatusUrl?: string;
  private saving: Promise<unknown> = Promise.resolve();
  private libraries = new Map<string,ReadingLibrary>();
  private knowledgeLibraries = new Map<string,KnowledgePipeline>();
  private claudianBridge?: ClaudianBridge;
  private knowledgeTimer?:number;
  private drainingKnowledge=false;
  private blockedKnowledge=new Set<string>();
  configurationIssue='';
  private pausedStorageRoots=new Map<string,string>();
  get readingDirectories(){return [...this.libraries.keys()];}
  private async recordStorage(root:string){if(this.settings.initializedDirectories.includes(root))return;const result=this.saving.then(async()=>{const snapshot={...this.settings,initializedDirectories:[...new Set([...this.settings.initializedDirectories,root])]};await this.saveData(snapshot);this.settings=snapshot;});this.saving=result.catch(()=>{});await result;}
  private store(root:string){return new VaultStore(this.app,root,()=>this.assertWritable(root),()=>this.recordStorage(root));}
  private assertWritable(root=this.library?.root){if(root&&this.pausedStorageRoots.has(root))throw new Error(this.pausedStorageRoots.get(root));if(this.configurationIssue)throw new Error(this.configurationIssue);}
  private pauseStorage(path:string){for(const root of this.libraries.keys())if(path===root||root.startsWith(path+'/')){const issue='阅读目录已移动或删除，写入已暂停；请恢复原目录，或选择新的独立目录后保存';this.pausedStorageRoots.set(root,issue);if(root===this.library.root){this.configurationIssue=issue;this.settings={...this.settings,autoSync:false,autoExplore:false,autoDailyAi:false};this.configureAutoSync();new Notice(issue);}}}
  private knowledgeFor(root:string) { let pipeline=this.knowledgeLibraries.get(root);if(!pipeline){pipeline=new KnowledgePipeline(this.store(root),root);this.knowledgeLibraries.set(root,pipeline);}return pipeline; }
  private get claudian(){
    return this.claudianBridge??=new ClaudianBridge(this.app,{
      load:async()=>{const path=`${this.app.vault.configDir}/plugins/${this.manifest.id}/claudian-compatibility.json`;return await this.app.vault.adapter.exists(path)?JSON.parse(await this.app.vault.adapter.read(path)):null;},
      save:async receipt=>{await this.app.vault.adapter.write(`${this.app.vault.configDir}/plugins/${this.manifest.id}/claudian-compatibility.json`,JSON.stringify(receipt,null,2));},
    });
  }
  get claudianReason() { return this.claudian.available(); }
  get claudianStatus() { return this.claudian.status; }
  async verifyClaudian(){const message=await this.claudian.verify();this.refresh();return message;}
  async handoffKnowledge(item:ReadingItem,library:ReadingLibrary,mode?:KnowledgeMode,queuedOnly=false) {
    this.blockedKnowledge.delete(`${library.root}:${itemKey(item)}`);
    const bridge=this.claudian;
    const saved=(await library.list()).find(value=>value.id===item.id&&value.version===item.version);if(!saved)throw new Error('材料已不存在');
    const pipeline=this.knowledgeFor(library.root),receipt=await pipeline.receipt(saved);
    if(mode==='direct-wiki'||receipt?.wikiRequestedAt&&!receipt.wikiSubmittedAt){
      const status=(await this.knowledgeStatuses([saved],library)).get(itemKey(saved));
      if(status?.label.startsWith('Wiki 已归纳')||status?.label==='fanOS 已晋升'){if(receipt&&knowledgePending(receipt))await pipeline.cancelQueued(saved);this.refresh();return '此材料的 Wiki 已归纳，可在已保存的知识中打开';}
      if(status?.issue)throw new Error(status.issue);
    }
    const message=await bridge.open(pipeline,saved,queuedOnly,mode);this.refresh();return message;
  }
  async cancelKnowledge(item:ReadingItem,library:ReadingLibrary) { await this.knowledgeFor(library.root).cancelQueued(item);this.refresh();return '待处理已取消；阅读材料、原件和接续笔记仍保留'; }
  async recoverKnowledge(item:ReadingItem,library:ReadingLibrary){
    const saved=(await library.list()).find(value=>value.id===item.id&&value.version===item.version);if(!saved)throw new Error('材料已不存在');
    const status=(await this.knowledgeStatuses([saved],library)).values().next().value;
    if(!status?.runId||status.issue)throw new Error('当前 RAW 回执尚未核对，请先检查材料');
    const message=await this.claudian.recover(this.knowledgeFor(library.root),saved);this.refresh();return message;
  }
  private async drainKnowledge() {
    if(this.drainingKnowledge||this.claudianReason||this.configurationIssue)return;this.drainingKnowledge=true;
    const library=this.library,pipeline=this.knowledgeFor(library.root);let key='';
    try{for(const item of await library.list()){key=`${library.root}:${itemKey(item)}`;if(this.blockedKnowledge.has(key))continue;const receipt=await pipeline.receipt(item);if(receipt&&knowledgePending(receipt)){await this.handoffKnowledge(item,library,undefined,true);break;}}}
    catch(error){if(key)this.blockedKnowledge.add(key);new Notice(`知识接续排队未提交：${error instanceof Error?error.message:'读取失败'}；请在工作台检查材料`);}
    finally{this.drainingKnowledge=false;}
  }
  async knowledgeStatuses(items:ReadingItem[],library:ReadingLibrary) {
    const wiki={read:async(path:string)=>{if(!wikiPath(path))throw new Error('知识路径越界');const file=this.app.vault.getAbstractFileByPath(path);if(!file)return null;if(!(file instanceof TFile))throw new Error('知识产物不是文件');return this.app.vault.read(file);},
      readBinary:async(path:string)=>{if(!wikiPath(path)&&!promotionPath(path))throw new Error('知识路径越界');const file=this.app.vault.getAbstractFileByPath(path);if(!file)return null;if(!(file instanceof TFile))throw new Error('知识产物不是文件');return new Uint8Array(await this.app.vault.readBinary(file));}};
    const result=new Map<string,import('../core/knowledge').KnowledgeStatus>();const pipeline=this.knowledgeFor(library.root);
    for(const item of items){try{const status=await pipeline.status(item,wiki);if(status.receipt)result.set(itemKey(item),status);}catch(error){result.set(itemKey(item),{label:'接续记录需检查',receipt:null,outputs:[],issue:error instanceof Error?error.message:'无法读取'});}}
    return result;
  }
  async openKnowledgeFile(path:string) { if(!wikiPath(path)&&!promotionPath(path))throw new Error('知识路径越界');const file=this.app.vault.getAbstractFileByPath(path);if(!(file instanceof TFile))throw new Error('知识文件不存在');await this.app.workspace.getLeaf('tab').openFile(file); }
  async collectTranscript(url:string,topic:Topic='ai-learning',library=this.library) {
    const settings=structuredClone(this.settings);const video=videoIdentity(url);
    const response=await this.service('/v1/transcript',{url:video.url,topic},settings) as {material:unknown};const saved=await library.import(response.material);
    this.refresh();return `文字稿已保存到 ${library.root}，请在全部材料中选择「${saved.title}」交给 Claudian`;
  }
  async handoffVideo(item:ReadingItem,library:ReadingLibrary,mode?:KnowledgeMode) {
    const settings=structuredClone(this.settings);if(this.claudianReason)throw new Error(this.claudianReason);if(!item.url)throw new Error('视频原链接缺失');
    const video=videoIdentity(item.url),response=await this.service('/v1/transcript',{url:video.url,topic:item.topic},settings) as {material:unknown};
    const saved=await library.import(response.material);return this.handoffKnowledge(saved,library,mode);
  }
  async attachPdfText(item:ReadingItem,library:ReadingLibrary) {
    const file=await pickFile('.md');if(!file)return '已取消';if(!/\.md$/i.test(file.name))throw new Error('请选择 MinerU 等工具生成的 Markdown 转换稿');
    if(file.size>5_000_000)throw new Error('转换稿过大，请分段处理');const saved=await library.attachPdfMarkdown(item.id,item.version,await file.text());this.refresh();
    return `PDF 原件已保留，转换稿作为独立新版本保存；请在全部材料选择「${saved.title}」交给 Claudian`;
  }
  private synchronizing: { key: string; promise: Promise<string> } | null = null;
  private refreshingSubscriptions: { key: string; promise: Promise<string> } | null = null;
  private unloaded = false;
  private autoSyncScheduler?: AutoSync;
  private autoSyncTimer?: number;
  syncSummary = '';
  private reviewSessions = new Map<string, DailyReviewSession>();
  private explorations = new Map<string, ExplorationLibrary>();
  private notifiedExplorationDays = new Set<string>();
  private explorationTimer?: number;
  explorationSummary = '';
  xSummary = 'X热门搜索尚未配置';
  get explorationLimit() { return this.settings.explorationMaxItems; }
  get explorationTopics() { return this.settings.discoveryTopics; }
  private explorationFor(root = this.library.root) {
    let library = this.explorations.get(root);
    if (!library) { library = new ExplorationLibrary(this.store(root),root); this.explorations.set(root,library); }
    return library;
  }
  get explorationActionLabel() { return this.explorationFor().pendingSave ? '重试保存探索结果' : '发现新内容'; }
  get autoExplorationEnabled() { return this.settings.autoExplore; }
  async enableDailyRecommendations() {
    await this.applySettings({ ...this.settings, autoExplore: true, explorationMaxItems: 3,
      searchProvider: apiBase(this.settings.guideUrl) === 'https://api.deepseek.com' ? 'deepseek-web' : this.settings.searchProvider });
    return '已开启每日 1–3 条推荐；打开 Obsidian 时检查，休眠恢复后补查当天';
  }
  async readExploration(library: ReadingLibrary) { return (await this.readExplorationArchive(library)).recommendations; }
  async readExplorationArchive(library:ReadingLibrary){
    const archive = await this.explorationFor(library.root).archive();
    const removed = new Set((await library.listTrash()).flatMap(entry => entry.item.url ? [canonicalIdentity(entry.item.url)] : []));
    archive.recommendations = archive.recommendations.filter(item => !removed.has(canonicalIdentity(item.candidate.url)));
    archive.days = archive.days.map(day => ({ ...day, count: archive.recommendations.filter(item => item.run.date === day.date).length }));
    return archive;
  }
  async recoverExploration() {
    this.assertWritable();
    const reading = this.library, exploration = this.explorationFor(reading.root);
    const items = [...(await reading.list()).filter(item => item.progress === 'done'), ...(await reading.listTrash()).map(entry => entry.item)];
    const run = await exploration.recoverFirstEvaluation([...items.flatMap(item => item.url ? [item.url] : []), ...await reading.historyUrls()]);
    const message = explorationRunSummary(run);
    if (reading === this.library) { this.explorationSummary = message; this.refresh(); }
    return message;
  }
  async exploreNow(automatic = false): Promise<string> {
    this.assertWritable();
    const settings = structuredClone(this.settings); const reading = this.library; const exploration = this.explorationFor(reading.root);
    const historyOptions = structuredClone(this.historyOptions);
    if (automatic && !settings.autoExplore) return '';
    const hasReceipt = (await exploration.runs()).some(run=>run.date===beijingDate());
    if (!exploration.pendingSave && !hasReceipt && ((!settings.serviceToken && settings.searchProvider!=='deepseek-web') || !settings.guideKey || !settings.guideModel || !settings.guideUrl || (settings.searchProvider === 'tavily' && !settings.searchKey))) {
      const message = !settings.guideKey ? '请配置用于探索筛选的模型 API Key' : settings.searchProvider === 'tavily' && !settings.searchKey ? 'Tavily搜索Key未配置；可选择免Key公开检索' : '请配置材料服务与筛选模型';
      if (automatic) { this.explorationSummary = message; this.refresh(); return message; } throw new Error(message);
    }
    if (!exploration.pendingSave && !hasReceipt && settings.searchProvider==='deepseek-web' && apiBase(settings.guideUrl)!=='https://api.deepseek.com') throw new Error('DeepSeek原生联网需要上方官方DeepSeek模型连接；其他模型可选择公开检索或Tavily');
    if (reading === this.library) { this.explorationSummary = '正在检索和筛选新内容…'; this.refresh(); }
    const materials = hasReceipt ? [] : await reading.list(), trashed = hasReceipt ? [] : await reading.listTrash();
    // Reserve today's stable history references before a new exploration can select them.
    if (!hasReceipt) await reading.historyHighlights(historyOptions);
    const knownUrls = [...materials.filter(item => item.progress === 'done'), ...trashed.map(entry => entry.item)].flatMap(item => item.url ? [item.url] : []);
    knownUrls.push(...await reading.historyUrls());
    const excluded = hasReceipt ? new Set<string>() : await exploration.excludedIds(knownUrls);
    const run = await exploration.run({ provider: settings.searchProvider, queries: settings.searchQueries.split('\n'), goals: discoveryGoals(settings.discoveryTopics,`${settings.explorationGoals}\n学习起点：${settings.learningGoals}`), model: settings.guideModel, endpoint: settings.guideUrl, maxItems: settings.explorationMaxItems, sections: settings.discoveryTopics },
      () => this.discoverSearch(settings, materials, excluded),
      messages => this.answerReview(messages, settings,12000), knownUrls);
    void this.refreshXStatus(settings);
    const message = `${run.date} · ${explorationRunSummary(run)}${run.search?.warnings.length ? ` · ${run.search.warnings[0]}` : ''}`;
    if (reading === this.library) { this.explorationSummary = message; this.refresh(); }
    const notificationKey = `${reading.root}:${run.date}`;
    if (automatic && !hasReceipt && reading === this.library && run.status === 'completed' && run.selected.length && !this.notifiedExplorationDays.has(notificationKey)) {
      this.notifiedExplorationDays.add(notificationKey); new Notice(`今日已准备 ${run.selected.length} 条推荐，可在${WORKBENCH_NAME}的“远眺”查看`);
    }
    return message;
  }
  async searchDeepseek(settings: Settings) {
    if(apiBase(settings.guideUrl)!=='https://api.deepseek.com')throw new Error('原生联网仅向官方DeepSeek地址发送已有Key');
    const queries=settings.searchQueries.split('\n');
    const response=await withTimeout(requestUrl({url:'https://api.deepseek.com/anthropic/v1/messages',method:'POST',headers:{'x-api-key':settings.guideKey,'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify(deepseekSearchRequest(queries,discoveryGoals(settings.discoveryTopics,settings.explorationGoals),settings.guideModel,new Date(),settings.discoveryTopics)),throw:false}),90_000,'联网检索响应超时，结果未知且可能计费；本批不自动重发');
    if(response.status!==200)throw new Error(`DeepSeek联网检索返回HTTP ${response.status}；本批不自动重发`);
    if(response.text.length>2_000_000)throw new Error('联网检索回执超过2MB，本批不重发');
    return this.enrichSearch(await parseDeepseekSearch(response.text,queries,24),settings);
  }
  async discoverSearch(settings: Settings, materials: ReadingItem[] = [], excluded = new Set<string>()) {
    const empty = (warning: string) => searchResultSchema.parse({ candidates: [], snapshots: [], warnings: warning ? [warning] : [], credits: 0 });
    const web = settings.searchProvider==='deepseek-web' ? this.searchDeepseek(settings) : this.service('/v1/exploration/search',{provider:settings.searchProvider,queries:settings.searchQueries.split('\n'),key:settings.searchProvider==='tavily'?settings.searchKey:''},settings).then(searchResultSchema.parse);
    const x = !settings.xEnabled ? Promise.resolve(empty('')) : !settings.serviceToken ? Promise.resolve(empty('X热门帖未接通：请先连接本机材料服务')) : settings.xProvider === 'free' ? this.service('/v1/exploration/x/free/search',{topics:settings.discoveryTopics},settings).then(searchResultSchema.parse) : !settings.socialDataKey ? Promise.resolve(empty('SocialData未配置Key，其他发现渠道继续运行')) : this.service('/v1/exploration/x/search',{key:settings.socialDataKey,topics:settings.discoveryTopics},settings).then(searchResultSchema.parse);
    const results=await Promise.allSettled([web,x]);
    const reason = (error: unknown) => { let message = friendlyError(error); for (const secret of [settings.guideKey, settings.searchKey, settings.serviceToken]) if (secret) message = message.split(secret).join('<REDACTED>'); return message.slice(0, 220); };
    const first=results[0]!.status==='fulfilled'?results[0]!.value:empty(`主要检索渠道未完成：${reason(results[0]!.reason)}；本日不重发该检索`);
    const second=results[1]!.status==='fulfilled'?results[1]!.value:empty('X搜索或回执保存未完成；本日不重发，请查看X连接状态');
    const enrichedX=second.candidates.some(item=>item.contentLinks?.some(link=>link.kind==='article'))?await this.enrichSearch(second,settings):second;
    const combined = mergeExplorationSearch(first,enrichedX);
    const supplemental = await subscriptionDiscoveryCandidates(materials, settings.discoveryTopics, new Date(), excluded);
    return mergeExplorationSearch(combined, supplemental);
  }
  async refreshXStatus(settings=structuredClone(this.settings)) {
    let summary = !settings.xEnabled ? 'X热门搜索已关闭' : !settings.serviceToken ? 'X热门搜索未接通 · 材料服务未连接' : settings.xProvider === 'socialdata' && !settings.socialDataKey ? 'SocialData未接通 · Key未配置' : '';
    if (!summary) {
      try {
        if (settings.xProvider === 'free') {
          const status = freeXStatusSchema.parse(await this.service('/v1/exploration/x/free/status',undefined,settings));
          summary = `免费X · ${status.configured ? status.verified ? '已有实采回执' : '已登录，待实采' : '未连接'} · 今日${status.requestsToday}次 / ${status.returnedPosts}帖 · ${status.reason}`;
        } else { const status=socialDataStatusSchema.parse(await this.service('/v1/exploration/x/status',undefined,settings));summary=`X ${status.month} · 已用$${status.spentUsd.toFixed(4)} / $${status.limitUsd.toFixed(2)}${status.reservedUsd?` · 未知预留$${status.reservedUsd.toFixed(2)}`:''} · ${status.reason}`; }
      }
      catch { summary='X连接状态未读取 · 请检查材料服务版本与连接'; }
    }
    if(settings.serviceUrl===this.settings.serviceUrl&&settings.serviceToken===this.settings.serviceToken&&settings.socialDataKey===this.settings.socialDataKey&&settings.xProvider===this.settings.xProvider&&settings.xEnabled===this.settings.xEnabled){this.xSummary=summary;this.refresh();}
    return summary;
  }
  async enrichSearch(search: ReturnType<typeof searchResultSchema.parse>,settings:Settings) {
    if(!settings.serviceToken)return {...search,warnings:[...search.warnings,'材料服务未连接，尚未核对原网页与节目链接'].slice(0,8)};
    try{const evidence=searchResultSchema.parse(await this.service('/v1/exploration/evidence',{candidates:search.candidates},settings));return searchResultSchema.parse({...search,candidates:evidence.candidates,snapshots:[...search.snapshots,...evidence.snapshots].slice(0,14),warnings:[...evidence.warnings,...search.warnings.filter(message=>!message.startsWith('部分候选只有标题')),...(evidence.candidates.some(item=>item.coverage==='metadata')?['部分候选只有标题，证据不足时不推荐']:[])].slice(0,8)});}
    catch{return {...search,warnings:[...search.warnings,'原页核对服务未完成，保留首次联网结果，不重发模型检索'].slice(0,8)};}
  }
  private autoExplore() { const reading = this.library; void this.exploreNow(true).catch(error => { if (reading === this.library) { this.explorationSummary = `探索结果未保存 · ${friendlyError(error)}`; this.refresh(); } }); }
  private async collectRecommendation(item:ExplorationRecommendation,library:ReadingLibrary,settings:Settings):Promise<ReadingItem> {
    if (item.candidate.origin === 'subscription') {
      const saved = (await library.list()).reverse().find(saved => saved.url && canonicalIdentity(saved.url) === canonicalIdentity(item.candidate.url));
      if (!saved) throw new Error('这篇订阅材料已移出阅读列表，请在回收站核对或恢复');
      return saved;
    }
    const host=new URL(item.candidate.url).hostname;
    const topic = item.entry.section === 'technology' ? item.entry.kind === 'news' ? 'ai-news' : 'ai-learning' : ['business','investing','finance'].includes(item.entry.section ?? '') ? 'finance' : ['domestic','international'].includes(item.entry.section ?? '') ? 'headlines' : item.entry.section==='growth'?'cognition':item.entry.kind==='opinion'?'opinion':'leisure';
    const isVideo=['youtube.com','youtu.be','bilibili.com'].some(domain=>host===domain||host.endsWith(`.${domain}`));
    const isX=['x.com','www.x.com','twitter.com','www.twitter.com'].includes(host);
    const response=await this.service(isVideo?'/v1/transcript':isX?'/v1/exploration/x/free/post':'/v1/import',isVideo||isX?{url:item.candidate.url,topic}:{format:'url',url:item.candidate.url,topic},settings) as {material:unknown};
    return library.import(response.material);
  }
  async collectExploration(item: ExplorationRecommendation) {
    const library=this.library,settings=structuredClone(this.settings);const saved=await this.collectRecommendation(item,library,settings);this.refresh();
    if (item.candidate.origin === 'subscription') { await this.openFile(saved.path); return `已打开保存过的「${saved.title}」`; }
    return `已收录「${saved.title}」到 ${library.root}，覆盖范围见材料详情`;
  }
  async handoffExploration(item:ExplorationRecommendation,mode?:KnowledgeMode) {
    const library=this.library,settings=structuredClone(this.settings);if(this.claudianReason)throw new Error(this.claudianReason);
    const saved=await this.collectRecommendation(item,library,settings);return this.handoffKnowledge(saved,library,mode);
  }
  async dismissExploration(id: string) { await this.explorationFor().dismiss(id); this.refresh(); }
  get guideConfigured() { return !!(this.settings.guideUrl && this.settings.guideModel && this.settings.guideKey); }
  get reviewActionLabel() { const session = this.reviewSessions.get(this.library.root); return session?.pendingSave ? '重试保存 AI 导读' : session?.pendingRejected ? '重试保存模型回执' : '生成 AI 精选'; }
  async onload() {
    const restored = restoreSettings(await this.loadData()); this.settings = restored.settings;
    await this.claudian.loadVerification();
    let startupCachePending=false;
    if(restored.repaired)this.configurationIssue='旧配置无效，自动任务和文件写入已暂停；请检查目录与连接后保存';
    try{await this.validateStorage(this.settings.directory);if(!this.settings.directoryApproved&&this.settings.serviceToken&&!this.app.vault.getAbstractFileByPath(this.settings.directory))throw new Error('旧配置的阅读目录不存在；请确认位置后保存，不会自动在旧位置创建目录');}catch(error){this.configurationIssue=error instanceof Error?error.message:'存储位置需检查';try{startupCachePending=!restored.repaired&&!this.app.vault.getAbstractFileByPath(this.settings.directory)&&(await this.app.vault.adapter.stat(this.settings.directory))?.type==='folder';}catch{}}
    if(this.configurationIssue){this.settings={...this.settings,autoSync:false,autoExplore:false,autoDailyAi:false};if(!startupCachePending&&!this.configurationIssue.includes('大小写或缓存不一致'))new Notice(this.configurationIssue);}
    addIcon(WORKBENCH_ICON_ID, WORKBENCH_ICON_SVG);
    this.createLibrary(); this.registerView(VIEW, leaf => new WorkbenchView(leaf, this));
    this.registerEvent(this.app.vault.on('rename',(_file,oldPath)=>this.pauseStorage(oldPath)));
    this.registerEvent(this.app.vault.on('delete',file=>this.pauseStorage(file.path)));
    void this.refreshXStatus();
    this.addRibbonIcon(WORKBENCH_ICON_ID, WORKBENCH_NAME, () => void this.activate());
    this.addCommand({ id: 'open', name: `打开${WORKBENCH_NAME}`, callback: () => void this.activate() });
    this.addCommand({ id: 'import-url', name: '导入阅读链接', callback: () => void this.importUrl().catch(error => new Notice(error.message)) });
    this.addCommand({ id: 'sync', name: '同步阅读材料', callback: () => void this.sync().then(message => { this.refresh(); new Notice(message); }).catch(error => new Notice(error.message)) });
    this.addCommand({ id: 'daily-note', name: '生成今日阅读笔记', callback: () => void this.saveDaily().catch(error => new Notice(error.message)) });
    this.addCommand({ id: 'daily-ai', name: '生成 AI 精选与导读', callback: () => void this.reviewDaily().then(message => { this.refresh(); new Notice(message); }).catch(error => new Notice(error.message)) });
    this.addCommand({ id: 'explore', name: '探索优质新内容', callback: () => void this.exploreNow().then(message => new Notice(message)).catch(error => new Notice(error.message)) });
    this.addSettingTab(new WorkbenchSettings(this.app, this));
    this.autoSyncScheduler = new AutoSync(() => {
      const settings = { ...this.settings }; const library = this.library;
      if (!settings.autoSync || !settings.serviceToken) return null;
      return { key: this.syncKey(library, settings), run: () => this.syncFor(library, settings, true) };
    }, outcome => {
      if (outcome.key !== this.syncKey(this.library, this.settings)) return;
      this.syncSummary = outcome.status === 'running' ? '正在同步后台已采集材料…' : outcome.status === 'completed' ? `已采集材料已同步 · ${new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : `材料同步失败，保留已保存内容 · ${outcome.message}`;
      this.refresh();
    });
    this.configureAutoSync();
    const startupSettings=this.settings;
    const startupIssue=this.configurationIssue;
    this.app.workspace.onLayoutReady(() => { void (async()=>{
      // The initial Vault lookup can precede Obsidian's folder cache. Recheck the
      // same full contract once ready; damaged configuration and missing folders
      // remain paused. Never replace settings already saved by the user.
      if(!restored.repaired&&(startupCachePending||startupIssue.includes('大小写或缓存不一致'))&&this.settings===startupSettings&&this.configurationIssue===startupIssue){
        try{await this.validateStorage(this.settings.directory);if(this.settings===startupSettings&&this.configurationIssue===startupIssue){this.settings={...restored.settings};this.configurationIssue='';this.configureAutoSync();this.refresh();}}
        catch{if(this.settings===startupSettings&&this.configurationIssue===startupIssue)new Notice(startupIssue);}
      }
      void this.autoSyncScheduler?.request(); this.autoExplore();
    })(); });
    this.explorationTimer = window.setInterval(() => this.autoExplore(), 60 * 60_000);
    this.registerDomEvent(window, 'focus', () => this.autoExplore());
    this.registerDomEvent(document, 'visibilitychange', () => { if (!document.hidden) this.autoExplore(); });
    this.knowledgeTimer=window.setInterval(()=>void this.drainKnowledge(),15_000);
    if (restored.migrated&&!this.configurationIssue) void this.saveSettings().catch(() => new Notice('旧伴读配置清理未保存，请在连接与设置中保存配置；每日导读配置已保留'));
    void this.refreshSubscriptions();
  }
  onunload() {this.unloaded=true; this.autoSyncScheduler?.stop(); if (this.autoSyncTimer !== undefined) window.clearInterval(this.autoSyncTimer); if (this.explorationTimer !== undefined) window.clearInterval(this.explorationTimer);if(this.knowledgeTimer!==undefined)window.clearInterval(this.knowledgeTimer); }
  private syncKey(library: ReadingLibrary, settings: Settings) { return JSON.stringify([library.root, settings.serviceUrl, settings.serviceToken]); }
  private configureAutoSync() {
    if (this.autoSyncTimer !== undefined) window.clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = undefined;
    if (this.settings.autoSync) this.autoSyncTimer = window.setInterval(() => { void this.autoSyncScheduler?.request(); }, this.settings.syncIntervalMinutes * 60_000);
  }
  createLibrary() { const root = readingRoot(this.settings.directory); let library=this.libraries.get(root); if(!library) { library=new ReadingLibrary(this.store(root),root);this.libraries.set(root,library); } this.library=library; }
  async validateStorage(value:string){
    const requested=readingRoot(value);if((this.pausedStorageRoots.has(requested)||this.settings.initializedDirectories.includes(requested))&&!(this.app.vault.getAbstractFileByPath(requested) instanceof TFolder))throw new Error('原阅读目录尚未恢复；不能用空目录替代已移动或删除的资料');
    const raw=value.trim().replace(/\\/g,'/').replace(/\/+$/,'');const original=this.app.vault.getAbstractFileByPath(raw);if(raw!==requested&&original&&original.path!==requested)throw new Error('已有目录名称与规范路径不同，请先在 Obsidian 中规范目录名称，不会另建同名目录');
    const root=await preflightStorage(value,this.app.vault.configDir,[...this.libraries.keys()],async path=>{const entry=this.app.vault.getAbstractFileByPath(path);if(entry instanceof TFolder)return 'folder';if(entry)return 'file';if(await this.app.vault.adapter.exists(path))throw new Error(`已有路径的大小写或缓存不一致，请用文件夹选择器选择：${path}`);return null;});
    const parts=root.split('/');for(let i=1;i<parts.length;i++)if(this.app.vault.getAbstractFileByPath(`${parts.slice(0,i).join('/')}/_工作台/state.json`))throw new Error('所选目录位于已有阅读库内，请选择该阅读库本身或独立目录');
    await new ReadingLibrary(new VaultStore(this.app,root),root).checkpoint();return root;
  }
  async saveSettings() {
    const snapshot = structuredClone(this.settings); const result = this.saving.then(() => this.saveData(snapshot)); this.saving = result.catch(() => {}); await result;
  }
  async applySettings(input: Settings) {
    const snapshot = parseSettings(input);
    const result = this.saving.then(async()=> { snapshot.directory=await this.validateStorage(snapshot.directory);snapshot.initializedDirectories=[...new Set([...this.settings.initializedDirectories,...snapshot.initializedDirectories,...(this.app.vault.getAbstractFileByPath(snapshot.directory) instanceof TFolder?[snapshot.directory]:[])])];snapshot.directoryApproved=true;await this.saveData(snapshot); this.settings=snapshot;this.configurationIssue='';this.pausedStorageRoots.delete(snapshot.directory); this.createLibrary(); this.syncSummary=''; this.configureAutoSync(); this.refresh(); void this.refreshSubscriptions(); void this.refreshXStatus(); void this.autoSyncScheduler?.request(); this.autoExplore(); });
    this.saving=result.catch(()=>{}); await result;
  }
  async activate() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0]; if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW, active: true }); } await this.app.workspace.revealLeaf(leaf);
    void this.autoSyncScheduler?.request();
    this.autoExplore();
  }
  refresh() { for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) if (leaf.view instanceof WorkbenchView) void leaf.view.workbench?.refresh(); }
  configure(section?:SettingsSection) { new ConnectionModal(this.app,this,section).open(); }
  configureSubscriptions() { new SubscriptionsModal(this.app, this, { ...this.settings }).open(); }
  addSource() { new SubscriptionsModal(this.app, this, { ...this.settings }, true).open(); }
  async refreshSubscriptions(settings = { ...this.settings }) {
    try {
      const state = subscriptionsViewSchema.parse(await this.service('/v1/subscriptions', undefined, settings));
      if (settings.serviceUrl !== this.settings.serviceUrl || settings.serviceToken !== this.settings.serviceToken) return;
      this.showSubscriptions(state); this.refresh();
    } catch {
      if (settings.serviceUrl !== this.settings.serviceUrl || settings.serviceToken !== this.settings.serviceToken) return;
      for (const source of this.sources) { source.subscriptionStatus = undefined; source.enabled = undefined; source.collectionStatus = undefined; source.collectionIssue = undefined; }
      this.subscriptionSummary = '采集后台暂时无法连接，保留本地材料；请稍后重试'; this.collectionStatusUrl = undefined; this.refresh();
    }
  }
  showSubscriptions(state: SubscriptionsView) {
    this.categories = state.categories;
    this.collectionScope=state.collectionScope;this.collectionStartedAt=state.collectionStartedAt;this.catchupDays=state.catchupDays;
    this.collectionStatusUrl = collectionStatusUrl(state.sources.map(source => source.config));
    this.sources = state.sources.map(receipt => ({ registry_id: receipt.config.id, display_name: receipt.name, original_name: receipt.config.accountName ?? registeredSources.find(source => source.registry_id === receipt.config.id)?.display_name ?? receipt.name, platform: receipt.config.platform, categoryId: receipt.config.categoryId ?? receipt.config.topic ?? undefined,
      verification_status: 'subscription', enabled:receipt.config.enabled,collectionStatus:receipt.status,daily:receipt.daily,
      recentChecks: receipt.recentChecks, lastFailure: receipt.lastFailure,
      collectionIssue: receipt.status === 'error' ? collectionIssueKind(receipt.error) : undefined,
      publicationDates:state.collectionScope==='today'&&receipt.config.platform==='wechat'?receipt.publicationDates??{}:undefined,
      subscriptionStatus: subscriptionStatusText(receipt) + (receipt.status === 'ok' && receipt.collectionMethod === 'browser' ? ' · 本机浏览器补抓' : '') + (receipt.status === 'ok' && receipt.collectionMethod === 'public-page' ? ' · 主页备用检查' : '') + (receipt.daily?.undated ? ` · ${receipt.daily.undated}条发布时间待核对` : '') }));
    const enabled = state.sources.filter(source => source.config.enabled).length;
    const failed = state.sources.filter(source => source.config.enabled && source.status === 'error');
    this.subscriptionSummary = `已启用 ${enabled} 个来源 · ${state.running ? '正在采集' : failed.length ? `${failed.length} 个来源待恢复` : '当前无采集错误'} · ${this.settings.autoSync ? '自动同步已开启' : '手动同步'}`;
  }
  async setSubscriptionEnabled(id: string, enabled: boolean): Promise<string> {
    const connection = { ...this.settings };
    const state = subscriptionsViewSchema.parse(await this.service('/v1/subscriptions', undefined, connection));
    const source = state.sources.find(source => source.config.id === id);
    if (!source) throw new Error('来源配置已变化，请刷新后重试');
    const input = subscriptionUpdateSchema.parse({ revision: state.revision, sources: state.sources.map(source => ({ ...source.config, enabled: source.config.id === id ? enabled : source.config.enabled })) });
    const next = subscriptionsViewSchema.parse(await this.service('/v1/subscriptions', input, connection));
    if (connection.serviceUrl === this.settings.serviceUrl && connection.serviceToken === this.settings.serviceToken) { this.showSubscriptions(next); this.refresh(); }
    return enabled ? `已开启「${source.name}」订阅，将继续检查新内容` : `已关闭「${source.name}」订阅，不再抓取；已收录材料保留`;
  }
  async openFile(path: string) { checkReadingPath(this.library.root,path); const file = this.app.vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) throw new Error('文件未保存到本地'); await this.app.workspace.getLeaf('tab').openFile(file); }
  openOriginal(url: string) { window.open(webUrl.parse(url), '_blank', 'noopener,noreferrer'); }
  async service(path: string, body?: unknown, settings = { ...this.settings }): Promise<unknown> {
    if (!settings.serviceToken) throw new Error('请先在设置中填写材料服务令牌');
    const response = await withTimeout(requestUrl({ url: `${apiBase(settings.serviceUrl)}${path}`, method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${settings.serviceToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), throw: false }),path === '/v1/exploration/x/free/search' ? 205_000 : path === '/v1/exploration/x/search' ? 110_000 : path === '/v1/exploration/search' ? 90_000 : 45_000,path.startsWith('/v1/exploration/') ? '材料服务响应超时；探索调用结果未知，当日不自动重发' : '材料服务响应超时');
    let json; try { json=JSON.parse(response.text); } catch { throw new Error(`服务返回 HTTP ${response.status}，响应不是有效 JSON`); }
    if(path==='/v1/transcript'&&response.status===404)throw new Error('当前材料服务没有文字稿接口；请升级到 v0.13.0，或直接导入 SRT/VTT/Markdown 文件');
    if (response.status !== 200) throw new Error(json?.error || `服务返回 HTTP ${response.status}`); return json;
  }
  sync(): Promise<string> {
    return this.syncFor(this.library, { ...this.settings }, false);
  }
  checkUpdates(): Promise<string> {
    if (this.unloaded) return Promise.reject(Error('插件已退出，请重新启用后再检查'));
    const library = this.library, settings = { ...this.settings }, key = this.syncKey(library, settings);
    if (this.refreshingSubscriptions) return this.refreshingSubscriptions.key === key ? this.refreshingSubscriptions.promise
      : Promise.reject(Error('另一阅读目录或连接仍在检查，请完成后再试'));
    const report = (view: SubscriptionsView) => {
      if (this.unloaded || key !== this.syncKey(this.library, this.settings)) return;
      this.showSubscriptions(view);
      this.syncSummary = view.running ? '正在检查来源，已保存材料可继续阅读…' : '采集检查已结束，正在同步已保存材料…'; this.refresh();
    };
    const task = { key, promise: Promise.resolve('') };
    this.refreshingSubscriptions = task;
    task.promise = checkAndSyncSubscriptions({
      check: async () => subscriptionsViewSchema.parse(await this.service('/v1/subscriptions/poll', { recoverNetwork: true }, settings)),
      read: async () => subscriptionsViewSchema.parse(await this.service('/v1/subscriptions', undefined, settings)),
      sync: () => this.syncFor(library, settings, true), report,
      wait: async milliseconds => { await new Promise<void>(done => window.setTimeout(done, milliseconds)); if (this.unloaded) throw Error('插件已退出，后台采集继续，重新打开后可同步'); },
    }).then(message => {
      if (!this.unloaded && key === this.syncKey(this.library, this.settings)) { this.syncSummary = message; this.refresh(); }
      return message;
    }).catch(error => {
      if (!this.unloaded && key === this.syncKey(this.library, this.settings)) { this.syncSummary = `检查或同步尚未完成，已保存材料保留 · ${friendlyError(error)}`; this.refresh(); }
      throw error;
    }).finally(() => { if (this.refreshingSubscriptions === task) this.refreshingSubscriptions = null; });
    return task.promise;
  }
  private syncFor(library: ReadingLibrary, settings: Settings, background: boolean): Promise<string> {
    let sourceSnapshot=this.sources.map(source=>({...source,publicationDates:source.publicationDates&&{...source.publicationDates}}));
    const key=this.syncKey(library, settings);
    if(this.synchronizing) return this.synchronizing.key===key ? this.synchronizing.promise : this.synchronizing.promise.catch(()=>{}).then(()=>this.syncFor(library, settings, background));
    const work=async()=> {
      const subscriptions=subscriptionsViewSchema.parse(await this.service('/v1/subscriptions',undefined,settings));
      sourceSnapshot=sourceSnapshot.map(source=>{const receipt=subscriptions.sources.find(receipt=>receipt.config.id===source.registry_id);return receipt?{...source,publicationDates:subscriptions.collectionScope==='today'&&receipt.config.platform==='wechat'?receipt.publicationDates??{}:undefined}:source;});
      if(settings.serviceUrl===this.settings.serviceUrl&&settings.serviceToken===this.settings.serviceToken)this.showSubscriptions(subscriptions);
      for (let page=0;page<100;page++) {
        const checkpoint=await library.checkpoint();
        const feed=feedSchema.parse(await this.service(`/v1/feed?after=${checkpoint.cursor}&instance=${encodeURIComponent(checkpoint.instance)}`,undefined,settings));
        await library.sync(feed);
        if(!feed.hasMore) {
          const conflicts=await library.conflicts(); let dailyMessage = '';
          if (!background && settings.autoDailyAi) {
            try { await this.reviewDaily(library, settings,updatesForDay(await library.list(),sourceSnapshot,beijingDate()).map(itemKey)); }
            catch (error) { dailyMessage = `；AI 导读未更新：${friendlyError(error)}`; }
          }
          try { await library.saveDaily(dailyOptions(settings), await reviewContext(settings.learningGoals, settings.guideModel, settings.guideUrl),updatesForDay(await library.list(),sourceSnapshot,beijingDate()).map(itemKey),this.groupMap(await library.list(),sourceSnapshot)); }
          catch (error) { dailyMessage += `；今日清单未更新：${friendlyError(error)}`; }
          const failed = subscriptions.sources.filter(source => source.config.enabled && source.status === 'error').length;
          return `已采集材料已同步${this.library!==library ? `，材料保存在 ${library.root}` : ''}${subscriptions.running ? '；后台仍在采集' : failed ? `；${failed} 个来源采集未完成，详情见信源` : ''}${conflicts.length ? `；${conflicts.length} 个已批注文件保留原内容，请查看材料覆盖说明` : ''}${dailyMessage}`;
        }
      }
      throw new Error('本轮同步批次已达上限，可再次同步继续');
    };
    const task={ key, promise:Promise.resolve('') }; this.synchronizing=task;
    task.promise=work().finally(()=>{if(this.synchronizing===task)this.synchronizing=null;}); return task.promise;
  }
  async buildDailyPlan(items: ReadingItem[], library = this.library) {
    const settings = { ...this.settings }; const context = await reviewContext(settings.learningGoals, settings.guideModel, settings.guideUrl);
    return makeDailyPlan(this.groupedItems(items), dailyOptions(settings), await library.reviews(), context);
  }
  get historyOptions() { return { maxItems: this.settings.historyMaxItems, sources: this.sources }; }
  async readHistoryHighlights(library: ReadingLibrary, excludedUrls: string[], options = this.historyOptions) {
    this.assertWritable();
    return library.historyHighlights({ ...options, excludedUrls });
  }
  private groupedItems(items:ReadingItem[],sources=this.sources){return items.map(item=>{const group=currentCategory(item,sources,this.categories);const category=this.categories.find(value=>value.id===group.id);return category?{...item,topic:category.topic,categoryId:category.id,categoryName:category.name}:item;});}
  private groupMap(items:ReadingItem[],sources=this.sources){return new Map(this.groupedItems(items,sources).map(item=>[itemKey(item),{topic:item.topic,categoryId:item.categoryId,categoryName:item.categoryName}]));}
  async saveDaily() {
    const library = this.library; const settings = { ...this.settings };
    const items=updatesForDay(await library.list(),this.sources,beijingDate()),keys=items.map(itemKey),groups=this.groupMap(items);
    const path = await library.saveDaily(dailyOptions(settings), await reviewContext(settings.learningGoals, settings.guideModel, settings.guideUrl),keys,groups);
    if (this.library === library) await this.openFile(path); return path;
  }
  async saveDailyFor(items:ReadingItem[],library:ReadingLibrary){const settings={...this.settings},groups=this.groupMap(items);const path=await library.saveDaily(dailyOptions(settings),await reviewContext(settings.learningGoals,settings.guideModel,settings.guideUrl),items.map(itemKey),groups);if(this.library===library)await this.openFile(path);return path;}
  async reviewDailyFor(items:ReadingItem[],library:ReadingLibrary){return this.reviewDaily(library,{...this.settings},items.map(itemKey));}
  async reviewDaily(library = this.library, settings = { ...this.settings },itemKeys?:readonly string[]) {
    const sources=this.sources.map(source=>({...source}));
    let session = this.reviewSessions.get(library.root);
    if (!session) { session = new DailyReviewSession(library); this.reviewSessions.set(library.root, session); }
    if (!session.pendingSave && !session.pendingRejected && (!settings.guideUrl || !settings.guideModel || !settings.guideKey)) throw new Error('请在连接与设置中配置轻处理模型（DeepSeek Flash）的基础地址、模型名和 API Key；规则精选已经可用');
    // A pending save bypasses changed configuration and even an empty current candidate list.
    const pending = session.pendingSave ?? session.pendingRejected?.receipt;
    const eligible=await library.list();const keys=new Set(itemKeys??updatesForDay(eligible,sources,beijingDate()).map(itemKey));
    const batch = pending ? { receipt: pending, messages: [], candidates: [] } : await buildReviewBatch(this.groupedItems(eligible.filter(item=>keys.has(itemKey(item))),sources), dailyOptions(settings), settings.guideModel, settings.guideUrl);
    await session.run(batch, settings.dailyAiLimit, messages => this.answerReview(messages, settings));
    let warning = '';
    try { await library.saveDaily(dailyOptions(settings), await reviewContext(settings.learningGoals, settings.guideModel, settings.guideUrl),[...keys],this.groupMap(eligible,sources)); }
    catch (error) { warning = `；今日清单保留：${friendlyError(error)}`; }
    return `AI 导读已保存${this.library !== library ? `于 ${library.root}` : ''}${warning}`;
  }
  async answerReview(messages: ChatMessage[], settings: Settings, maximumTokens=8000): Promise<ReviewResponse> {
    const response = await withTimeout(requestUrl({ url: `${apiBase(settings.guideUrl)}/chat/completions`, method: 'POST', headers: { Authorization: `Bearer ${settings.guideKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: settings.guideModel, messages, stream: false, max_tokens: maximumTokens, temperature: 0.2, response_format: { type: 'json_object' }, ...(new URL(settings.guideUrl).origin === 'https://api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}) }), throw: false }), 60_000, '轻处理模型响应超时，调用结果未知且可能已计费；本批不会重复发送，请核对提供方记录');
    if (response.status !== 200) throw new Error(`轻处理模型返回 HTTP ${response.status}；本批不会自动重发，请检查配置和提供方记录`);
    let result; try { result = JSON.parse(response.text); } catch { throw new Error('轻处理模型响应不是有效 JSON；本批不会自动重发'); }
    if (result?.choices?.[0]?.finish_reason && result.choices[0].finish_reason !== 'stop') throw new Error('轻处理模型生成被截断或中断；本批不会自动重发，请核对提供方记录');
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('轻处理模型没有返回有效导读');
    const input = result?.usage?.prompt_tokens, output = result?.usage?.completion_tokens;
    const usage = Number.isInteger(input) && input >= 0 && Number.isInteger(output) && output >= 0 ? { inputTokens: input, outputTokens: output } : undefined;
    return { content, usage };
  }
  async importUrl() {
    const library=this.library; const settings={...this.settings};
    const input = await new LinkModal(this.app,this.claudianReason).ask(); if (!input) return false;
    const host=new URL(input.url).hostname;const isX=['x.com','www.x.com','twitter.com','www.twitter.com'].includes(host);const isVideo=['youtube.com','www.youtube.com','m.youtube.com','youtu.be','bilibili.com','www.bilibili.com'].includes(host);
    const response = await this.service(isVideo?'/v1/transcript':isX?'/v1/exploration/x/free/post':'/v1/import',isVideo||isX?{url:input.url,topic:input.topic}:{ format: 'url', url: input.url, topic: input.topic },settings) as { material: unknown };
    const saved=await library.import(response.material);this.refresh();if(input.handoff)return this.handoffKnowledge(saved,library,input.mode);return this.library===library ? true : `链接已导入 ${library.root}`;
  }
  async importFile() {
    const library=this.library;const settings=structuredClone(this.settings);let saved:ReadingItem;
    const selected = await pickFile(); if (!selected) return false;
    const extension = selected.name.split('.').at(-1)?.toLowerCase(); const title = selected.name.replace(/\.[^.]+$/, '').slice(0, 240);
    if (!['md','html','htm','pdf','srt','vtt'].includes(extension ?? '')) throw new Error('支持 Markdown、HTML、PDF、SRT 与 VTT 文件');
    if (selected.size > 25_000_000) throw new Error('文件超过 25 MB，请拆分后导入');
    const format=extension==='md'?'markdown':extension==='pdf'?'pdf':'html';
    const options=await new FileOptionsModal(this.app,title,format,this.claudianReason).ask(); if(!options) return false;
    if (extension === 'srt' || extension === 'vtt') {
      const content=await selected.text();saved=await library.import(transcriptMaterial({title:`${title} · 文字稿`,source:'手动字幕文件',identity:options.identity,topic:options.topic,cues:parseSubtitles(content,true),original:{extension,base64:Buffer.from(content).toString('base64')}}));
    } else if (extension === 'md') {
      const body = await selected.text(); saved=await library.import(materialSchema.parse({ title, source: '手动导入', identity: options.identity, topic: options.topic, kind: 'markdown', capturedAt: new Date().toISOString(), body, coverage: 'full', guideKind: 'excerpt', guide: body.replace(/\s+/g, ' ').slice(0,180), gaps: ['用户投放的 Markdown 原件，未核验其中事实。'], original: { extension: 'md', base64: Buffer.from(body).toString('base64') } }));
    } else if (['html','htm','pdf'].includes(extension ?? '')) {
      const response = await this.service('/v1/import', { format, title, identity:options.identity,topic:options.topic, content: extension === 'pdf' ? Buffer.from(await selected.arrayBuffer()).toString('base64') : await selected.text() },settings) as { material: unknown };
      saved=await library.import(response.material);
    } else throw new Error('支持 Markdown、HTML 与 PDF 文件');
    this.refresh();if(options.handoff)return this.handoffKnowledge(saved,library,options.mode);return this.library===library ? true : `文件已导入 ${library.root}`;
  }

}
class WorkbenchView extends ItemView {
  workbench?: Workbench;
  private refreshTimer?:number;
  constructor(leaf: WorkspaceLeaf, private plugin: SourceWorkbench) { super(leaf); }
  getViewType() { return VIEW; } getDisplayText() { return WORKBENCH_NAME; } getIcon() { return WORKBENCH_ICON_ID; }
  async onOpen() { this.contentEl.empty(); this.workbench = new Workbench(this.contentEl, this.plugin); await this.workbench.refresh();this.refreshTimer=window.setInterval(()=>{void this.workbench?.refresh();void this.plugin.refreshSubscriptions();},20_000); }
  async onClose() { if(this.refreshTimer!==undefined)window.clearInterval(this.refreshTimer);this.workbench?.dispose(); }
}
class LinkModal extends Modal {
  constructor(app:App,private claudianReason=''){super(app);}
  private resolve?: (value: { url: string; topic: Topic;handoff?:boolean;mode?:KnowledgeMode } | null) => void;
  ask() { return new Promise<{ url: string; topic: Topic;handoff?:boolean;mode?:KnowledgeMode } | null>(resolve => { this.resolve = resolve; this.open(); }); }
  onOpen() {
    this.contentEl.createEl('h2', { text: '添加阅读链接' }); let value = ''; let topic: Topic = 'ai-learning';
    new Setting(this.contentEl).setName('原文链接').addText(input => input.setPlaceholder('https://mp.weixin.qq.com/s/…').onChange(next => { value = next; }));
    new Setting(this.contentEl).setName('学习板块').addDropdown(input => { for (const key of topics) input.addOption(key, topicLabels[key]); input.onChange(next => { topic = next as Topic; }); });
    new Setting(this.contentEl).addButton(button => button.setButtonText('导入').setCta().onClick(() => { try { const url = webUrl.parse(value.trim()); this.resolve?.({ url, topic }); this.resolve = undefined; this.close(); } catch { new Notice('请输入有效的 HTTP/HTTPS 原文链接'); } }));
    new Setting(this.contentEl).setDesc(this.claudianReason||'直接交给 Claudian 当前模型，默认等待讨论。').addButton(button=>button.setButtonText('导入并交给 Claudian').setDisabled(!!this.claudianReason).onClick(()=>{try{const url=webUrl.parse(value.trim());this.resolve?.({url,topic,handoff:true});this.resolve=undefined;this.close();}catch{new Notice('请输入有效的原文链接');}}));
    new Setting(this.contentEl).setDesc(this.claudianReason||'根据原文客观归纳，直接写入 08_LLM Wiki，无需讨论。').addButton(button=>button.setButtonText('导入并直接写入 Wiki').setDisabled(!!this.claudianReason).onClick(()=>{try{const url=webUrl.parse(value.trim());this.resolve?.({url,topic,handoff:true,mode:'direct-wiki'});this.resolve=undefined;this.close();}catch{new Notice('请输入有效的原文链接');}}));
  }
  onClose() { this.resolve?.(null); this.contentEl.empty(); }
}
class FileOptionsModal extends Modal {
  private resolve?: (value: {identity:string;topic:Topic;handoff?:boolean;mode?:KnowledgeMode} | null) => void;
  constructor(app:App,private title:string,private format:string,private claudianReason=''){super(app);}
  ask(){return new Promise<{identity:string;topic:Topic;handoff?:boolean;mode?:KnowledgeMode}|null>(resolve=>{this.resolve=resolve;this.open();});}
  onOpen(){
    this.contentEl.createEl('h2',{text:`导入 ${this.title}`});let identity=`local:${this.format}:${this.title}`;let topic:Topic='ai-learning';
    new Setting(this.contentEl).setName('学习板块').addDropdown(input=>{for(const key of topics) input.addOption(key,topicLabels[key]);input.onChange(value=>{topic=value as Topic;});});
    new Setting(this.contentEl).setName('来源标识').setDesc('更新同一份文件时保留此标识；同名的不同材料请填写不同标识。').addText(input=>{input.setValue(identity);input.inputEl.setAttribute('aria-label','来源标识');input.onChange(value=>{identity=value.trim();});});
    new Setting(this.contentEl).addButton(button=>button.setButtonText('确认导入').setCta().onClick(()=>{if(!identity||identity.length>4096){new Notice('请填写有效来源标识');return;}this.resolve?.({identity,topic});this.resolve=undefined;this.close();}));
    new Setting(this.contentEl).setDesc(this.claudianReason||'直接交给 Claudian 当前模型，默认等待讨论。').addButton(button=>button.setButtonText('导入并交给 Claudian').setDisabled(!!this.claudianReason).onClick(()=>{if(!identity||identity.length>4096){new Notice('请填写有效来源标识');return;}this.resolve?.({identity,topic,handoff:true});this.resolve=undefined;this.close();}));
    new Setting(this.contentEl).setDesc(this.claudianReason||'根据原文客观归纳，直接写入 08_LLM Wiki，无需讨论。').addButton(button=>button.setButtonText('导入并直接写入 Wiki').setDisabled(!!this.claudianReason).onClick(()=>{if(!identity||identity.length>4096){new Notice('请填写有效来源标识');return;}this.resolve?.({identity,topic,handoff:true,mode:'direct-wiki'});this.resolve=undefined;this.close();}));
  }
  onClose(){this.resolve?.(null);this.contentEl.empty();}
}
function pickFile(accept='.md,.html,.htm,.pdf,.srt,.vtt'): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept; input.style.display = 'none'; document.body.append(input);
    const finish = (file: File | null) => { resolve(file); input.remove(); };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true }); input.addEventListener('cancel', () => finish(null), { once: true }); input.click();
  });
}
class ConnectionModal extends Modal {
  constructor(app:App,private plugin:SourceWorkbench,private section?:SettingsSection){super(app);}
  onOpen(){this.modalEl.addClass('sw-settings-modal');new WorkbenchSettings(this.app,this.plugin).renderInto(this.contentEl,this.section);}
  onClose(){this.contentEl.empty();}
}
class SubscriptionsModal extends Modal {
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(app: App, private plugin: SourceWorkbench, private connection: Settings, private openAdd = false) { super(app); }
  async onOpen() {
    this.modalEl.addClass('sw-subscriptions-modal');
    this.contentEl.createEl('h2', { text: '来源订阅' });
    this.contentEl.createEl('p', { text: '粘贴公众号或其他 RSS/Atom、YouTube 频道主页或 B站 UP 主页即可添加。订阅开关在“信源”页点击即保存；本窗口修改后请保存。' });
    const container = this.contentEl.createDiv();
    try {
      const view = subscriptionsViewSchema.parse(await this.plugin.service('/v1/subscriptions', undefined, this.connection));
      if (!this.closed) this.render(container, view);
    } catch (error) {
      if (!this.closed) container.createEl('p', { text: error instanceof Error ? error.message : '请先连接材料服务' });
    }
  }
  private render(container: HTMLElement, initial: SubscriptionsView) {
    clearTimeout(this.timer); container.empty();
    const draft = initial.sources.map(source => ({ ...source.config })); const categories = structuredClone(initial.categories);
    let revision = initial.revision; let saving = false; let catchupDays = initial.catchupDays ?? 0;
    const receipts = new Map<string, HTMLElement>(); const groups = new Map<string, HTMLElement>();
    const message = container.createEl('p', { attr: { role: 'status' } });
    const update = (view: SubscriptionsView) => {
      if (this.closed) return;
      for (const source of view.sources) {
        const status = ({ 'not-configured': '未配置更新链接', paused: '已暂停', waiting: '等待检查', running: '正在检查', ok: '检查成功', error: '检查失败' })[source.status];
        const checked = source.lastAttempt ? new Date(source.lastAttempt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未实采';
        const node = receipts.get(source.config.id);
        if (node) node.textContent = `${source.status === 'error' ? subscriptionStatusText(source) : status} · ${checked} · 本轮新增 ${source.imported} 项${source.catchupImported ? `（其中补收旧文 ${source.catchupImported} 项）` : ''}${source.collectionMethod === 'browser' ? ' · 本机浏览器补抓' : ''}${source.config.platform === 'youtube' && source.collectionMethod === 'direct-api' ? ' · YouTube官方接口' : ''}${source.pending ? ` · 待继续 ${source.pending} 项` : ''}${source.error ? `\n${redactCollectionError(source.error)}` : ''}${source.lastFailure ? `\n最近失败 ${new Date(source.lastFailure.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}：${source.lastFailure.message}` : ''}`;
      }
      if (this.connection.serviceUrl === this.plugin.settings.serviceUrl && this.connection.serviceToken === this.plugin.settings.serviceToken) {
        this.plugin.showSubscriptions(view); this.plugin.refresh();
      }
    };
    const save = async (sources = draft, nextCategories = categories) => {
      if (this.closed || saving) throw new Error('订阅窗口已关闭或正在保存，请稍后重试');
      saving = true;
      const controls = [...container.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')].map(node => ({ node, disabled: node.disabled }));
      controls.forEach(({node}) => { node.disabled = true; });
      try {
        const input = subscriptionUpdateSchema.parse({ revision, sources, categories: nextCategories, ...(catchupDays !== (initial.catchupDays ?? 0) ? { catchupDays } : {}) });
        const next = subscriptionsViewSchema.parse(await this.plugin.service('/v1/subscriptions', input, this.connection));
        revision = next.revision; update(next);
        if (!this.closed) { this.render(container, next); new Notice('订阅与分类已保存'); }
      } finally { saving = false; controls.forEach(({node,disabled}) => { node.disabled = disabled; }); }
    };
    const add = () => new AddSourceModal(this.app, this.plugin, this.connection, categories, draft, async (config, nextCategories) => {
      if (draft.length >= 100) throw new Error('目前最多配置 100 个来源');
      await save([...draft, config], nextCategories);
    }).open();
    new Setting(container).addButton(button => button.setButtonText('添加来源').setCta().onClick(add))
      .addButton(button => button.setButtonText('管理分类').onClick(() => {
        new CategoriesModal(this.app, categories, draft, next => save(draft, next)).open();
      }));
    if (initial.collectionScope === 'today') new Setting(container).setName('断线与延迟补收')
      .setDesc('补收前几天仍在订阅里的遗漏文章，公众号会核验原页面。文章归入原发布日期，不早于开始使用日期；暂停的来源不抓取。修改后请保存。')
      .addDropdown(input => {
        input.selectEl.setAttribute('aria-label', '断线与延迟补收');
        for (const days of [0, 1, 3, 7]) input.addOption(String(days), days ? `补收前 ${days} 天` : '仅收当天');
        if (![0, 1, 3, 7].includes(catchupDays)) input.addOption(String(catchupDays), `补收前 ${catchupDays} 天`);
        input.setValue(String(catchupDays)).onChange(value => { catchupDays = Number(value); });
      });
    if (initial.sources.some(source => source.config.platform === 'youtube')) this.renderYoutubeAccess(container.createDiv({ cls: 'sw-youtube-access' }));
    new Setting(container).setName('选择来源').addDropdown(input => {
      input.selectEl.setAttribute('aria-label', '选择来源');
      for (const source of initial.sources) input.addOption(source.config.id, source.name);
      input.setValue(initial.sources[0]!.config.id).onChange(value => {
        for (const [id, group] of groups) group.style.display = id === value ? '' : 'none';
      });
    });
    for (const source of initial.sources) {
      const config = draft.find(item => item.id === source.config.id)!;
      if (!config.topic) { config.categoryId = 'leisure'; config.topic = 'leisure'; }
      const group = container.createDiv(); groups.set(config.id, group);
      if (config.id !== initial.sources[0]!.config.id) group.style.display = 'none';
      group.createEl('h3', { text: source.name });
      new Setting(group).setName('显示名称').addText(input => input.setValue(config.name ?? source.name).onChange(value => { config.name = value.trim(); }));
      new Setting(group).setName('更新链接').setDesc(['wechat', 'rss'].includes(config.platform) ? 'RSS/Atom 更新链接；可能包含私人订阅凭证，默认隐藏。' : 'YouTube 使用频道 RSS；B站使用已配置的 RSSHub 更新链接。').addText(input => {
        input.setValue(config.feedUrl); input.inputEl.type = ['wechat', 'rss'].includes(config.platform) ? 'password' : 'text';
        input.inputEl.setAttribute('aria-label', `${source.name}更新链接`); input.onChange(value => { config.feedUrl = value.trim(); });
      });
      new Setting(group).setName('分类').setDesc('移动后，工作台按新分类显示已有材料；正文和阅读进度保留。').addDropdown(input => {
        for (const category of categories) input.addOption(category.id, category.name);
        input.setValue(config.categoryId ?? config.topic ?? 'leisure'); input.selectEl.setAttribute('aria-label', `${source.name}分类`);
        input.onChange(value => { const category = categories.find(category => category.id === value)!; config.categoryId = value; config.topic = category.topic; });
      });
      new Setting(group).setName('订阅此来源').setDesc('关闭并保存后停止抓取，已收录材料和阅读进度保留；以后可以重新开启。').addToggle(input => { input.toggleEl.setAttribute('aria-label', `${source.name}订阅开关`); input.setValue(config.enabled).onChange(value => { config.enabled = value; }); });
      new Setting(group).setName('检查间隔').addDropdown(input => {
        for (const minutes of [...new Set([15, 30, 60, 180, 360, 1440, config.intervalMinutes])].sort((a,b) => a-b)) input.addOption(String(minutes), `${minutes} 分钟`);
        input.setValue(String(config.intervalMinutes)).onChange(value => { config.intervalMinutes = Number(value); });
      });
      receipts.set(config.id, group.createEl('p', { cls: 'sw-subscription-receipt', attr: { 'data-subscription-id': config.id } }));
    }
    const refreshReceipts = async () => {
      try {
        const next = subscriptionsViewSchema.parse(await this.plugin.service('/v1/subscriptions', undefined, this.connection));
        if (this.closed) return; update(next);
        if (next.running) this.timer = setTimeout(() => void refreshReceipts(), 2000);
        else message.textContent = '检查结束，可点击“同步材料”取得已保存的更新。失败原因见各来源回执。';
      } catch (error) { if (!this.closed) message.textContent = error instanceof Error ? error.message : '读取回执失败'; }
    };
    new Setting(container).addButton(button => button.setButtonText('保存订阅配置').onClick(async () => {
      button.setDisabled(true);
      try { await save(); } catch (error) { if (!this.closed) message.textContent = friendlyError(error); }
      finally { if (!this.closed) button.setDisabled(false); }
    })).addButton(button => button.setButtonText('立即检查更新').onClick(async () => {
      button.setDisabled(true); clearTimeout(this.timer);
      try {
        update(subscriptionsViewSchema.parse(await this.plugin.service('/v1/subscriptions/poll', {}, this.connection)));
        if (!this.closed) { message.textContent = '正在检查已保存的订阅；未保存的输入不会生效。'; this.timer = setTimeout(() => void refreshReceipts(), 1000); }
      } catch (error) { if (!this.closed) message.textContent = friendlyError(error); }
      finally { if (!this.closed) button.setDisabled(false); }
    }));
    update(initial);
    if (initial.running) this.timer = setTimeout(() => void refreshReceipts(), 1000);
    if (this.openAdd) { this.openAdd = false; add(); }
  }
  private renderYoutubeAccess(box: HTMLElement) {
    let state: YoutubeAccessView | undefined, draft = '', busy = false;
    const current = () => !this.closed && box.isConnected;
    box.createEl('h3', { text: 'YouTube 稳定连接' });
    box.createEl('p', { text: '可选配置一次官方 API 密钥，直接获取公开频道更新，减少网页登录验证的影响。未配置时继续使用 RSS 和公开主页。' });
    const help = box.createEl('a', { text: '打开 Google 配置页面', href: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com' }); help.target = '_blank'; help.rel = 'noopener noreferrer';
    const message = box.createEl('p', { attr: { role: 'status', 'aria-label': 'YouTube官方接口状态' }, text: '正在读取连接状态…' });
    const field = new Setting(box).setName('YouTube API 密钥').setDesc('仅保存在所连接后台的本地配置，不会回显。填写后请验证并保存。');
    let inputEl: HTMLInputElement;
    field.addText(input => { inputEl = input.inputEl; inputEl.type = 'password'; inputEl.autocomplete = 'off'; inputEl.setAttribute('aria-label', 'YouTube API密钥'); input.onChange(value => { draft = value; controls(); }); });
    const actions = new Setting(box); actions.settingEl.addClass('sw-youtube-access-actions'); let saveButton: HTMLButtonElement, clearButton: HTMLButtonElement;
    const controls = () => { inputEl.disabled = busy; saveButton.disabled = busy || !state || !draft.trim(); clearButton.disabled = busy || !state?.configured; };
    const show = (next: YoutubeAccessView) => {
      state = next;
      message.textContent = next.configured ? `${next.paused ? '官方接口今日暂停，其他路线继续尝试' : '官方接口已配置，下轮检查优先使用'} · 本配额日请求 ${next.requestsToday}/${next.dailyLimit}${next.lastError ? ` · ${next.lastError}` : ''}` : '尚未配置官方接口，当前使用 RSS 和公开主页；临时受限会自动重试。'; controls();
    };
    const submit = async (clear: boolean) => {
      if (busy || !state || !current()) return; busy = true; controls();
      try {
        const input = youtubeAccessUpdateSchema.parse(clear ? { revision: state.revision, clear: true } : { revision: state.revision, key: draft });
        const next = youtubeAccessViewSchema.parse(await this.plugin.service('/v1/youtube/access', input, this.connection));
        if (!current()) return; draft = ''; inputEl.value = ''; show(next); new Notice(clear ? '已关闭YouTube官方接口，继续使用现有路线' : 'YouTube官方接口已验证并保存');
      } catch (error) { if (current()) message.textContent = friendlyError(error); }
      finally { busy = false; if (current()) controls(); }
    };
    actions.addButton(button => { saveButton = button.buttonEl; button.setButtonText('验证并保存YouTube密钥').onClick(() => void submit(false)); })
      .addButton(button => { clearButton = button.buttonEl; button.setButtonText('移除本地YouTube密钥').onClick(() => void submit(true)); });
    controls();
    void this.plugin.service('/v1/youtube/access', undefined, this.connection).then(value => { if (current()) show(youtubeAccessViewSchema.parse(value)); }).catch(() => { if (current()) message.textContent = '官方接口状态暂不可读，请核对后台连接和版本；现有订阅配置保留。'; });
  }
  onClose() { this.closed = true; clearTimeout(this.timer); this.contentEl.empty(); }
}
function friendlyError(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: { message: string }[] }).issues;
    return issues.map(issue => issue.message).join('；');
  }
  return error instanceof Error ? error.message : '操作未完成';
}
class AddSourceModal extends Modal {
  private closed = false;
  constructor(app: App, private plugin: SourceWorkbench, private connection: Settings, private categories: SourceCategory[], private sources: SubscriptionConfig[], private save: (config: SubscriptionConfig, categories: SourceCategory[]) => Promise<void>) {
    super(app); this.categories = structuredClone(categories);
  }
  onOpen() {
    this.contentEl.createEl('h2', { text: '添加来源' });
    this.contentEl.createEl('p', { text: '粘贴公众号或其他 RSS/Atom 链接，也支持 YouTube 频道主页和 B站 UP 主页。识别后选分类并添加。' });
    let address = ''; let identified: ResolvedSource | null = null; let generation = 0; let name = ''; let categoryId = 'leisure'; let enabled = true; let busy = false;
    const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
    const preview = this.contentEl.createDiv();
    new Setting(this.contentEl).setName('来源地址').addText(input => {
      input.inputEl.type = 'password'; input.inputEl.setAttribute('aria-label','来源地址'); input.setPlaceholder('RSS / Atom / YouTube 主页 / B站 UP 主页');
      input.onChange(value => { address = value.trim(); identified = null; generation++; preview.empty(); status.textContent = ''; });
    });
    const draw = () => {
      preview.empty(); if (!identified) return;
      preview.createEl('p', { text: `已识别：${{wechat:'微信公众号',youtube:'YouTube',bilibili:'B站',rss:'RSS / Atom'}[identified.platform]} · ${identified.name}` });
      if (identified.platform === 'bilibili') preview.createEl('p', { text: identified.feedUrl.includes('/bilibili/user/video/') ? '将通过已配置的 RSSHub 检查视频更新；可修改显示名称。' : 'UP 主页已识别。能否读取最新视频，以保存后的采集回执为准；可修改显示名称。' });
      new Setting(preview).setName('来源名称').addText(input => { input.inputEl.setAttribute('aria-label','来源名称'); input.setValue(name).onChange(value => { name = value.trim(); }); });
      new Setting(preview).setName('分类').addDropdown(input => {
        input.selectEl.setAttribute('aria-label','新来源分类');
        for (const category of this.categories) input.addOption(category.id, category.name);
        input.setValue(categoryId).onChange(value => { categoryId = value; });
      });
      new Setting(preview).addButton(button => button.setButtonText('新建分类').onClick(() => {
        new CategoryNameModal(this.app, nextName => {
          const category: SourceCategory = { id: `cat-${crypto.randomUUID()}`, name: nextName, topic: 'leisure' };
          categoriesSchema.parse([...this.categories, category]); this.categories.push(category); categoryId = category.id; draw();
        }).open();
      }));
      new Setting(preview).setName('自动检查').addToggle(input => { input.toggleEl.setAttribute('aria-label','新来源自动检查'); input.setValue(enabled).onChange(value => { enabled = value; }); });
      new Setting(preview).setDesc('点击后保存此来源及当前订阅窗口中的修改；自动检查仅在材料服务运行时进行。').addButton(button => button.setButtonText('添加订阅').setCta().onClick(async () => {
        if (!identified || busy) return; busy = true; button.setDisabled(true);
        try {
          const category = this.categories.find(category => category.id === categoryId)!;
          await this.save({ ...makeSourceConfig(identified, category, name), enabled }, this.categories);
          if (!this.closed) this.close();
        } catch (error) { if (!this.closed) status.textContent = friendlyError(error); }
        finally { busy = false; if (!this.closed) button.setDisabled(false); }
      }));
    };
    new Setting(this.contentEl).addButton(button => button.setButtonText('识别来源').setCta().onClick(async () => {
      if (busy) return; busy = true; button.setDisabled(true); const current = ++generation; identified = null; preview.empty(); status.textContent = '正在识别来源…';
      try {
        const result = resolvedSourceSchema.parse(await this.plugin.service('/v1/sources/resolve', { input: address }, this.connection));
        if (this.closed || generation !== current) return; identified = useConfiguredBilibiliFeed(result, this.sources); name = result.name; status.textContent = ''; draw();
      } catch (error) { if (!this.closed && generation === current) status.textContent = friendlyError(error); }
      finally { busy = false; if (!this.closed) button.setDisabled(false); }
    }));
    this.contentEl.append(status, preview);
  }
  onClose() { this.closed = true; this.contentEl.empty(); }
}
class CategoryNameModal extends Modal {
  constructor(app: App, private submit: (name: string) => void) { super(app); }
  onOpen() {
    this.contentEl.createEl('h2', { text: '新建分类' }); let name = '';
    new Setting(this.contentEl).setName('分类名称').addText(input => {
      input.inputEl.setAttribute('aria-label','分类名称'); input.setPlaceholder('例如 美食、娱乐、科技').onChange(value => { name = value.trim(); });
    });
    const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
    new Setting(this.contentEl).addButton(button => button.setButtonText('创建分类').setCta().onClick(() => {
      try { if (!name || name.length > 60) throw new Error('请输入 1–60 字的分类名称'); this.submit(name); this.close(); }
      catch (error) { status.textContent = friendlyError(error); }
    }));
  }
  onClose() { this.contentEl.empty(); }
}
class CategoriesModal extends Modal {
  private closed = false;
  constructor(app: App, private categories: SourceCategory[], private sources: SubscriptionConfig[], private save: (categories: SourceCategory[]) => Promise<void>) {
    super(app); this.categories = structuredClone(categories);
  }
  onOpen() {
    this.contentEl.createEl('h2', { text: '管理分类' });
    this.contentEl.createEl('p', { text: '可以创建和改名。删除自建分类前，请先把其中来源移到其他分类；正文和阅读进度保留。' });
    const rows = this.contentEl.createDiv(); const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
    const draw = () => {
      rows.empty();
      for (const category of this.categories) {
        const count = this.sources.filter(source => (source.categoryId ?? source.topic) === category.id).length;
        const row = new Setting(rows).setName(category.name).setDesc(`${count} 个来源`).addText(input => {
          input.inputEl.setAttribute('aria-label',`${category.name}分类名称`); input.setValue(category.name).onChange(value => { category.name = value.trim(); });
        });
        if (category.id.startsWith('cat-')) row.addButton(button => button.setButtonText('删除分类').onClick(() => {
          if (count) { status.textContent = '请先移动这个分类中的来源并保存，再删除分类。'; return; }
          this.categories = this.categories.filter(item => item.id !== category.id); draw();
        }));
      }
    };
    draw();
    new Setting(this.contentEl).addButton(button => button.setButtonText('新建分类').onClick(() => new CategoryNameModal(this.app, name => {
      const category: SourceCategory = { id: `cat-${crypto.randomUUID()}`, name, topic: 'leisure' };
      categoriesSchema.parse([...this.categories, category]); this.categories.push(category); draw();
    }).open())).addButton(button => button.setButtonText('保存分类').setCta().onClick(async () => {
      button.setDisabled(true);
      try { await this.save(categoriesSchema.parse(this.categories)); if (!this.closed) this.close(); }
      catch (error) { if (!this.closed) status.textContent = friendlyError(error); }
      finally { if (!this.closed) button.setDisabled(false); }
    }));
  }
  onClose() { this.closed = true; this.contentEl.empty(); }
}
class ReadingFolderPicker extends SuggestModal<string>{
  private paths:string[]=[];
  constructor(app:App,roots:string[],private choose:(path:string)=>void){super(app);this.setPlaceholder('选择库内已有的独立阅读文件夹');
    const visit=(folder:TFolder)=>{for(const child of folder.children){if(!(child instanceof TFolder))continue;try{readingRoot(child.path);}catch{continue;}try{storageRoot(child.path,app.vault.configDir,roots);this.paths.push(child.path);}catch{}if(roots.some(root=>child.path===root||child.path.startsWith(root+'/'))||child.path===app.vault.configDir)continue;visit(child);}};visit(app.vault.getRoot());
  }
  getSuggestions(query:string){return this.paths.filter(path=>path.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>a.localeCompare(b));}
  renderSuggestion(path:string,el:HTMLElement){el.setText(path);}
  onChooseSuggestion(path:string){this.choose(path);}
}
class WorkbenchSettings extends PluginSettingTab {
  constructor(app: App, private plugin: SourceWorkbench) { super(app, plugin); }
  display() {
    this.renderInto(this.containerEl);
  }
  renderInto(container:HTMLElement,selected?:SettingsSection) {
    container.empty(); container.addClass('sw-settings-content'); container.createEl('h2', { text: `${WORKBENCH_NAME}设置` });
    container.createEl('p',{cls:'sw-muted',text:'按用途展开设置。修改先保留为草稿，点击底部保存后生效；关闭窗口放弃本次未保存修改。'});
    const group=(key:SettingsSection,name:string,description:string,open=false)=>{const section=container.createEl('details',{cls:'sw-settings-group'});section.open=selected?key===selected:open;section.dataset.section=key;section.createEl('summary',{text:name});section.createEl('p',{cls:'sw-muted',text:description});return section;};
    const storage=group('storage','阅读目录与文件保存','选择存储位置，保留正文、原件和阅读进度。',true);
    const connection=group('connection','订阅连接与自动同步','连接本机材料服务；同步已采集内容不会调用模型。',true);
    const daily=group('daily','今日阅读与短导读','可选功能。阅读预算只影响今日选读清单。');
    const exploration=group('exploration','兴趣与主动发现','寻找关注范围之外的内容，检索与AI筛选按已有配置调用。');
    const x=group('x','X账号与搜索','使用自己的账号或已配置渠道；搜索与发现共用每日推荐上限。');
    const updates=group('updates','版本与更新','社区版通过 Obsidian 的官方渠道更新。');
    const claudian=group('claudian','Claudian 接续','Claudian 更新后，在这里重新验证接续接口。');
    const footer=container.createDiv({cls:'sw-settings-footer'});
    const draft={...this.plugin.settings};
    const claudianStatus=claudian.createEl('p',{attr:{role:'status','aria-label':'Claudian 验证结果'},text:this.plugin.claudianStatus});
    new Setting(claudian).setName('验证当前 Claudian').setDesc('检查会话、草稿保护和发送接口；通过后立即保存，无需点击底部保存配置。不会发送消息或调用模型。接口不兼容时显示具体原因。').addButton(button=>button.setButtonText('验证 Claudian 接续').onClick(async()=>{button.setDisabled(true);claudianStatus.setText('正在验证 Claudian 接续接口…');try{const message=await this.plugin.verifyClaudian();claudianStatus.setText(message);new Notice(message);}catch(error){const message=friendlyError(error);claudianStatus.setText(`验证未通过：${message}`);new Notice(message);}finally{button.setDisabled(false);}}));
    new Setting(daily).setName('历史精选每日上限').setDesc('1～5项，默认2项；从全历史未读材料中兼顾价值和轮换。当天清单保存后固定，修改次日生效；不新增模型调用。').addText(input => { input.inputEl.type='number'; input.inputEl.setAttribute('aria-label','历史精选每日上限'); input.setValue(String(draft.historyMaxItems)).onChange(value=>{draft.historyMaxItems=value.trim()?Number(value):NaN;}); });
    new Setting(updates).setName(`当前版本 v${this.plugin.manifest.version}`).setDesc('请在 Obsidian 的第三方插件页面检查和安装更新。');
    const issueRow=this.plugin.configurationIssue?storage.createEl('p',{text:this.plugin.configurationIssue,cls:'sw-gap'}):null;
    const pathRow=new Setting(storage).setName('阅读目录').setDesc('选择已有文件夹，或输入新的库内相对目录。保存前不创建文件夹；切换不移动旧材料。');
    storage.createEl('p',{cls:'sw-muted',text:`当前仓库：${this.app.vault.getName()}。这里选择库内目录，不填写磁盘绝对路径。令牌和 API Key 也保存在本仓库插件配置中；同步配置目录会同步这些值。`});
    const preview=storage.createDiv({cls:'sw-muted'});preview.setAttribute('aria-label','存储位置预览');
    const showPreview=()=>{preview.empty();try{const root=storageRoot(draft.directory,this.app.vault.configDir);preview.createEl('p',{text:`当前使用：${this.plugin.settings.directory}；保存后使用：${root}`});preview.createEl('p',{text:`正文：${root}/阅读材料；原件：${root}/原件；导读、推荐和交接材料也保存在这个目录内。`});preview.createEl('p',{text:`插件配置：${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/data.json。RAW/Wiki由Claudian按协议写入08_LLM Wiki；材料服务数据在本机项目，不在Vault。`});}catch(error){preview.createEl('p',{cls:'sw-gap',text:error instanceof Error?error.message:'目录无效'});}};
    pathRow.addText(input=>{input.setValue(draft.directory);input.inputEl.setAttribute('aria-label','阅读目录');input.onChange(value=>{draft.directory=value;showPreview();});pathRow.addButton(button=>button.setButtonText('选择已有文件夹').onClick(()=>new ReadingFolderPicker(this.app,this.plugin.readingDirectories,path=>{draft.directory=path;input.setValue(path);showPreview();}).open()));});
    showPreview();
    type TextKey = { [K in keyof Settings]: Settings[K] extends string ? string extends Settings[K] ? K : never : never }[keyof Settings];
    const fields: [TextKey,string,string][] = [['serviceUrl','材料服务地址','使用当前运行实例的地址。'],['serviceToken','材料服务令牌','保存在本机，按实际服务数据目录取得。'],['guideUrl','轻处理模型 API 基础地址','用于每日精选与短导读的 DeepSeek Flash 或兼容接口基础地址。'],['guideModel','轻处理模型名称','按提供方控制台填实际模型名。每批最多12篇、每篇前2400字符。'],['guideKey','轻处理模型 API Key','点击生成 AI 精选时发送候选摘选；仅用在所配置提供方。密钥保存在本仓库插件配置中，若同步配置目录，密钥也会随之同步。']];
    for (const [key,name,description] of fields) new Setting(key.startsWith('service')?connection:daily).setName(name).setDesc(description).addText(input => {
      input.setValue(draft[key]);input.inputEl.setAttribute('aria-label',name); if (/Token|Key/.test(key)) input.inputEl.type = 'password';
      input.onChange(value=>{draft[key]=value;});
    });

    new Setting(connection).setName('自动同步订阅').setDesc('打开 Obsidian、打开工作台和定时检查时同步新材料；后台同步不调用 AI。').addToggle(input => { input.toggleEl.setAttribute('aria-label', '自动同步订阅'); input.setValue(draft.autoSync).onChange(value => { draft.autoSync = value; }); });
    new Setting(connection).setName('自动同步间隔').setDesc('1～60分钟，默认5分钟；来源抓取间隔在订阅中设置。').addText(input => { input.inputEl.type='number'; input.inputEl.setAttribute('aria-label','自动同步间隔'); input.setValue(String(draft.syncIntervalMinutes)).onChange(value=>{draft.syncIntervalMinutes=value.trim()?Number(value):NaN;}); });
    for (const [key, name, description] of [['dailyBudget', '每日正文阅读预算', '5～180分钟；视频观看时间未知，另列更新。'], ['dailyMaxItems', '每日主要材料上限', '1～5项；默认3项，没有合适正文时少选。'], ['dailyAiLimit', '每日 AI 批次上限', '1～5批；默认1批。失败和结果未知也计入；已有结果复用不计新增调用。']] as const) new Setting(daily).setName(name).setDesc(description).addText(input => {
      input.inputEl.type = 'number'; input.inputEl.setAttribute('aria-label', name); input.setValue(String(draft[key])).onChange(value => { draft[key] = value.trim() ? Number(value) : NaN; });
    });
    new Setting(daily).setName('学习目标与起点').setDesc('用于 AI 阅读价值评分；可以修改，旧导读仍保留但不沿用旧目标评分。').addTextArea(input => { input.inputEl.setAttribute('aria-label', '学习目标与起点'); input.inputEl.maxLength = 2000; input.setValue(draft.learningGoals).onChange(value => { draft.learningGoals = value; }); });
    new Setting(daily).setName('同步后自动生成 AI 精选').setDesc('默认关闭。开启且配置轻处理模型后，每次同步按每日上限处理；相同批次复用，失败或结果未知不会重发。').addToggle(input => { input.toggleEl.setAttribute('aria-label', '同步后自动生成 AI 精选'); input.setValue(draft.autoDailyAi).onChange(value => { draft.autoDailyAi = value; }); });

    new Setting(exploration).setName('自动探索新内容').setDesc('打开Obsidian或工作台时补查，之后每小时检查是否已有当天任务；每天一批，按下方总数上限精选。模型调用单独计费。').addToggle(input => { input.toggleEl.setAttribute('aria-label','自动探索新内容'); input.setValue(draft.autoExplore).onChange(value=>{draft.autoExplore=value;}); });
    new Setting(exploration).setName('每日探索推荐上限').setDesc('1～12条，默认目标1～3条；综合网页、X与近期未读订阅共用总数。缺额时显示原因，当天已有回执按首次配置保留。').addText(input=>{input.inputEl.type='number';input.inputEl.setAttribute('aria-label','每日探索推荐上限');input.setValue(String(draft.explorationMaxItems)).onChange(value=>{draft.explorationMaxItems=value.trim()?Number(value):NaN;});});
    for(const topic of discoveryTopics)new Setting(exploration).setName(topic.name).setDesc('纳入主动发现；不影响已订阅来源的更新。').addToggle(input=>{input.toggleEl.setAttribute('aria-label',`发现板块：${topic.name}`);input.setValue(draft.discoveryTopics.includes(topic.id)).onChange(value=>{const next=value?[...draft.discoveryTopics.filter(id=>id!==topic.id),topic.id]:draft.discoveryTopics.filter(id=>id!==topic.id);if(!next.length){new Notice('至少保留一个发现板块');input.setValue(true);return;}draft.discoveryTopics=next;});});
    new Setting(exploration).setName('探索检索渠道').setDesc('DeepSeek原生联网复用上方模型Key，无需另买搜索服务，会产生模型用量；公开检索以技术社区为主；Tavily需要搜索Key。').addDropdown(input => { input.selectEl.setAttribute('aria-label','探索检索渠道'); input.addOption('deepseek-web','DeepSeek原生联网').addOption('public','免Key技术社区检索').addOption('tavily','Tavily网页检索').setValue(draft.searchProvider).onChange(value=>{draft.searchProvider=value as Settings['searchProvider'];}); });
    new Setting(exploration).setName('搜索 API Key').setDesc('仅Tavily需要；本地保存，发送到该检索提供方。').addText(input=>{input.inputEl.type='password';input.inputEl.setAttribute('aria-label','搜索 API Key');input.setValue(draft.searchKey).onChange(value=>{draft.searchKey=value;});});
    new Setting(exploration).setName('探索关键词').setDesc('1～2行补充偏好；开启板块中的任一方向即可相关，不要求所有关键词同时命中。原生联网适合跨板块发现，公开技术社区覆盖较窄。').addTextArea(input=>{input.inputEl.setAttribute('aria-label','探索关键词');input.inputEl.maxLength=500;input.setValue(draft.searchQueries).onChange(value=>{draft.searchQueries=value;});});
    new Setting(exploration).setName('探索兴趣与内容偏好').setDesc('关注哪些方向、希望看什么形式的内容；与每日正文阅读的学习起点分别保存。').addTextArea(input=>{input.inputEl.setAttribute('aria-label','探索兴趣与内容偏好');input.inputEl.maxLength=2000;input.setValue(draft.explorationGoals).onChange(value=>{draft.explorationGoals=value;});});

    new Setting(x).setName('加入X热门搜索').setDesc('按开启板块搜索近七天Top帖子，每日最多三个首页。免费接法使用你自己的X账号，与其他渠道共用每日推荐上限。').addToggle(input=>{input.toggleEl.setAttribute('aria-label','加入X热门搜索');input.setValue(draft.xEnabled).onChange(value=>{draft.xEnabled=value;});});
    new Setting(x).setName('X接入方式').setDesc('默认免费账号接入；SocialData保留为可选付费渠道，不会自动切换或代充值。AI筛选仍使用已有模型连接。').addDropdown(input=>{input.selectEl.setAttribute('aria-label','X接入方式');input.addOption('free','免费 · 自己的X账号').addOption('socialdata','SocialData · 付费').setValue(draft.xProvider).onChange(value=>{draft.xProvider=value as Settings['xProvider'];});});
    new Setting(x).setName('免费X账号连接').setDesc('打开专用登录窗口，完成登录后只在本机保存X登录状态。登录失效时可再次连接，不用在聊天里发送凭据。').addButton(button=>button.setButtonText('连接X账号').onClick(async()=>{button.setDisabled(true);try{await this.plugin.service('/v1/exploration/x/free/login',{},parseSettings(draft));new Notice('请在专用X窗口完成登录，随后点击检查X连接');}catch(error){new Notice(friendlyError(error));}finally{button.setDisabled(false);}}));
    new Setting(x).setName('SocialData API Key').setDesc('仅选择付费渠道时使用。当前因最低充值门槛暂缓；免费接法不需要此Key，也不调用此接口。').addText(input=>{input.inputEl.type='password';input.inputEl.setAttribute('aria-label','SocialData API Key');input.setValue(draft.socialDataKey).onChange(value=>{draft.socialDataKey=value;});});
    new Setting(x).setName('X连接与用量').setDesc('免费渠道查看本日搜索与缓存状态。选择SocialData时查看$0.50月度调用阈值；实际最低充值额度以支付页为准。').addButton(button=>button.setButtonText('检查X连接').onClick(async()=>{button.setDisabled(true);try{new Notice(await this.plugin.refreshXStatus(parseSettings(draft)));}catch(error){new Notice(friendlyError(error));}finally{button.setDisabled(false);}}));
    const errorRow=footer.createEl('p',{cls:'sw-gap'});errorRow.setAttribute('aria-label','配置保存结果');
    new Setting(footer).setName('保存配置').setDesc('修改后点击保存；正在处理的材料继续保存到发起操作时的目录。').addButton(button=>button.setButtonText('保存配置').setCta().onClick(async()=>{button.setDisabled(true);try{await this.plugin.applySettings(draft);errorRow.setText('配置已保存');issueRow?.remove();showPreview();new Notice('配置已保存');}catch(error){const message=settingsError(error);errorRow.setText(message);new Notice(message);}finally{button.setDisabled(false);}}));
    new Setting(connection).setName('检查服务连接').addButton(button => button.setButtonText('检查连接').onClick(async () => {button.setDisabled(true); try { const status = await this.plugin.service('/v1/status',undefined,parseSettings(draft)) as { subscriptions?: string }; new Notice(`本地材料服务连接成功；${status.subscriptions === 'configured' ? '订阅已配置，实际结果见来源订阅' : '更新收集器尚未配置'}`); } catch(error) { new Notice(error instanceof Error ? error.message : '连接失败'); } finally{button.setDisabled(false);} }));
  }
}
