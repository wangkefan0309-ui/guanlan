import { canonicalIdentity, coverageLabels, type ReadingItem } from '../core/model';
import { estimateMinutes, type ReadingLibrary } from '../core/library';
import { makeDailyPlan, itemKey, beijingDate } from '../core/daily';
import { defaultCategories } from '../core/categories';
import { sourcePriorities, updateSourceId } from '../core/updates';
import { discoveryTopics, topicName } from '../core/discovery-topics';
import { knowledgePending, type KnowledgeStatus } from '../core/knowledge';
import type { ExplorationRecommendation,ExplorationDay } from '../core/exploration';
import { discoveryCoverageLabel } from '../core/exploration-scoring';
import { currentCategory, type WorkbenchHost } from './workbench';
import { latestItems, knowledgeLane, publicationLabel, isVideoLink,isVideoMaterial, previewText, type KnowledgeLane } from './workbench-state';
import { updatesForDay, updatesByDay, archiveDays, publicationDay, publicationItems } from '../core/subscription-days';
import {dateCalendar,dateTitle,shiftDay,validDay,positionCalendar,type CalendarState} from './date-calendar';
import {capturePosition} from './view-position';
import type { HistoryArchive } from '../core/history';
import { WORKBENCH_NAME, WORKBENCH_TAGLINE } from './workbench-brand';

type Page = 'updates' | 'explore' | 'history' | 'library' | 'knowledge' | 'sources';
type ReadingFilter = 'all' | 'unread' | 'reading' | 'later' | 'done' | 'trash';
type UpdateFilter = 'all' | 'today' | 'videos';
const libraryPageSize=25;
const pages: [Page, string, string][] = [
  ['updates', '来讯', '订阅更新按日期汇集，只看所选日期发布的内容。'],
  ['explore', '远眺', '探索推荐，看看关注范围之外还有哪些内容值得读。'],
  ['history', '拾遗', '每天精选历史未读材料，接着读完曾经收藏的内容。'],
  ['library', '藏卷', '找到保存过的文章、视频、文字稿和文件，接着上次读。'],
  ['knowledge', '续思', '继续材料讨论，查看 Wiki 归纳与知识处理进度。'],
  ['sources', '信源', '管理订阅与分类，查看关注来源和实际采集结果。'],
];
const progressLabels = { unread: '未读', later: '稍后读', reading: '阅读中', done: '已读' };
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}
function button(text: string, action: () => void, cls = 'sw-button') {
  const node = el('button', cls, text); node.type = 'button';node.dataset.focusKey=`${cls}:${text}`; node.addEventListener('click', action); return node;
}
function disclosure(label: string, cls = '') {
  const node = el('details', `sw-disclosure ${cls}`); node.append(el('summary', '', label)); return node;
}
function select(label: string, entries: [string, string][], value: string) {
  const node = el('select', 'sw-input'); node.setAttribute('aria-label', label);
  for (const [key, text] of entries) { const option = el('option', '', text); option.value = key; node.append(option); }
  node.value = value; return node;
}

export class Workbench {
  private page: Page = 'updates';
  private updateFilter: UpdateFilter = 'all';
  private updateDate = beijingDate();
  private followingToday = true;
  private explorationDate=beijingDate();
  private followingExploreToday=true;
  private updateCalendar:CalendarState={open:false,month:''};
  private explorationCalendar:CalendarState={open:false,month:''};
  private archiveQuery = '';
  private expandedSources = new Set<string>();
  private readingFilter: ReadingFilter = 'all';
  private lane: KnowledgeLane | '' = '';
  private history = false;
  private source = '';
  private category = '';
  private query = '';
  private readingOffset = 0;
  private explorationSection = '';
  private selected: string | null = null;
  private message = '';
  private messageError = false;
  private readWarning='';
  private busy = false;
  private disposed = false;
  private generation = 0;
  private refreshTask?: Promise<void>;
  private refreshRequested = false;
  private pointerHeld = false;
  private deferredRefresh = false;
  private readonly holdPointer = (event:PointerEvent) => { this.pointerHeld = true;if(!(event.target as Element)?.closest('.sw-calendar')){this.updateCalendar.open=false;this.explorationCalendar.open=false;for(const panel of this.root.querySelectorAll<HTMLElement>('.sw-calendar-panel'))panel.hidden=true;for(const trigger of this.root.querySelectorAll<HTMLElement>('.sw-calendar-trigger'))trigger.setAttribute('aria-expanded','false');} };
  private readonly releasePointer = () => { window.setTimeout(() => { this.pointerHeld = false; if(this.deferredRefresh&&!this.disposed){this.deferredRefresh=false;void this.refresh();} },0); };
  private renderedSnapshot = '';
  private renderedLibrary?: ReadingLibrary;
  private items: ReadingItem[] = [];
  private trash: { item: ReadingItem; deletedAt: string }[] = [];
  private batchMode = false;
  private batchIds = new Set<string>();
  private confirmingTrash: string[] | null = null;
  private readonly cancelDelete = (event: KeyboardEvent) => { if (event.key === 'Escape' && this.confirmingTrash) { this.confirmingTrash = null; event.preventDefault(); this.render(); } };
  private latestVersions = new Map<string, string>();
  private knowledge = new Map<string, KnowledgeStatus>();
  private exploration: ExplorationRecommendation[] = [];
  private explorationDays:ExplorationDay[]=[];
  private conflicts: string[] = [];
  private dailyPlan = makeDailyPlan([]);
  private historyArchive: HistoryArchive = { date: beijingDate(), days: [], remainingCount: 0, rotatedCount: 0 };
  private historyDate = beijingDate();
  private followingHistoryToday = true;
  private historyWarning = '';
  private drafts = new Map<string, { progress: ReadingItem['progress']; position: string }>();
  private expanded = new Set<string>();

  constructor(private root: HTMLElement, private host: WorkbenchHost) {
    root.classList.add('sw-root');const loading=el('div','sw-loading');loading.setAttribute('role','status');loading.append(el('h2','','正在读取已保存材料…'),el('p','sw-muted','原件、阅读进度和推荐记录正在加载。'));root.replaceChildren(loading);
    root.addEventListener('pointerdown',this.holdPointer,true);
    root.addEventListener('keydown', this.cancelDelete);
    window.addEventListener('pointerup',this.releasePointer,true);window.addEventListener('pointercancel',this.releasePointer,true);
  }

  refresh(): Promise<void> {
    if(this.disposed)return Promise.resolve();
    this.refreshRequested=true;++this.generation;
    if(this.refreshTask)return this.refreshTask;
    this.refreshTask=(async()=>{while(this.refreshRequested&&!this.disposed){this.refreshRequested=false;await this.refreshOnce();}})().finally(()=>{this.refreshTask=undefined;});
    return this.refreshTask;
  }
  private async refreshOnce(): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation, library = this.host.library;
    const historyOptions = structuredClone(this.host.historyOptions ?? {});
    if (this.followingToday) this.updateDate = beijingDate();
    if(this.followingExploreToday)this.explorationDate=beijingDate();
    try {
      const items = publicationItems(await library.list(),this.host.sources);
      const trash = await library.listTrash?.() ?? [];
      const [knowledge, conflicts, plan] = await Promise.all([
        this.host.knowledgeStatuses?.(items, library) ?? Promise.resolve(new Map<string, KnowledgeStatus>()),
        library.conflicts(),
        this.host.buildDailyPlan?.(updatesForDay(items, this.host.sources, this.updateDate), library) ?? Promise.resolve(makeDailyPlan(updatesForDay(items, this.host.sources, this.updateDate))),
      ]);
      let warning = '';
      let exploration:ExplorationRecommendation[]=[],explorationDays:ExplorationDay[]=[];
      try{
        if(this.host.readExplorationArchive){const archive=await this.host.readExplorationArchive(library);exploration=archive.recommendations;explorationDays=archive.days;}
        else{exploration=await this.host.readExploration?.(library)??[];explorationDays=[...new Map(exploration.map(item=>[item.run.date,{date:item.run.date,status:item.run.status??'completed',count:exploration.filter(value=>value.run.date===item.run.date).length,warnings:item.run.search?.warnings??[]}])).values()];}
      }catch(error){const cached=this.renderedLibrary===library;warning=`探索记录未读取${cached?'，保留上次已读取内容':''}：${this.error(error)}`;if(cached){exploration=this.exploration;explorationDays=this.explorationDays;}}
      let historyArchive: HistoryArchive = { date: beijingDate(), days: [], remainingCount: 0, rotatedCount: 0 }, historyWarning = '';
      try {
        if (warning) throw new Error('探索记录暂不可读，历史精选暂缓生成，请恢复记录后重试');
        historyArchive = await this.host.readHistoryHighlights?.(library, exploration.filter(item => item.run.date === beijingDate()).map(item => item.candidate.url), historyOptions) ?? historyArchive;
      } catch (error) { historyWarning = this.error(error); if (this.renderedLibrary === library) historyArchive = { ...this.historyArchive, date: beijingDate() }; }
      if (this.disposed || generation !== this.generation || library !== this.host.library) return;
      if (this.renderedLibrary && this.renderedLibrary !== library) {
        this.historyDate = beijingDate(); this.followingHistoryToday = true;
        this.trash = []; this.batchIds.clear(); this.batchMode = false; this.confirmingTrash = null;
        this.selected = null; this.query = ''; this.archiveQuery = ''; this.category = ''; this.source = ''; this.expanded.clear();this.expandedSources.clear(); this.message = ''; this.messageError = false;this.explorationDate=beijingDate();this.followingExploreToday=true;this.updateDate=beijingDate();this.followingToday=true;this.updateCalendar={open:false,month:''};this.explorationCalendar={open:false,month:''};
      }
      this.renderedLibrary = library;
      this.historyArchive = historyArchive; this.historyWarning = historyWarning;
      if (this.followingHistoryToday) this.historyDate = historyArchive.date;
      this.items = items; this.trash = trash; this.latestVersions = new Map(items.map(item => [item.id, item.version])); this.knowledge = knowledge; this.conflicts = conflicts; this.dailyPlan = plan; this.exploration = exploration;this.explorationDays=explorationDays;this.readWarning=warning;
      const availableIds = new Set((this.readingFilter === 'trash' ? trash.map(entry => entry.item) : items).map(item => item.id));
      for (const id of this.batchIds) if (!availableIds.has(id)) this.batchIds.delete(id);
      const snapshot = this.snapshot();
      if (snapshot !== this.renderedSnapshot) { if(this.pointerHeld)this.deferredRefresh=true;else{this.render(snapshot);} }
    } catch (error) {
      if (this.disposed || generation !== this.generation || library !== this.host.library) return;
      this.trash = []; this.batchIds.clear(); this.confirmingTrash = null;
      this.historyArchive = { date: beijingDate(), days: [], remainingCount: 0, rotatedCount: 0 }; this.historyWarning = '';
      this.items = []; this.knowledge.clear(); this.exploration = [];this.explorationDays=[];this.readWarning=''; this.conflicts = []; this.dailyPlan = makeDailyPlan([]);
      this.selected = null; this.message = this.error(error); this.messageError = true; this.renderedSnapshot = ''; this.render();
    }
  }
  dispose() { this.disposed = true; ++this.generation;this.root.removeEventListener('pointerdown',this.holdPointer,true);this.root.removeEventListener('keydown',this.cancelDelete);window.removeEventListener('pointerup',this.releasePointer,true);window.removeEventListener('pointercancel',this.releasePointer,true);this.root.replaceChildren(); }
  updateBlockReason(){return this.busy?'材料操作正在进行，请完成后再更新':this.drafts.size?'有未保存的阅读批注，请保存或放弃修改后再更新':'';}
  private error(error: unknown) { return error instanceof Error ? error.message : '操作失败，请检查连接或本地文件'; }
  private snapshot() {
    return JSON.stringify({ root: this.host.library.root, page: this.page, update: this.updateFilter, date:this.updateDate,exploreDate:this.explorationDate, scope:this.host.collectionScope,catchupDays:this.host.catchupDays,started:this.host.collectionStartedAt, reading: this.readingFilter, lane: this.lane, history: this.history,
      items: this.items, trash: this.trash, batch: [...this.batchIds], batchMode: this.batchMode, confirmingTrash: this.confirmingTrash, knowledge: [...this.knowledge], conflicts: this.conflicts, plan: this.dailyPlan, exploration: this.exploration,explorationDays:this.explorationDays,readWarning:this.readWarning, historyArchive:this.historyArchive,historyDate:this.historyDate,historyWarning:this.historyWarning,
      sources: this.host.sources, categories: this.host.categories, message: this.message, error: this.messageError, busy: this.busy,
      claudian: this.host.claudianReason, configuration: this.host.configurationIssue, sync: this.host.syncSummary, subscriptions: this.host.subscriptionSummary,
      explore: this.host.explorationSummary, autoExplore: this.host.autoExplorationEnabled, x: this.host.xSummary, guide: this.host.guideConfigured, review: this.host.reviewActionLabel, exploreAction: this.host.explorationActionLabel,pluginUpdate:this.host.updateSummary,updateAvailable:this.host.updateAvailable });
  }

  private operation(label: string, work: () => Promise<unknown>, success = '', cls = 'sw-button') {
    const node = button(label, () => void this.run(work, success, label), cls);
    node.dataset.swOperation = 'true'; node.disabled = this.busy; return node;
  }
  private async run(work: () => Promise<unknown>, success = '', label = '处理材料') {
    if (this.busy || this.disposed) return;
    const focused = this.root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
    const library = this.host.library;
    this.busy = true; this.messageError = false; this.message = `正在${label.replace(/[↗…]/g, '').trim()}…`;
    this.updateStatus();
    for (const node of this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-sw-operation], .sw-batch-select input, .sw-material-management button')) node.disabled = true;
    try {
      // Invoke before any await: the adapter captures the current library and connection now.
      const result = await work();
      this.message = result === false ? '已取消' : typeof result === 'string' ? result : success || '操作完成';
    } catch (error) { this.message = this.error(error); this.messageError = true; }
    finally {
      this.busy = false; this.renderedSnapshot = ''; await this.refresh();
      if (focused && library === this.host.library && document.activeElement === document.body) [...this.root.querySelectorAll<HTMLElement>('[data-focus-key]')].find(node => node.dataset.focusKey === focused)?.focus({ preventScroll: true });
    }
  }
  private updateStatus() {
    const node = this.root.querySelector<HTMLElement>('.sw-status');
    if (node) { node.textContent = this.readWarning||this.message; node.classList.toggle('is-error',!!this.readWarning||this.messageError); }
    this.root.setAttribute('aria-busy', String(this.busy));
  }
  private go(page: Page) {
    this.batchIds.clear(); this.confirmingTrash = null; this.batchMode = false;
    this.page = page; this.selected = null; this.query = ''; this.category = ''; this.source = ''; this.readingOffset=0; this.expanded.clear();
    if(page==='updates'){this.updateDate=beijingDate();this.followingToday=true;this.updateFilter='all';this.expandedSources.clear();this.updateCalendar={open:false,month:beijingDate().slice(0,7)};}
    if(page==='explore'){this.explorationDate=beijingDate();this.followingExploreToday=true;this.explorationSection='';this.explorationCalendar={open:false,month:beijingDate().slice(0,7)};}
    if(page==='history'){this.historyDate=this.historyArchive.date;this.followingHistoryToday=true;}
    this.renderedSnapshot = ''; this.render(); this.root.scrollTop = 0;
  }
  private render(snapshot=this.snapshot()) {
    if (this.disposed) return;
    this.renderedSnapshot = snapshot;
    const restorePosition=capturePosition(this.root);
    const detailScroll = this.root.querySelector('.sw-detail')?.scrollTop ?? 0;
    for (const node of this.root.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')) {
      if (node.open) this.expanded.add(node.dataset.disclosure!); else this.expanded.delete(node.dataset.disclosure!);
    }
    this.root.classList.add('sw-root'); this.root.setAttribute('aria-busy', String(this.busy));
    this.root.dataset.libraryRoot=this.host.library.root;
    const frame = el('div', 'sw-frame'), nav = el('nav', 'sw-nav'); nav.setAttribute('aria-label', '工作台导航');
    frame.append(nav);
    nav.append(el('div', 'sw-brand', WORKBENCH_NAME), el('div', 'sw-brand-sub', WORKBENCH_TAGLINE));
    const latest = latestItems(this.items), updates = updatesForDay(this.items, this.host.sources,this.updateDate);
    const counts: Record<Page, number> = { updates: new Set(updates.map(item=>updateSourceId(item,this.host.sources))).size, explore: this.exploration.filter(item=>item.run.date===this.explorationDate).length, history: this.historyItems(this.historyArchive.date).length, library: latest.length, knowledge: this.knowledge.size, sources: this.host.sources.length };
    for (const [page, label, description] of pages) {
      const node = button('', () => this.go(page), `sw-nav-button ${this.page === page ? 'is-active' : ''}`);
      node.dataset.focusKey=`nav:${page}`;
      node.title=description;
      node.append(el('span', '', label), el('span', 'sw-count', String(counts[page])));
      if (this.page === page) node.setAttribute('aria-current', 'page'); nav.append(node);
    }
    const bottom = el('div', 'sw-nav-bottom'); nav.append(bottom);
    const settingsButton = button('设置', () => this.host.configure(), 'sw-nav-button sw-settings');
    settingsButton.title='连接、偏好与版本更新';
    bottom.append(settingsButton, el('small', 'sw-storage', `阅读目录 · ${this.host.library.root}`));
    const main = el('main', 'sw-main'); frame.append(main);
    const [_, title, description] = pages.find(([page]) => page === this.page)!;
    const heading = el('header', 'sw-header'), titleBlock = el('div');
    titleBlock.append(el('div', 'sw-eyebrow', WORKBENCH_NAME), el('h1', '', title), el('p', 'sw-subtitle', description));
    const actions = el('div', 'sw-actions'); heading.append(titleBlock, actions); main.append(heading);
    if (this.page === 'updates') {
      if (this.host.checkUpdates) actions.append(this.operation('检查并同步', () => this.host.checkUpdates!()));
      actions.append(this.operation('同步已采集材料', () => this.host.sync(), '已采集材料已同步'));
      if (this.host.addSource) actions.append(button('添加来源', () => this.host.addSource!()));
      actions.append(button('管理订阅', () => this.go('sources')));
    }
    if (this.page === 'sources') {
      if (this.host.checkUpdates) actions.append(this.operation('检查并同步', () => this.host.checkUpdates!()));
      if (this.host.addSource) actions.append(button('添加来源', () => this.host.addSource!(), 'sw-button sw-primary'));
      if (this.host.configureSubscriptions) actions.append(button('管理订阅与分类', () => this.host.configureSubscriptions!()));
    } else {
      const menu = disclosure('添加材料', 'sw-add-menu');
      menu.append(this.operation('添加链接', () => this.importResult('link')), this.operation('导入文件', () => this.importResult('file')));
      actions.append(menu);
    }
    const status = el('div', `sw-status ${this.messageError||this.readWarning ? 'is-error' : ''}`, this.readWarning||this.message);
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); main.append(status);
    if(this.host.updateAvailable){const row=el('div','sw-update-notice');row.append(el('span','',this.host.updateSummary??'有新版本可用'),button('查看更新',()=>this.host.configure('updates')));main.append(row);}
    if (this.host.configurationIssue) {
      const issue = el('div', 'sw-alert'); issue.append(el('p', '', this.host.configurationIssue), button('检查连接与设置', () => this.host.configure())); main.append(issue);
    }
    if (this.page === 'updates') {
      const sync = el('div', 'sw-sync-note'); sync.append(el('span', '', this.host.syncSummary || '本地已保存材料'), el('span', '', this.host.subscriptionSummary || '采集连接尚未核对'));
      main.append(sync); this.renderDates(main);
      const failed = this.host.sources.filter(source => source.enabled && source.collectionStatus === 'error');
      if (failed.length) {
        const alert = el('section', 'sw-alert'); alert.setAttribute('aria-label', '订阅采集未完成');
        const network = failed.filter(source => source.collectionIssue === 'network').length;
        alert.append(el('p', '', `最近检查有 ${failed.length} 个来源尚未完成：${failed.map(source => source.display_name).join('、')}。${network ? `其中 ${network} 个遇到网络问题，后台会自动重试，无需重填密钥。` : ''}此页只显示已收录内容，缺项不表示作者未更新。`), button('查看原因和重试时间', () => this.go('sources')));
        main.append(alert);
      }
      if (this.updateDate === beijingDate()) {
        const history = el('section', 'sw-history-entry'); history.setAttribute('aria-label', '今日历史精选');
        history.append(el('div', '', this.historyWarning ? `历史精选暂不可用：${this.historyWarning}` : `拾遗 · 今天还有 ${this.historyItems(this.historyArchive.date).length} 项可补读`), button('查看拾遗', () => this.go('history'))); main.append(history);
      }
      const entries:[UpdateFilter,string,number][]=[['all','当天全部',updates.length],['videos','视频更新',updates.filter(isVideoMaterial).length]];
      if(this.updateDate===beijingDate())entries.push(['today','今日阅读',this.dailyPlan.picks.length]);
      main.append(this.tabs(entries, this.updateFilter, value => { this.updateFilter = value; this.selected = null; this.render(); }, '更新视图'));
      if (this.updateFilter === 'today') this.renderDaily(main);
    }
    if (this.page === 'library') {
      main.append(this.tabs<ReadingFilter>([['all', '全部材料', latest.length], ['unread', '未读材料', latest.filter(i => i.progress === 'unread').length], ['reading', '阅读中', latest.filter(i => i.progress === 'reading').length], ['later', '稍后再读', latest.filter(i => i.progress === 'later').length], ['done', '已读材料', latest.filter(i => i.progress === 'done').length], ['trash', '回收站', new Set(this.trash.map(entry => entry.item.id)).size]], this.readingFilter, value => { this.readingFilter = value; this.selected = null; this.batchIds.clear(); this.confirmingTrash = null; this.readingOffset = 0; this.render(); }, '阅读进度筛选'));
    }
    if (this.page === 'knowledge') {
      const entries: [KnowledgeLane | '', string, number][] = [['', '全部接续', this.knowledge.size], ['pending', '待处理', this.statusCount('pending')], ['discussion', '待讨论', this.statusCount('discussion')], ['complete', '已归纳', this.statusCount('complete')], ['issue', '需检查', this.statusCount('issue')]];
      if (this.statusCount('cancelled')) entries.push(['cancelled', '已取消', this.statusCount('cancelled')]);
      main.append(this.tabs(entries, this.lane, value => { this.lane = value; this.selected = null; this.render(); }, '知识进度筛选'));
    }
    if (this.page === 'sources') this.renderSources(main);
    else if (this.page === 'explore') this.renderExploration(main);
    else { if (this.page === 'history') this.renderHistory(main); this.renderReading(main); }
    this.root.replaceChildren(frame);restorePosition();
    const detail = this.root.querySelector('.sw-detail'); if (detail) detail.scrollTop = detailScroll;
    for(const panel of this.root.querySelectorAll<HTMLElement>('.sw-calendar-panel:not([hidden])'))positionCalendar(panel,this.root);
  }
  // The outer operation already holds the UI lock; invoke the import adapter here.
  private async importResult(which: 'link' | 'file') {
    const library = this.host.library, before = new Set((await library.list()).map(itemKey));
    if (this.host.library !== library) return false;
    const result = await (which === 'link' ? this.host.importUrl() : this.host.importFile());
    if (result === false) return false;
    if (this.host.library === library) {
      const saved = (await library.list()).filter(item => !before.has(itemKey(item))).at(-1);
      this.page = 'library'; this.readingFilter = 'all'; this.history = false; this.source = ''; this.category = ''; this.query = '';
      this.selected = saved ? itemKey(saved) : null;
    }
    return typeof result === 'string' ? result : which === 'link' ? '链接已导入' : '文件已导入';
  }
  private tabs<T extends string>(entries: [T, string, number][], current: T, choose: (value: T) => void, label: string) {
    const tabs = el('div', 'sw-tabs'); tabs.setAttribute('aria-label', label);
    for (const [value, text, count] of entries) {
      const node = button(`${text} ${count}`, () => choose(value), `sw-tab ${current === value ? 'is-active' : ''}`);
      node.setAttribute('aria-pressed', String(current === value)); tabs.append(node);
    }
    return tabs;
  }
  private statusCount(lane: KnowledgeLane) { return [...this.knowledge.values()].filter(status => knowledgeLane(status) === lane).length; }
  private details(label: string, id: string) {
    const node = disclosure(label); node.dataset.disclosure = id; node.open = this.expanded.has(id); return node;
  }
  private renderDaily(main: HTMLElement) {
    const plan = this.dailyPlan, summary = el('section', 'sw-daily-summary');
    summary.append(el('strong', '', `今天选读 ${plan.picks.length} 项 · 约 ${plan.totalMinutes} 分钟`), el('p', 'sw-muted', `阅读预算 ${plan.options.budgetMinutes} 分钟 · ${plan.mode === 'rules' ? '按规则选择正文' : '使用已保存的 AI 评价与短导读'}`));
    const actions = el('div', 'sw-actions');
    const items=updatesForDay(this.items,this.host.sources,this.updateDate),library=this.host.library;
    if (this.host.saveDaily) actions.append(this.operation('打开今日阅读笔记', () => this.host.saveDailyFor?this.host.saveDailyFor(items,library):this.host.saveDaily!()));
    if (this.host.reviewDaily) {
      const retry = this.host.reviewActionLabel?.startsWith('重试保存');
      const node = this.operation(this.host.reviewActionLabel ?? '生成 AI 精选', () => this.host.reviewDailyFor?this.host.reviewDailyFor(items,library):this.host.reviewDaily!());
      if (!retry && !this.host.guideConfigured) { node.disabled = true; node.title = '请先配置轻处理模型'; summary.append(el('p', 'sw-muted', '规则清单已可用；生成 AI 导读需要配置轻处理模型。'), button('配置导读模型', () => this.host.configure('daily'))); }
      actions.append(node);
    }
    summary.append(actions); main.append(summary);
  }

  private categories() { return this.host.categories ?? defaultCategories(); }
  private historyItems(date: string): ReadingItem[] {
    const receipt = this.historyArchive.days.find(day => day.date === date), latest = new Map(this.items.map(item => [item.id, item]));
    return (receipt?.picks ?? []).flatMap(pick => {
      const item = this.items.find(item => item.id === pick.id && item.version === pick.version);
      return item && item.progress !== 'done' && latest.get(item.id)?.progress !== 'done' ? [item] : [];
    });
  }
  private renderHistory(main: HTMLElement) {
    const section = el('section', 'sw-daily-summary sw-history-summary'); section.setAttribute('aria-label', '历史精选清单');
    const day = this.historyArchive.days.find(day => day.date === this.historyDate), count = this.historyItems(this.historyDate).length;
    section.append(el('strong', '', `${this.historyDate} · ${day?.picks.length ?? 0} 项精选，${count} 项仍待阅读`), el('p', 'sw-muted', `全历史未读 ${this.historyArchive.remainingCount} 项，其中 ${this.historyArchive.rotatedCount} 项已进入过轮换。原发布日期、阅读位置和批注继续保留。`), el('p', 'sw-muted', '当天清单固定；已读或删除后不再展示，其他材料留到后续日期。未读推荐间隔至少7天，稍后读至少14天；不新增模型调用。'));
    if (this.historyWarning) section.append(el('p', 'sw-alert', `历史精选未保存或读取：${this.historyWarning}`));
    const dates = [...new Set([this.historyArchive.date, ...this.historyArchive.days.map(day => day.date)])].sort().reverse();
    const date = select('历史精选日期', dates.map(day => [day, `${day}${day === this.historyArchive.date ? ' · 今天' : ''}`]), this.historyDate);
    date.addEventListener('change', () => { this.historyDate = date.value; this.followingHistoryToday = date.value === this.historyArchive.date; this.selected = null; this.render(); });
    const actions = el('div', 'sw-actions'); actions.append(date, this.operation('刷新历史精选', () => this.refresh(), '历史精选已刷新'), button('调整每日数量', () => this.host.configure('daily'))); section.append(actions); main.append(section);
  }
  private chooseUpdateDay(day:string,key?:string){
    if(!validDay(day)||day>beijingDate())return;this.updateDate=day;this.followingToday=day===beijingDate();this.updateCalendar.open=false;this.selected=key??null;
    if(key){const item=this.items.find(item=>itemKey(item)===key);if(item)this.expandedSources.add(`${day}:${updateSourceId(item,this.host.sources)}`);}
    this.updateFilter='all';this.query='';this.category='';this.source='';this.renderedSnapshot='';void this.refresh().then(()=>{this.root.scrollTop=0;this.root.querySelector<HTMLButtonElement>('[data-focus-key="calendar:更新日期"]')?.focus({preventScroll:true});});
  }
  private renderDates(main:HTMLElement){
    const today=beijingDate(),days=archiveDays(this.items,this.host.sources,this.host.collectionStartedAt),updates=updatesForDay(this.items,this.host.sources,this.updateDate);
    const byDay=updatesByDay(this.items,this.host.sources,today);
    const section=el('section','sw-date-pages');section.setAttribute('aria-label','按日期查看更新');
    const bar=el('div','sw-date-bar'),title=el('div');
    const accounts=new Set(updates.map(item=>updateSourceId(item,this.host.sources)).filter(Boolean));
    const total=this.host.sources.length,min=days.at(-1)??today;
    title.append(el('small','sw-date-year',`${this.updateDate.slice(0,4)} 年 · 作者发布日期`),el('h2','',dateTitle(this.updateDate,today)),el('p','sw-muted',`已收录 ${updates.length} 项内容 · 来自 ${accounts.size} / ${total} 个来源`));
    const choose=(day:string,key?:string)=>this.chooseUpdateDay(day,key);
    bar.append(title,dateCalendar({date:this.updateDate,today,min,label:'更新日期',counts:new Map(days.map(day=>[day,byDay.get(day)?.length??0])),state:this.updateCalendar,choose}));section.append(bar);
    const recent=el('div','sw-date-links');
    const previous=button('前一天',()=>choose(shiftDay(this.updateDate,-1))),next=button('后一天',()=>choose(shiftDay(this.updateDate,1)));previous.disabled=this.updateDate<=min;next.disabled=this.updateDate>=today;
    recent.append(previous,next);if(this.updateDate!==today)recent.append(button('回到今天',()=>choose(today),'sw-button sw-primary'));section.append(recent);
    const checked=this.host.sources.filter(source=>source.daily?.date===this.updateDate&&source.collectionStatus==='ok').length;
    const undated=this.host.sources.reduce((n,source)=>n+(source.daily?.date===this.updateDate?source.daily.undated:0),0);
    section.append(el('p','sw-date-coverage',this.host.collectionScope==='today'?`按实际发布时间收录当天内容 · ${checked}/${total} 个来源的当天检查已完成${undated?` · ${undated}条发布时间待核对，未收录`:''}`:'后台采集范围尚未核对；当前页面按发布时间显示当天材料'));
    const history=this.details('检索历史更新','archive-search'),search=el('input','sw-search'),results=el('div','sw-archive-results');search.type='search';search.value=this.archiveQuery;search.placeholder='跨日期搜索标题、来源或正文';search.setAttribute('aria-label','检索历史更新');
    history.append(el('p','sw-muted','检索所有日期的已保存订阅内容；点击结果打开它所在的日期页。'),search,results);
    const draw=()=>{results.replaceChildren();const query=this.archiveQuery.trim().toLocaleLowerCase();if(!query)return;const matches=[...byDay].filter(([day])=>day<=today).flatMap(([,items])=>items).filter(item=>`${item.title} ${item.source} ${item.body}`.toLocaleLowerCase().includes(query)).sort((a,b)=>Date.parse(b.publishedAt!)-Date.parse(a.publishedAt!));
      results.append(el('p','sw-muted',`找到 ${matches.length} 项`));
      for(const item of matches)results.append(button(`${publicationDay(item)} · ${item.title}`,()=>{history.open=false;choose(publicationDay(item)!,itemKey(item));},'sw-archive-result'));
    };
    search.addEventListener('input',()=>{this.archiveQuery=search.value;draw();});draw();section.append(history);
    main.append(section);
  }
  private baseItems() {
    if (this.page === 'history') return this.historyItems(this.historyDate);
    if (this.page === 'knowledge') return this.items.filter(item => { const status = this.knowledge.get(itemKey(item)); return status && (!this.lane || knowledgeLane(status) === this.lane); }).slice().reverse();
    if (this.page === 'updates') {
      const updates = updatesForDay(this.items, this.host.sources,this.updateDate);
      if (this.updateFilter === 'today') {const keys=new Set(updates.map(itemKey));return this.dailyPlan.picks.map(pick => pick.item).filter(item=>keys.has(itemKey(item)));}
      return this.updateFilter === 'videos' ? updates.filter(isVideoMaterial).sort((a, b) => Date.parse(b.publishedAt ?? b.capturedAt) - Date.parse(a.publishedAt ?? a.capturedAt)) : updates;
    }
    if (this.readingFilter === 'trash') return latestItems(this.trash.map(entry => entry.item)).reverse();
    const items = this.history ? this.items : latestItems(this.items);
    return items.filter(item => this.readingFilter === 'all' || item.progress === this.readingFilter).slice().reverse();
  }
  private visibleItems() {
    return this.baseItems().filter(item => {
      const category = currentCategory(item, this.host.sources, this.categories());
      return (!this.category || this.category === category.id) && (!this.source || updateSourceId(item, this.host.sources) === this.source) &&
        `${item.title} ${item.source} ${category.name}`.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase());
    });
  }
  private assertSavedFor(ids: string[], library: ReadingLibrary) {
    if (this.items.some(item => ids.includes(item.id) && this.drafts.has(`${library.root}:${itemKey(item)}`))) throw new Error('选中的材料有未保存的阅读进度，请先保存后再管理');
  }
  private renderMaterialManagement(main: HTMLElement, library: ReadingLibrary) {
    const bar = el('section', 'sw-material-management'); bar.setAttribute('aria-label', '材料管理');
    const inTrash = this.readingFilter === 'trash';
    if (inTrash) bar.append(el('p', 'sw-muted', '回收站可恢复全部版本和阅读进度。正文、批注及原件保留在原路径，暂不释放磁盘空间；已有 RAW / Wiki 和讨论不受影响。'));
    bar.append(button(this.batchMode ? '退出批量管理' : '批量管理', () => { this.batchMode = !this.batchMode; this.batchIds.clear(); this.confirmingTrash = null; this.render(); }));
    if (this.batchMode) {
      const ids = [...this.batchIds], visibleIds = [...new Set(this.visibleItems().map(item => item.id))];
      bar.append(el('span', 'sw-muted', `已选择 ${ids.length} 篇`), button(`全选筛选结果（${visibleIds.length} 篇）`, () => { this.batchIds = new Set(visibleIds); this.confirmingTrash = null; this.render(); }), button('清空选择', () => { this.batchIds.clear(); this.confirmingTrash = null; this.render(); }));
      if (inTrash) {
        const restore = this.operation('恢复选中材料', async () => { const count = await library.restoreItems(ids); this.batchIds.clear(); return `已恢复 ${count} 篇材料`; }); restore.disabled ||= !ids.length; bar.append(restore);
      } else {
        for (const [label, progress] of [['标记已读', 'done'], ['移到稍后读', 'later'], ['标记未读', 'unread']] as const) {
          const action = this.operation(label, async () => { this.assertSavedFor(ids, library); const count = await library.updateManyProgress(ids, progress); this.batchIds.clear(); return `已更新 ${count} 篇材料`; }); action.disabled ||= !ids.length; bar.append(action);
        }
        const remove = button('删除选中材料', () => { this.confirmingTrash = ids; this.render(); }); remove.disabled = this.busy || !ids.length; bar.append(remove);
      }
    }
    if (this.confirmingTrash?.length) {
      const ids = [...this.confirmingTrash], confirmation = el('div', 'sw-delete-confirm'); confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-label', '确认删除材料');
      confirmation.append(el('p', '', `将 ${ids.length} 篇材料及其全部历史版本移入回收站？同步不会重新加入，正文批注和原件可随时恢复。`), this.operation('确认移入回收站', async () => {
        this.assertSavedFor(ids, library);
        const count = await library.trashItems(ids);
        if (library === this.host.library) { this.confirmingTrash = null; this.batchIds.clear(); this.selected = null; }
        return `已将 ${count} 篇材料移入回收站，可在回收站恢复`;
      }), button('取消删除', () => { this.confirmingTrash = null; this.render(); }));
      confirmation.addEventListener('keydown', event => { if (event.key === 'Escape') { this.confirmingTrash = null; this.render(); } });
      bar.append(confirmation);
    }
    main.append(bar);
  }
  private renderReading(main: HTMLElement) {
    const categories = this.categories();
    if (!categories.some(c => c.id === this.category)) this.category = '';
    if (!this.host.sources.some(s => s.registry_id === this.source)) this.source = '';
    const filters = el('div', 'sw-filters'), search = el('input', 'sw-search');
    search.type = 'search'; search.placeholder = '搜索标题、来源或分类'; search.setAttribute('aria-label', '搜索材料'); search.value = this.query;
    const category = select('按分类筛选', [['', '全部分类'], ...categories.map(c => [c.id, c.name] as [string, string])], this.category);
    const source = select('按来源筛选', [['', '全部来源'], ...this.host.sources.filter(s => s.registry_id).map(s => [s.registry_id!, s.display_name] as [string, string])], this.source);
    filters.append(search, category, source); main.append(filters);
    if (this.page === 'library') {
      const label = el('label', 'sw-history-toggle'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = this.history;
      checkbox.addEventListener('change', () => { this.history = checkbox.checked; this.selected = null; this.render(); });
      label.append(checkbox, document.createTextNode('显示历史版本')); main.append(label);
      this.renderMaterialManagement(main, this.host.library);
    }
    const result = el('p', 'sw-result-count'), content = el('div', 'sw-content'), list = el('section', 'sw-list'), detail = el('aside', 'sw-detail');
    detail.setAttribute('aria-label', '材料详情'); content.append(list, detail); main.append(result, content);
    const library = this.host.library;
    const draw = (preservePosition=true) => {
      const restorePosition=preservePosition?capturePosition(this.root):()=>{};
      const visible = this.visibleItems();
      if (!visible.some(item => itemKey(item) === this.selected)) this.selected = null;
      const grouped=this.page==='updates'&&this.updateFilter!=='today'&&!this.query&&!this.source;
      const groups=new Map<string,ReadingItem[]>();if(grouped)for(const item of visible){const id=updateSourceId(item,this.host.sources)!;groups.set(id,[...(groups.get(id)??[]),item]);}
      result.textContent = grouped?`已收录 ${groups.size} 个来源的 ${visible.length} 项内容，先看每个来源的最新一项`:`显示 ${visible.length} 项${this.page === 'library' && this.history ? ' · 含历史版本' : ''}`;
      content.classList.toggle('has-selection', !!this.selected);
      const children=document.createDocumentFragment();detail.replaceChildren(); detail.hidden = !this.selected;
      if (!visible.length){const empty=el('div');this.emptyReading(empty);children.append(empty);}
      const cardFor=(item:ReadingItem)=>this.materialCard(item, library, () => {
        this.selected = itemKey(item); this.expanded.clear(); draw();
        if (getComputedStyle(list).display === 'none'){const navHeight=this.root.querySelector('.sw-nav')?.getBoundingClientRect().height??0;detail.style.scrollMarginTop=`${navHeight+16}px`;detail.scrollIntoView({ block: 'start' });detail.querySelector<HTMLButtonElement>('.sw-detail-top button')?.focus({preventScroll:true});}
      });
      if(grouped)for(const[id,entries]of groups){const group=el('section','sw-update-group'),name=this.host.sources.find(source=>source.registry_id===id)?.display_name??entries[0]!.source;
        group.dataset.sourceId=id;const heading=el('h3','sw-update-group-title');heading.append(el('span','sw-update-source-name',name),el('span','sw-update-source-count',`${entries.length} 项更新`));group.append(heading);const expanded=this.expandedSources.has(`${this.updateDate}:${id}`);
        for(const item of expanded?entries:entries.slice(0,1))group.append(cardFor(item));
        if(entries.length>1){const toggle=button(expanded?'收起其他更新':`展开本日全部 ${entries.length} 项`,()=>{const key=`${this.updateDate}:${id}`;if(expanded)this.expandedSources.delete(key);else this.expandedSources.add(key);draw();},'sw-text-button sw-expand-updates');toggle.dataset.focusKey=`source:${id}:expand`;toggle.setAttribute('aria-expanded',String(expanded));group.append(toggle);}
        children.append(group);
      }else {
        const limited=this.page==='library';this.readingOffset=Math.min(this.readingOffset,Math.max(0,Math.floor((visible.length-1)/libraryPageSize)*libraryPageSize));
        const shown=limited?visible.slice(this.readingOffset,this.readingOffset+libraryPageSize):visible;
        for(const item of shown)children.append(cardFor(item));
        if(limited&&visible.length>libraryPageSize){
          const pager=el('div','sw-list-pages'),previous=button('上一页材料',()=>{this.readingOffset-=libraryPageSize;this.selected=null;draw();}),next=button('下一页材料',()=>{this.readingOffset+=libraryPageSize;this.selected=null;draw();});
          previous.disabled=this.readingOffset===0;next.disabled=this.readingOffset+libraryPageSize>=visible.length;
          pager.append(previous,el('span','sw-muted',`${this.readingOffset+1}–${this.readingOffset+shown.length} / ${visible.length}`),next);children.append(pager);
        }
      }
      list.replaceChildren(children);
      const selected = visible.find(item => itemKey(item) === this.selected);
      if (selected) this.renderDetail(detail, selected, library, () => { this.selected = null; draw(); });
      restorePosition();
    };
    const changed = () => { this.readingOffset = 0; this.batchIds.clear(); this.confirmingTrash = null; if (this.page === 'library' && this.batchMode) this.render(); else draw(); };
    search.addEventListener('input', () => { this.query = search.value; changed(); });
    category.addEventListener('change', () => { this.category = category.value; changed(); });
    source.addEventListener('change', () => { this.source = source.value; changed(); });
    draw(false);
  }
  private emptyReading(container: HTMLElement) {
    const filtered = !!(this.query || this.category || this.source), empty = el('div', 'sw-empty');
    if (this.page === 'history' && !filtered) {
      const picked = this.historyArchive.days.find(day => day.date === this.historyDate)?.picks.length;
      empty.append(el('h2', '', this.historyWarning ? '暂时无法准备历史精选' : picked ? '这份清单暂时没有待阅读材料' : '今天先轻松一点'), el('p', '', this.historyWarning || (picked ? '本日材料已读完或移入回收站，下一天会继续轮换。' : '没有符合条件的历史材料，或候选仍在推荐间隔内；后续会继续检查。'))); container.append(empty); return;
    }
    if(this.page==='updates'&&!filtered&&this.updateFilter!=='today'){
      empty.append(el('h2','',this.updateDate===beijingDate()?'今天暂时没有新内容':`${this.updateDate} 没有已保存更新`),el('p','',this.updateFilter==='videos'?'这个日期暂时没有视频更新。':'当天发布的订阅内容会显示在这里。采集失败或尚未完成检查时，请查看来源状态。'));
      empty.append(button('查看来源状态',()=>this.go('sources')),button('查看已有材料',()=>this.go('library')));container.append(empty);return;
    }
    const title = filtered ? '没有找到匹配的材料' : this.page === 'knowledge' ? '这里还没有接续任务' : this.page === 'library' && this.readingFilter !== 'all' ? '这个阅读列表暂时是空的' : this.page === 'updates' && this.updateFilter === 'today' ? '暂时没有合适的选读正文' : '从一篇想读的内容开始';
    empty.append(el('h2', '', title), el('p', '', filtered ? '可以缩短关键词，或清除分类与来源条件。' : this.page === 'knowledge' ? '在材料详情中选择“交给 Claudian 处理”，之后回到这里继续讨论。' : '添加文章链接，或导入 Markdown、HTML、PDF、SRT / VTT 文件。'));
    if (filtered) empty.append(button('清除筛选', () => { this.query = ''; this.category = ''; this.source = ''; this.render(); }));
    else if (this.page === 'knowledge') empty.append(button('去藏卷选一篇材料', () => this.go('library'), 'sw-button sw-primary'));
    else empty.append(this.operation('添加链接', () => this.importResult('link'), '', 'sw-button sw-primary'), this.operation('导入文件', () => this.importResult('file')));
    container.append(empty);
  }
  private materialCard(item: ReadingItem, library: ReadingLibrary, choose: () => void) {
    const key = itemKey(item), video = isVideoLink(item), card = el('article', `sw-card ${this.selected === key ? 'is-selected' : ''}`);
    card.dataset.itemKey = key;
    if (this.page === 'library' && this.batchMode) {
      const label = el('label', 'sw-batch-select'), input = el('input'); input.type = 'checkbox'; input.checked = this.batchIds.has(item.id); input.disabled = this.busy;
      input.setAttribute('aria-label', `选择材料：${item.title}`);
      input.addEventListener('change', () => { if (input.checked) this.batchIds.add(item.id); else this.batchIds.delete(item.id); this.confirmingTrash = null; this.render(); });
      label.append(input, document.createTextNode('选择')); card.append(label);
    }
    const meta = el('div', 'sw-card-meta');const group=currentCategory(item,this.host.sources,this.categories()).name;
    meta.append(el('span','sw-topic',`${updateSourceId(item,this.host.sources)?'来源分组':'分类'} · ${group}`), el('span', '', publicationLabel(item)));
    if (this.page === 'updates' && this.updateFilter === 'all') { const priority = sourcePriorities[updateSourceId(item, this.host.sources) ?? '']; if (priority) meta.append(el('span', '', `优先级 ${priority}`)); }
    const title = button(item.title, choose, 'sw-card-title'); title.setAttribute('aria-label', item.title); title.setAttribute('aria-expanded', String(this.selected === key));
    card.append(meta, title);
    const pick = this.page === 'updates' && this.updateFilter === 'today' ? this.dailyPlan.picks.find(p => itemKey(p.item) === key) : undefined;
    if (pick) card.append(el('p', 'sw-pick-reason', `选读理由 · ${pick.reason}`));
    if (this.page === 'history') {
      const reference = this.historyArchive.days.find(day => day.date === this.historyDate)?.picks.find(pick => pick.id === item.id);
      if (reference) card.append(el('p', 'sw-pick-reason', `精选理由 · ${reference.reason}`));
    }
    const guide = pick?.review?.guide ?? item.guide;
    const excerpt = previewText(guide || item.body);
    card.append(el('p', 'sw-excerpt', excerpt || (video ? '可以打开原视频观看，或留到稍后再看。' : '正文尚未取得，可以打开原链接。')));
    if (pick?.review) card.append(el('p', 'sw-guide-scope', `AI 导读 · ${pick.model} · 前 ${pick.review.sampledChars}/${pick.review.totalChars} 字符`));
    else if (item.guideKind === 'ai' && guide) card.append(el('small', 'sw-guide-scope', 'AI 短导读'));
    const status = this.knowledge.get(key);
    if (status) card.append(el('p', `sw-knowledge-label ${knowledgeLane(status) === 'issue' ? 'is-error' : ''}`, status.label));
    const footer = el('div', 'sw-card-footer'); footer.append(el('span', '', item.source), el('span', 'sw-chip', video ? '视频 · 未取得文字稿' : isVideoMaterial(item)?'视频 · 已有文字稿':coverageLabels[item.coverage]), el('span', '', progressLabels[item.progress]));
    if (!video && item.coverage !== 'metadata') footer.append(el('span', '', `正文约 ${estimateMinutes(item.body)} 分钟`));
    if (this.latestVersions.get(item.id) !== item.version) footer.append(el('span', 'sw-chip', '历史版本'));
    card.append(footer);
    const actions = el('div', 'sw-card-actions');
    if (this.page === 'history') actions.append(this.operation('标记已读', async () => { this.assertSavedFor([item.id], library); await library.updateManyProgress([item.id], 'done'); }, '已标记已读', 'sw-text-button'));
    if (this.page === 'knowledge' && status?.receipt?.conversationId && !status.issue && this.host.handoffKnowledge) {
      const node = this.operation('继续讨论', () => this.host.handoffKnowledge!(item, library), '', 'sw-text-button'); node.disabled ||= !!this.host.claudianReason; actions.append(node);
      if (this.host.claudianReason) node.title = this.host.claudianReason;
    } else if (video && item.url) actions.append(button('观看视频 ↗', () => this.host.openOriginal(item.url!), 'sw-text-button'));
    else actions.append(this.operation(item.coverage === 'metadata' ? '打开链接笔记' : '阅读正文', () => this.host.openFile(item.path), '', 'sw-text-button'));
    if(!video&&isVideoMaterial(item)&&item.url)actions.append(button('观看原视频 ↗',()=>this.host.openOriginal(item.url!),'sw-text-button'));
    if (!(this.page === 'library' && this.readingFilter === 'trash') && (item.progress === 'unread' || item.progress === 'later')) actions.append(this.operation(item.progress === 'later' ? '移回未读' : '稍后读', async () => {
      const draft = this.drafts.get(`${library.root}:${key}`);
      if (draft) throw new Error('这份材料有未保存的进度，请先在详情中保存');
      await library.updateProgress(item.id, item.version, item.progress === 'later' ? 'unread' : 'later', item.position);
    }, '阅读进度已保存', 'sw-text-button'));
    if (this.page === 'library') actions.append(this.readingFilter === 'trash'
      ? this.operation('恢复材料', async () => `已恢复 ${await library.restoreItems([item.id])} 篇材料`, '', 'sw-text-button')
      : button('删除材料', () => { this.confirmingTrash = [item.id]; this.render(); }, 'sw-text-button'));
    actions.append(button(this.page === 'knowledge' ? '查看进度与讨论' : '查看详情', choose, 'sw-text-button')); card.append(actions);
    return card;
  }

  private renderDetail(detail: HTMLElement, item: ReadingItem, library: ReadingLibrary, close: () => void) {
    const key = itemKey(item), draftKey = `${library.root}:${key}`, video = isVideoLink(item), status = this.knowledge.get(key);
    detail.dataset.itemKey=key;
    const top = el('div', 'sw-detail-top'); top.append(el('span', 'sw-section-label', '材料详情'), button('返回列表', close, 'sw-text-button')); detail.append(top);
    detail.append(el('h2', '', item.title), el('p', 'sw-detail-source', `${item.source} · ${video ? '视频链接' : coverageLabels[item.coverage]}`));
    if (this.page === 'library' && this.readingFilter === 'trash') {
      detail.append(el('p', 'sw-muted', '已移入回收站，全部版本、正文批注和原件保留；恢复后可继续阅读。'), this.operation('恢复这篇材料', async () => `已恢复 ${await library.restoreItems([item.id])} 篇材料`));
      return;
    }
    if (item.position) detail.append(el('p', 'sw-last-position', `上次读到 · ${item.position}`));
    if (video && item.url) detail.append(button('打开原视频 ↗', () => this.host.openOriginal(item.url!), 'sw-button sw-primary sw-full'));
    else detail.append(this.operation('打开正文笔记 ↗', () => this.host.openFile(item.path), '', 'sw-button sw-primary sw-full'));
    if(!video&&isVideoMaterial(item)&&item.url)detail.append(button('观看原视频 ↗',()=>this.host.openOriginal(item.url!),'sw-button sw-full'));
    const reading = el('section', 'sw-detail-section'); reading.append(el('h3', '', '阅读进度'));
    const draft = this.drafts.get(draftKey), progress = select('阅读状态', Object.entries(progressLabels), draft?.progress ?? item.progress);
    const position = el('input', 'sw-input'); position.placeholder = '读到哪个标题、段落或页码'; position.setAttribute('aria-label', '阅读位置'); position.maxLength = 1000; position.value = draft?.position ?? item.position;
    const savedLabel = el('small', 'sw-draft-label', draft ? '有未保存的修改' : '');
    const remember = () => { if(progress.value===item.progress&&position.value===item.position){this.drafts.delete(draftKey);savedLabel.textContent='阅读进度已保存';}else{this.drafts.set(draftKey, { progress: progress.value as ReadingItem['progress'], position: position.value }); savedLabel.textContent = '有未保存的修改';} };
    progress.addEventListener('change', remember); position.addEventListener('input', remember);
    reading.append(progress, position, savedLabel, this.operation('保存进度', async () => {
      const savedDraft = { progress: progress.value as ReadingItem['progress'], position: position.value };
      await library.updateProgress(item.id, item.version, savedDraft.progress, savedDraft.position);
      const current = this.drafts.get(draftKey);
      if (current?.progress === savedDraft.progress && current?.position === savedDraft.position) this.drafts.delete(draftKey);
    }, '阅读进度已保存', 'sw-button sw-full')); detail.append(reading);
    const knowledge = el('section', 'sw-detail-section'); knowledge.append(el('h3', '', '交给 Claudian 深读'), el('p', 'sw-knowledge-label', status?.label ?? '可选入知识流程，先准备讨论底稿'));
    if (status?.issue) knowledge.append(el('p', 'sw-alert', status.issue));
    if (this.host.handoffKnowledge && !video && item.coverage !== 'metadata') {
      const node = this.operation(status?.receipt?.conversationId ? '继续 Claudian 讨论' : '交给 Claudian 处理', () => this.host.handoffKnowledge!(item, library), '', 'sw-button sw-full');
      node.disabled ||= !!this.host.claudianReason; knowledge.append(node);
      const complete=status?.label.startsWith('Wiki 已归纳')||status?.label==='fanOS 已晋升';
      if(!complete){const direct=this.operation('直接写入 Wiki（不讨论）',()=>this.host.handoffKnowledge!(item,library,'direct-wiki'),'','sw-button sw-full');direct.disabled ||= !!this.host.claudianReason||!!status?.issue||!!status?.receipt?.wikiSubmittedAt;knowledge.append(direct);}
    }
    if (video && item.url && this.host.handoffVideo) {
      const node = this.operation('取得文字稿并交给 Claudian', () => this.host.handoffVideo!(item, library), '', 'sw-button sw-full'); node.disabled ||= !!this.host.claudianReason; knowledge.append(node);
      const direct=this.operation('取得文字稿并直接写入 Wiki',()=>this.host.handoffVideo!(item,library,'direct-wiki'),'','sw-button sw-full');direct.disabled ||= !!this.host.claudianReason;knowledge.append(direct);
      knowledge.append(el('p', 'sw-muted', '需要公开字幕；平台受限时，可以用“添加材料”导入自己的 SRT / VTT 文件。'));
    }
    if (this.host.claudianReason) knowledge.append(el('p', 'sw-gap', this.host.claudianReason));
    if (status?.receipt && knowledgePending(status.receipt) && this.host.cancelKnowledge) knowledge.append(this.operation('取消待处理', () => this.host.cancelKnowledge!(item, library), '', 'sw-button sw-full'));
    if (item.kind === 'pdf' && this.host.attachPdfText) knowledge.append(this.operation('补充 PDF 的 Markdown 转换稿', () => this.host.attachPdfText!(item, library), '', 'sw-button sw-full'));
    knowledge.append(el('p', 'sw-muted', '可先讨论后归纳，或直接根据原文客观整理并写入 Wiki。直接写入无需讨论，也不会加入你的个人观点。')); detail.append(knowledge);
    const outputs = (status?.outputs ?? []).filter(path => /^08_LLM Wiki\/wiki\//.test(path) || path.startsWith('01_帆OS/'));
    if (outputs.length && this.host.openKnowledgeFile) {
      const section = el('section', 'sw-detail-section'); section.append(el('h3', '', '已保存的知识'));
      for (const path of outputs) section.append(this.operation(`${path.startsWith('01_帆OS/') ? '查看晋升结果' : '阅读 Wiki'} · ${path.split('/').at(-1)!.replace(/\.md$/i, '')}`, () => this.host.openKnowledgeFile!(path), '', 'sw-button sw-full'));
      detail.append(section);
    }
    const provenance = this.details('原文、原件与覆盖说明', `source:${draftKey}`);
    if (item.url) provenance.append(button(video ? '查看原视频 ↗' : '查看原文 ↗', () => this.host.openOriginal(item.url!), 'sw-button sw-full'));
    if (video) provenance.append(this.operation('打开链接笔记 ↗', () => this.host.openFile(item.path), '', 'sw-button sw-full'));
    if (item.originalPath) provenance.append(this.operation('打开来源原件', () => this.host.openFile(item.originalPath!), '', 'sw-button sw-full'));
    if (video && item.url && this.host.collectTranscript) provenance.append(this.operation('取得视频文字稿', () => this.host.collectTranscript!(item.url!, item.topic, library), '', 'sw-button sw-full'));
    const review = this.dailyPlan.picks.find(p => itemKey(p.item) === key)?.review;
    if (review) provenance.append(el('p', '', `导读依据 · ${review.quote}`));
    for (const gap of item.gaps) provenance.append(el('p', 'sw-gap', gap));
    provenance.append(el('small', 'sw-muted', `本地收录于 ${new Date(item.capturedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)); detail.append(provenance);
    for (const conflict of this.conflicts.filter(c => c.includes(item.path))) detail.append(el('p', 'sw-alert', conflict));
    const recovery = this.details('接续记录与恢复', `recovery:${draftKey}`);
    if (status?.receipt) recovery.append(this.operation('打开接续笔记', () => this.host.openFile(status.receipt!.taskPath), '', 'sw-button sw-full'));
    if (status?.runId && !status.issue && this.host.recoverKnowledge) {
      recovery.append(el('p', 'sw-muted', '原会话丢失或无法继续时，从已核对的回执恢复。'));
      const node = this.operation('原会话无法继续：从回执恢复', () => this.host.recoverKnowledge!(item, library), '', 'sw-button sw-full'); node.disabled ||= !!this.host.claudianReason; recovery.append(node);
    }
    if (this.host.openKnowledgeFile) for (const path of (status?.outputs ?? []).filter(p => /^08_LLM Wiki\/sources\//.test(p) || /^08_LLM Wiki\/logs\/(receipts\/|讨论)/.test(p))) {
      recovery.append(this.operation(path.startsWith('08_LLM Wiki/sources/') ? '查看来源与覆盖' : '打开讨论记录', () => this.host.openKnowledgeFile!(path), '', 'sw-button sw-full'));
    }
    if (!video && item.coverage !== 'metadata') recovery.append(this.operation('准备 RAW 交接材料', async () => {
      const path = await library.prepareRaw(item); if (this.host.library === library) await this.host.openFile(path); return `交接材料已准备于 ${library.root}，尚未登记 RAW`;
    }, '', 'sw-button sw-full'));
    if (recovery.children.length > 1) detail.append(recovery);
  }

  private renderSources(main: HTMLElement) {
    const summary = el('section', 'sw-daily-summary'); summary.append(el('strong', '', this.host.subscriptionSummary || '尚未连接采集状态'), el('p', 'sw-muted', '订阅开关点击即保存。关闭后停止抓取，已收录材料和阅读进度保留；以后可以重新开启。检查间隔和分类可在“管理订阅与分类”中调整。'));
    if (this.host.collectionStatusUrl) summary.append(button('查看公众号采集状态 ↗', () => this.host.openOriginal(this.host.collectionStatusUrl!)));
    main.append(summary);
    main.append(el('p','sw-muted','这里是来源分组，用于管理账号；同一来源的每篇文章可以讨论不同主题。'));
    if(this.host.collectionScope==='today')main.append(el('p','sw-muted',this.host.catchupDays ? `收录北京时间当天更新，并补收前 ${this.host.catchupDays} 天仍在订阅里的遗漏文章；补收内容按原发布日期归档。` : '固定订阅只收录北京时间当天发布的内容；旧内容按日期保存在历史页，也可跨日期检索。'));
    for (const category of this.categories()) {
      const sources = this.host.sources.filter(source => (source.categoryId ?? 'headlines') === category.id);
      if (!sources.length) continue;
      const section = el('section', 'sw-source-group'); section.append(el('h2', '', `${category.name} · ${sources.length}`));
      for (const source of sources) {
        const row = el('div', 'sw-source-row'), text = el('div'), controls = el('div', 'sw-source-actions');
        row.dataset.sourceId = source.registry_id;
        text.append(el('strong', '', source.display_name), el('p', 'sw-muted', `${({ wechat: '微信公众号', youtube: 'YouTube', bilibili: 'B站', rss: 'RSS / Atom' } as Record<string, string>)[source.platform ?? ''] ?? '来源'} · ${source.subscriptionStatus ?? '采集状态尚未连接'}`));
        if (source.lastFailure || source.recentChecks?.length) {
          const history = disclosure('最近检查记录', 'sw-collection-history');
          if (source.lastFailure) history.append(el('p', 'sw-muted', `最近失败 · ${new Date(source.lastFailure.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · ${source.lastFailure.message}`));
          for (const check of [...(source.recentChecks ?? [])].reverse()) history.append(el('p', 'sw-muted', `${new Date(check.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · ${check.status === 'ok' ? '检查成功' : check.status === 'waiting' ? '分批继续采集' : '检查失败'}${check.message ? ` · ${check.message}` : ''}`));
          text.append(history);
        }
        if (this.host.setSubscriptionEnabled && source.registry_id && source.enabled !== undefined) {
          const enabled = source.enabled, id = source.registry_id;
          const toggle = this.operation(enabled ? '订阅中' : '已关闭', () => this.host.setSubscriptionEnabled!(id, !enabled), '', `sw-button sw-subscription-toggle ${enabled ? 'is-enabled' : ''}`);
          toggle.dataset.focusKey = `subscription:${id}`;
          toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(enabled)); toggle.setAttribute('aria-label', `${source.display_name}订阅开关`);
          toggle.title = enabled ? '点击关闭订阅，停止抓取' : '点击重新开启订阅'; controls.append(toggle);
        }
        controls.append(button('看已收录更新', () => { this.go('updates');const id=source.registry_id??'',day=archiveDays(this.items,this.host.sources,this.host.collectionStartedAt).find(day=>updatesForDay(this.items,this.host.sources,day).some(item=>updateSourceId(item,this.host.sources)===id))??beijingDate();this.updateDate=day;this.followingToday=day===beijingDate();this.source=id;this.updateFilter='all';this.renderedSnapshot='';void this.refresh();})); row.append(text, controls); section.append(row);
      }
      main.append(section);
    }
    if (!this.host.sources.length) main.append(el('p', 'sw-empty', '还没有关注来源。添加公众号或其他 RSS/Atom、YouTube 频道主页或 B站 UP 主页即可开始。'));
  }

  private renderExploration(main: HTMLElement) {
    const today=beijingDate(),dated=this.exploration.filter(item=>item.run.date===this.explorationDate),day=this.explorationDays.find(day=>day.date===this.explorationDate);
    const dates=[...new Set([today,...this.explorationDays.map(day=>day.date),...this.exploration.map(item=>item.run.date)])].filter(validDay).filter(date=>date<=today).sort().reverse(),min=dates.at(-1)??today;
    const choose=(date:string)=>{if(!validDay(date)||date<min||date>today)return;this.explorationDate=date;this.followingExploreToday=date===today;this.explorationCalendar.open=false;this.explorationSection='';this.renderedSnapshot='';this.render();this.root.scrollTop=0;this.root.querySelector<HTMLButtonElement>('[data-focus-key="calendar:推荐日期"]')?.focus({preventScroll:true});};
    const datesPanel=el('section','sw-date-pages');datesPanel.setAttribute('aria-label','按日期查看推荐');const bar=el('div','sw-date-bar'),title=el('div');title.append(el('small','sw-date-year',`${this.explorationDate.slice(0,4)} 年 · 推荐生成日期`),el('h2','',dateTitle(this.explorationDate,today)),el('p','sw-muted',`${dated.length} 项已保存推荐 · 原内容发布日期在卡片内单独标明`));
    bar.append(title,dateCalendar({date:this.explorationDate,today,min,label:'推荐日期',state:this.explorationCalendar,counts:new Map(dates.map(date=>[date,this.exploration.filter(item=>item.run.date===date).length])),choose}));datesPanel.append(bar);
    const dateActions=el('div','sw-date-links'),previous=button('前一天',()=>choose(shiftDay(this.explorationDate,-1))),next=button('后一天',()=>choose(shiftDay(this.explorationDate,1)));previous.disabled=this.explorationDate<=min;next.disabled=this.explorationDate>=today;dateActions.append(previous,next);if(this.explorationDate!==today)dateActions.append(button('回到今天',()=>choose(today),'sw-button sw-primary'));datesPanel.append(dateActions);main.append(datesPanel);
    const summary = el('section', 'sw-daily-summary');
    const stateLabel=this.readWarning?'暂时无法核对推荐记录':day?.status==='failed'?'这一天的探索未完成':day?.status==='started'?'这一天已有探索请求，结果尚未确认':day?.status==='completed'?`这一天的探索已完成 · ${dated.length} 项推荐`:'这一天尚未生成推荐';
    summary.append(el('strong', '',stateLabel),el('p','sw-muted',this.explorationDate===today?`每天目标 1–${this.host.explorationLimit ?? 3} 条。综合网页、可选 X 和近期未读订阅一起筛选；缺额时显示具体原因。`:'历史推荐保留在这一天；新的发现会归到今天。'));
    if (day?.summary) summary.append(el('p', 'sw-muted', day.summary));
    if (this.host.autoExplorationEnabled === false) {
      summary.append(el('p', 'sw-gap', '每日自动推荐尚未开启；同步订阅不会自动生成探索推荐。'));
      if (this.host.enableDailyRecommendations) summary.append(this.operation('开启每日推荐（1–3条）', () => this.host.enableDailyRecommendations!()));
    } else if (this.host.autoExplorationEnabled) summary.append(el('p', 'sw-muted', '每日自动推荐已开启 · Obsidian 运行时检查，恢复后补查当天'));
    if(day?.error)summary.append(el('p','sw-gap',day.error));if(day?.warnings.length){const warnings=this.details(`本次检索的 ${day.warnings.length} 条说明`,`explore-warnings:${this.explorationDate}`);for(const warning of day.warnings)warnings.append(el('p','sw-muted',warning));summary.append(warnings);}
    if(this.explorationDate===today&&this.host.explorationSummary)summary.append(el('p','sw-muted',this.host.explorationSummary));
    if(day?.path)summary.append(this.operation('打开这一天的推荐笔记',()=>this.host.openFile(day.path!)));
    const retry=this.host.explorationActionLabel?.startsWith('重试保存');
    if (this.explorationDate === today && day?.status === 'failed' && day.error === '探索预览评价缺少实际内容入口' && this.host.recoverExploration) summary.append(this.operation('重新校验首次结果（不调用模型）', () => this.host.recoverExploration!()));
    if (this.host.exploreNow&&this.explorationDate===today&&(!day||day.status==='started'||retry)){const action=this.operation(retry?this.host.explorationActionLabel!:day?.status==='started'?'检查已保存结果':'发现新内容', () => this.host.exploreNow!(), '', 'sw-button sw-primary');if(!day&&!retry&&this.host.guideConfigured===false){action.disabled=true;action.title='请先配置探索使用的模型连接';summary.append(el('p','sw-muted','探索模型尚未配置，请在兴趣与发现设置中完成连接。'));}summary.append(action);}
    summary.append(button('调整兴趣与发现设置', () => this.host.configure('exploration')));
    if (this.host.xSummary) summary.append(el('p', 'sw-x-budget', this.host.xSummary)); main.append(summary);
    const configured = this.host.explorationTopics ?? discoveryTopics.map(topic => topic.id), shown = discoveryTopics.filter(topic => configured.includes(topic.id) || dated.some(item => item.entry.section === topic.id));
    if (this.explorationSection && this.explorationSection !== 'legacy' && !shown.some(t => t.id === this.explorationSection)) this.explorationSection = '';
    const entries: [string, string, number][] = [['', '全部', dated.length], ...shown.map(t => [t.id, t.name, dated.filter(i => i.entry.section === t.id).length] as [string, string, number])];
    if (dated.some(i => !i.entry.section)) entries.push(['legacy', '历史未归类', dated.filter(i => !i.entry.section).length]);
    main.append(this.tabs(entries, this.explorationSection, value => { this.explorationSection = value; this.render(); }, '发现板块筛选'));
    const list = el('section', 'sw-exploration-list'); main.append(list);
    const visible = dated.filter(i => !this.explorationSection || (this.explorationSection === 'legacy' ? !i.entry.section : i.entry.section === this.explorationSection));
    if (!visible.length) { const empty = el('div', 'sw-empty'); empty.append(el('h2', '',this.readWarning?'暂时无法读取推荐记录':this.explorationSection?'这个板块没有已保存推荐':day?.status==='failed'?'这一天的探索失败':day?.status==='started'?'探索结果尚未确认':day?.status==='completed'?'这一天没有入选推荐':'这一天尚未生成推荐'),el('p','',this.readWarning?'请核对阅读目录或恢复记录，已保存文件不会被自动删除。':this.explorationSection?'可以切回全部板块查看。':'通过日历查看其他日期，或回到今天发现新内容。'));if(this.explorationSection)empty.append(button('查看全部板块',()=>{this.explorationSection='';this.render();}));list.append(empty); }
    for (const item of visible) list.append(this.explorationCard(item));
  }
  private explorationCard(item: ExplorationRecommendation) {
    const { candidate, entry, run } = item, card = el('article', 'sw-exploration-card');
    const library = this.host.library, url = canonicalIdentity(candidate.url);
    const saved = this.items.slice().reverse().find(value => canonicalIdentity(value.url ?? value.identity) === url);
    if (candidate.origin === 'subscription') card.append(el('p', 'sw-chip', '来自近期未读订阅'));
    card.append(el('div', 'sw-card-meta', `${topicName(entry.section)} · ${candidate.source} · ${run.date}`), el('h2', '', candidate.title), el('p', 'sw-exploration-reason', entry.reason));
    const dates={published:'原内容发布日期',submitted:'社区提交日期',updated:'仓库更新日期',unknown:'原内容发布日期未知'};card.append(el('p','sw-exploration-date',`${dates[candidate.dateKind]}${candidate.date?` · ${candidate.date}`:''}`));
    if (candidate.media) { const seconds = candidate.media.durationSeconds; card.append(el('p', 'sw-muted', `X 视频 · ${seconds === undefined ? '时长未知' : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`} · 尚未取得文字稿`)); }
    const controls = el('div', 'sw-card-actions');
    controls.append(button(candidate.media ? '打开X视频 ↗' : '打开原链接 ↗', () => this.host.openOriginal(candidate.url), 'sw-button sw-primary'));
    if (this.host.collectExploration) controls.append(this.operation(candidate.origin === 'subscription' ? '阅读已保存正文' : candidate.url.match(/^https?:\/\/(www\.)?(x\.com|twitter\.com)\//) ? '收录帖文' : '收录正文', () => this.host.collectExploration!(item)));
    if (saved) {
      controls.append(el('span', 'sw-chip', progressLabels[saved.progress]));
      if (saved.progress !== 'done') controls.append(this.operation('标记已读', async () => {
        this.assertSavedFor([saved.id], library);
        const count = await library.updateManyProgress([saved.id], 'done');
        if (!count) throw new Error('这篇材料已移出阅读列表，请刷新后核对');
      }, '已标记已读'));
    }
    const more = this.details('推荐依据与更多操作', `explore:${candidate.id}`);
    const dateLabels = { published: '提供方所标发布日期', submitted: '社区提交时间', updated: '仓库更新时间', unknown: '日期未知' };
    more.append(el('p', 'sw-muted', `${entry.assessment?'推荐价值':'历史 AI 评分'} ${entry.score} · ${dateLabels[candidate.dateKind]}${candidate.date ? ` ${candidate.date}` : ''}`));
    if(entry.assessment)more.append(el('p','sw-muted',discoveryCoverageLabel(entry.assessment)));
    more.append(el('blockquote', '', candidate.evidence[entry.quoteIndex] ?? ''), el('p', 'sw-gap', `证据缺口 · ${entry.uncertainty || '仅检索摘选，尚未阅读全文'}`));
    if(candidate.linkedEvidence)more.append(el('p','sw-muted',`已补读外链摘选：${candidate.linkedEvidence.url}；未取得全文或视频文字稿`));
    if (entry.timeliness) more.append(el('p', 'sw-muted', `近期关注理由 · ${entry.timeliness}`));
    if (candidate.engagement) { const c = candidate.engagement; more.append(el('p', 'sw-muted', `X 观测 · ${c.likes} 赞 · ${c.reposts} 转发 · ${c.replies} 回复${c.views === undefined ? '' : ` · ${c.views} 浏览`} · ${new Date(c.observedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)); }
    if (entry.role === 'original') more.append(el('p', 'sw-muted', /AI.{0,8}(克隆|翻译)|克隆声线/i.test(entry.uncertainty + ' ' + candidate.excerpt) ? '加工版本线索，原始录制需核对' : '原始作品线索，身份与完整性以原页为准'));
    if (this.host.handoffExploration) { const node = this.operation('交给 Claudian 处理', () => this.host.handoffExploration!(item)); node.disabled ||= !!this.host.claudianReason; more.append(node);const direct=this.operation('直接写入 Wiki（不讨论）',()=>this.host.handoffExploration!(item,'direct-wiki'));direct.disabled ||= !!this.host.claudianReason;more.append(direct); if (this.host.claudianReason) more.append(el('p', 'sw-gap', this.host.claudianReason)); }
    const links = new Map<string, string>();
    if (candidate.evidenceUrl && candidate.evidenceUrl !== candidate.url) links.set(candidate.evidenceUrl, '打开节目介绍与讨论 ↗');
    for (const link of candidate.contentLinks ?? []) if (link.url !== candidate.url) links.set(link.url, `${link.label} ↗`);
    if (entry.event) for (const other of run.entries.filter(e => e.id !== entry.id && e.event === entry.event).slice(0, 3)) { const related = run.search?.candidates.find(c => c.id === other.id); if (related && related.url !== candidate.url) links.set(related.url, related.title); }
    for (const [url, label] of links) more.append(button(label, () => this.host.openOriginal(url)));
    if (run.path) more.append(this.operation('推荐笔记', () => this.host.openFile(run.path!)));
    if (this.host.dismissExploration) more.append(this.operation('不再推荐', () => this.host.dismissExploration!(candidate.id), '已移出推荐'));
    card.append(controls, more); return card;
  }
}
