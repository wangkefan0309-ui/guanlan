import { canonicalIdentity, checkReadingPath, coverageLabels, decodeBase64, escapeLine, feedSchema, hash, itemSchema, materialSchema, materialVersion, readingRoot, safeLink, stateSchema, topicLabels } from './model';
import type { FileStore, LibraryState, Material, ReadingItem } from './model';
import { beijingDate, makeDailyPlan, itemKey, type DailyOptions, type ReviewReceipt, type ReviewResponse } from './daily';
import { reviewReceiptSchema, reviewRequestSchema, reviewResponseSchema } from './daily-model';
import { historyCandidates, selectHistoryDay, type HistoryOptions, type HistoryArchive } from './history';
import { publicationItems } from './subscription-days';
export { estimateMinutes } from './daily';

export class ReadingLibrary {
  private queue: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;
  get busy(){return this.pendingOperations>0;}
  private state: LibraryState | null = null;
  readonly root: string;
  constructor(private files: FileStore, root: string, private now = () => new Date().toISOString()) { this.root = readingRoot(root); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    this.pendingOperations++;const result = this.queue.then(work).finally(()=>{this.pendingOperations--;}); this.queue = result.catch(() => {}); return result;
  }
  private async load(): Promise<LibraryState> {
    if (this.state) return this.state;
    const contents = await this.files.read(`${this.root}/_工作台/state.json`);
    const candidate = stateSchema.parse(contents === null ? { schema: 1, items: [] } : JSON.parse(contents));
    // Persisted paths must remain inside this library, including after a manual state edit.
    for (const item of [...candidate.items, ...candidate.trash.map(entry => entry.item)]) for (const path of [item.path, item.originalPath].filter(Boolean) as string[]) checkReadingPath(this.root, path);
    for (const dialogue of candidate.dialogues) checkReadingPath(this.root, dialogue.path);
    for (const receipt of candidate.reviews) if (receipt.path) checkReadingPath(this.root, receipt.path);
    this.state = candidate; return candidate;
  }
  private async commit(next: LibraryState): Promise<void> {
    await this.files.write(`${this.root}/_工作台/state.json`, JSON.stringify(next, null, 2)); this.state = next;
  }
  async list(): Promise<ReadingItem[]> { return this.serial(async () => structuredClone((await this.load()).items)); }
  async listTrash() { return this.serial(async () => structuredClone((await this.load()).trash)); }
  /** Save only references; reading files, annotations and progress are never rewritten. */
  historyHighlights(options: HistoryOptions = {}): Promise<HistoryArchive> {
    const captured = structuredClone(options), now = this.now(), date = beijingDate(new Date(now));
    return this.serial(async () => {
      let state = await this.load();
      const items = publicationItems(state.items, captured.sources ?? []);
      if (!state.historyDays.some(day => day.date === date)) {
        const day = selectHistoryDay(items, state.historyDays, state.reviews, captured, now);
        // An empty library can receive real history later today; don't freeze an empty day.
        if (day.picks.length) { await this.commit({ ...state, historyDays: [...state.historyDays, day] }); state = await this.load(); }
      }
      const candidates = historyCandidates(items, date), exposed = new Set(state.historyDays.flatMap(day => day.picks.map(pick => pick.id)));
      return structuredClone({ date, days: state.historyDays, remainingCount: candidates.length, rotatedCount: candidates.filter(item => exposed.has(item.id)).length });
    });
  }
  historyUrls(date = beijingDate(new Date(this.now()))): Promise<string[]> {
    return this.serial(async () => {
      const state = await this.load(), keys = new Set(state.historyDays.find(day => day.date === date)?.picks.map(pick => `${pick.id}:${pick.version}`) ?? []);
      return state.items.filter(item => keys.has(itemKey(item))).flatMap(item => item.url ? [item.url] : []);
    });
  }
  /** Reversible removal of an article and all its versions. Files and downstream evidence stay intact. */
  trashItems(ids: string[]): Promise<number> {
    const captured = new Set(ids);
    return this.serial(async () => {
      const state = await this.load(), removed = state.items.filter(item => captured.has(item.id));
      if (!removed.length) return 0;
      const deletedAt = this.now();
      await this.commit({ ...state, items: state.items.filter(item => !captured.has(item.id)), trash: [...state.trash, ...removed.map(item => ({ item, deletedAt }))] });
      return new Set(removed.map(item => item.id)).size;
    });
  }
  restoreItems(ids: string[]): Promise<number> {
    const captured = new Set(ids);
    return this.serial(async () => {
      const state = await this.load(), restored = state.trash.filter(entry => captured.has(entry.item.id));
      if (!restored.length) return 0;
      // Restore the exact saved metadata, progress, paths and version order, never rewrite user files.
      if (restored.some(entry => state.items.some(item => item.id === entry.item.id))) throw new Error('材料与回收站身份冲突，已保留原状态');
      await this.commit({ ...state, items: [...state.items, ...restored.map(entry => entry.item)], trash: state.trash.filter(entry => !captured.has(entry.item.id)) });
      return new Set(restored.map(entry => entry.item.id)).size;
    });
  }
  updateManyProgress(ids: string[], progress: ReadingItem['progress']): Promise<number> {
    const captured = new Set(ids);
    return this.serial(async () => {
      if (!['unread', 'later', 'reading', 'done'].includes(progress)) throw new Error('阅读进度无效');
      const state = await this.load();
      const selected = state.items.filter(item => captured.has(item.id));
      if (selected.length) await this.commit({ ...state, items: state.items.map(item => captured.has(item.id) ? { ...item, progress } : item) });
      return new Set(selected.map(item => item.id)).size;
    });
  }
  async conflicts(): Promise<string[]> { return this.serial(async () => [...(await this.load()).conflicts]); }
  async checkpoint(): Promise<{ instance: string; cursor: number }> {
    return this.serial(async () => { const state = await this.load(); return { instance: state.feedInstance, cursor: state.cursor }; });
  }
  import(input: unknown): Promise<ReadingItem> { return this.serial(() => this.importOne(materialSchema.parse(input))); }
  attachPdfMarkdown(id:string,version:string,body:string):Promise<ReadingItem> {
    return this.serial(async()=>{
      const saved=(await this.load()).items.find(item=>item.id===id&&item.version===version);
      if(!saved||saved.kind!=='pdf'||!saved.originalPath)throw new Error('请选择已保存原件的 PDF');
      if(!body.trim()||body.length>1_500_000)throw new Error('转换稿为空或超过大小限制');
      await this.verifyOriginal(saved);const bytes=(await this.files.readBinary(saved.originalPath))!;
      const {id:_id,version:_version,path:_path,originalPath:_original,originalHash:_hash,progress:_progress,position:_position,savedAt:_saved,...material}=saved;
      return this.importOne(materialSchema.parse({...material,body,coverage:'partial',guide:'',guideKind:'none',gaps:['用户提供的 PDF 转换稿；页码、图片、表格及完整性需对照原 PDF 核验。',...saved.gaps.map(gap=>`原 PDF 提取记录：${gap}`)].slice(0,40),original:{extension:'pdf',base64:Buffer.from(bytes).toString('base64')}}));
    });
  }
  private async ensureText(path: string, contents: string): Promise<void> {
    const existing = await this.files.read(path);
    if (existing !== null && existing !== contents) throw new Error(`文件已被修改，已保留原内容：${path}`);
    if (existing === null) await this.files.write(path, contents, null);
  }
  private async verifyOriginal(item: ReadingItem): Promise<string | undefined> {
    if (!item.originalPath) return undefined;
    const bytes = await this.files.readBinary(item.originalPath);
    if (!bytes) throw new Error(`来源原件缺失，请从备份恢复：${item.originalPath}`);
    const digest = await hash(bytes);
    if (item.originalHash && digest !== item.originalHash) throw new Error(`原件已被修改，已保留：${item.originalPath}`);
    if (!item.originalHash && (item.kind === 'pdf' || item.coverage === 'metadata')) {
      const {id:_id,version:_version,path:_path,originalPath:_pathOriginal,originalHash:_hash,progress:_progress,position:_position,savedAt:_saved,...contents}=item;
      const original:Material['original']={extension:item.kind==='pdf'?'pdf':item.kind==='markdown'?'md':'html',base64:''};
      if(await materialVersion({...contents,original},bytes,true)!==item.version && await materialVersion({...contents,original},bytes)!==item.version) throw new Error(`原件已被修改，已保留：${item.originalPath}`);
    }
    return digest;
  }
  private async importOne(material: Material, preserveAnnotations = false): Promise<ReadingItem> {
    let state = await this.load();
    const identity = canonicalIdentity(material.identity);
    if (state.trash.some(entry => canonicalIdentity(entry.item.identity) === identity)) throw new Error('这篇材料已移入回收站，请先恢复后再导入');
    const alias = state.items.find(item => canonicalIdentity(item.identity) === identity);
    const defaultManual = material.kind === 'article' ? identity.startsWith('local:html:') : identity === `local:${material.kind}:${material.title}`;
    const oldManual = defaultManual ? state.items.filter(item => item.kind === material.kind && item.title === material.title && item.source === material.source && (new RegExp(`^${material.kind}:.+:[a-f0-9]{64}$`).test(item.identity) || (material.kind==='article' && item.identity===`html:${material.title}:${material.source}`))) : [];
    const id = alias?.id ?? oldManual[0]?.id ?? await hash(identity);
    if (oldManual.length) {
      const oldIds = new Set(oldManual.map(item=>item.id));
      // Earlier manual versions had separate IDs. Associate the whole group, keeping all paths and progress.
      const next = { ...state, items:state.items.map(item=>oldManual.includes(item)?{...item,id,identity}:item),dialogues:state.dialogues.map(dialogue=>oldIds.has(dialogue.id)?{...dialogue,id}:dialogue) };
      await this.commit(next);state=next;
    }
    const originalBytes = material.original ? decodeBase64(material.original.base64) : null;
    const version = await materialVersion(material, originalBytes ?? undefined);
    const key = `${id.slice(0, 20)}-${version.slice(0, 20)}`;
    // Upgrade 0.1.0 indexes without moving their files or losing reading positions.
    const legacyVersion = await materialVersion(material, originalBytes ?? undefined, true);
    const previous = state.items.find(item => item.id === id && (item.version === version || (item.version === legacyVersion && item.publishedAt === material.publishedAt)));
    const path = `${this.root}/阅读材料/${key}.md`;
    const originalPath = material.original ? `${this.root}/原件/${key}.${material.original.extension}` : undefined;
    if (previous) {
      const originalHash = await this.verifyOriginal(previous);
      // A refetch may change tracking scripts in HTML. Reuse the first captured original of this text version.
      const note = await this.files.read(previous.path);
      if (note === null) await this.ensureText(previous.path, renderMaterial(previous));
      else if (note !== renderMaterial(previous)) {
        const conflict = `文件已被修改，已保留原内容：${previous.path}`;
        if (!preserveAnnotations) throw new Error(conflict);
        if (!state.conflicts.includes(conflict)) await this.commit({ ...state, conflicts: [...state.conflicts, conflict] });
      }
      if (!previous.originalHash && originalHash) {
        const current = await this.load(); const upgraded = { ...previous, originalHash, identity: material.identity };
        await this.commit({ ...current, items: current.items.map(item => item === previous ? upgraded : item) });
        return structuredClone(upgraded);
      }
      return structuredClone(previous);
    }
    const { original: _original, ...contents } = material;
    // Persist first-capture metadata before writing files. A failed final commit can then be retried.
    const preparedPath = `${this.root}/_工作台/待提交/${key}.json`;
    const prepared = await this.files.read(preparedPath);
    const recovery = prepared === null ? null : JSON.parse(prepared);
    const item = itemSchema.parse(recovery === null ? { ...contents, id, version, path, originalPath, originalHash: originalBytes ? await hash(originalBytes) : undefined, progress: 'unread', position: '', savedAt: this.now() } : recovery.item);
    if (item.id !== id || item.version !== version || item.path !== path || item.originalPath !== originalPath) throw new Error('导入恢复记录不匹配，请检查工作台状态');
    if (prepared === null) await this.ensureText(preparedPath, JSON.stringify({item,original:material.original}));
    if (originalPath && originalBytes) {
      const existing = await this.files.readBinary(originalPath);
      if (existing) {
        if (await hash(existing) !== item.originalHash) throw new Error(`原件已被修改，已保留：${originalPath}`);
      } else {
        const recovered = recovery?.original ? materialSchema.parse({...contents,original:recovery.original}).original! : material.original!;
        const bytes = recovery?.original ? decodeBase64(recovered.base64) : originalBytes;
        if (recovered.extension !== material.original?.extension || await hash(bytes) !== item.originalHash) throw new Error('原件恢复记录校验失败，请检查工作台状态');
        await this.files.writeBinary(originalPath, bytes);
      }
    }
    await this.ensureText(item.path, renderMaterial(item));
    await this.commit({ ...state, items: [...state.items, item] });
    await this.files.remove?.(preparedPath).catch(()=>{});
    return structuredClone(item);
  }
  sync(input: unknown): Promise<number> {
    return this.serial(async () => {
      const feed = feedSchema.parse(input); const state = await this.load();
      if (state.feedInstance === feed.instance && feed.cursor < state.cursor) throw new Error('同步游标倒退，已保留当前进度');
      for (const material of feed.items) {
        if ((await this.load()).trash.some(entry => canonicalIdentity(entry.item.identity) === canonicalIdentity(material.identity))) continue;
        await this.importOne(material, true);
      }
      await this.commit({ ...(await this.load()), feedInstance: feed.instance, cursor: feed.cursor });
      return feed.items.length;
    });
  }
  updateProgress(id: string, version: string, progress: ReadingItem['progress'], position = ''): Promise<void> {
    return this.serial(async () => {
      const state = await this.load(); const items = structuredClone(state.items);
      const item = items.find(item => item.id === id && item.version === version);
      if (!item) throw new Error('材料不存在');
      if (!['unread', 'later', 'reading', 'done'].includes(progress) || position.length > 1000) throw new Error('阅读进度无效');
      item.progress = progress; item.position = position; await this.commit({ ...state, items });
    });
  }
  reviews(): Promise<ReviewReceipt[]> { return this.serial(async () => structuredClone((await this.load()).reviews)); }
  beginReview(input: ReviewReceipt, dailyLimit: number): Promise<ReviewReceipt> {
    return this.serial(async () => {
      const receipt = reviewReceiptSchema.parse(input); const state = await this.load();
      const previous = state.reviews.find(entry => entry.fingerprint === receipt.fingerprint);
      if (previous?.status === 'completed') return structuredClone(previous);
      if (previous?.status === 'started') {
        const pending = await this.files.read(`${this.root}/_工作台/待提交/AI-${receipt.fingerprint}.json`);
        if (pending !== null) {
          const recovered = reviewReceiptSchema.parse(JSON.parse(pending));
          if (recovered.status !== 'completed' || recovered.path || JSON.stringify(reviewRequestSchema.parse(previous)) !== JSON.stringify(reviewRequestSchema.parse(recovered))) throw new Error('AI 导读恢复记录不匹配');
          return recovered;
        }
      }
      if (previous) throw new Error('这一批已发起过模型调用，结果可能已计费；不会重复发送。请核对提供方记录，或在候选/学习目标变化后生成新批次');
      if (receipt.status !== 'started' || receipt.entries.length || receipt.path || receipt.date !== beijingDate(new Date(this.now()))) throw new Error('AI 调用起始记录无效');
      if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 5 || state.reviews.filter(entry => entry.date === receipt.date).length >= dailyLimit) throw new Error('已达到今日 AI 批次上限；规则精选和已有导读仍可用');
      if (!receipt.keys.every(key => state.items.some(item => itemKey(item) === key && item.coverage !== 'metadata' && item.purpose === 'reading'))) throw new Error('AI 候选材料不存在或没有正文');
      await this.commit({ ...state, reviews: [...state.reviews, receipt] }); return structuredClone(receipt);
    });
  }
  failReview(fingerprint: string, error: string, input?: ReviewResponse): Promise<void> {
    return this.serial(async () => {
      const state = await this.load();
      const previous = state.reviews.find(receipt => receipt.fingerprint === fingerprint);
      if (!previous || previous.status === 'completed') throw new Error('失败回执没有匹配的调用记录');
      const response = input ? reviewResponseSchema.parse(input) : undefined;
      if (response) await this.ensureText(`${this.root}/_工作台/模型回执/AI-${previous.fingerprint}.json`, JSON.stringify({ validation: 'failed', request: reviewRequestSchema.parse(previous), response, error: error.slice(0, 500) }));
      await this.commit({ ...state, reviews: state.reviews.map(receipt => receipt.fingerprint === fingerprint ? { ...receipt, status: 'failed' as const, error: error.slice(0, 500), ...(response?.usage ? { usage: response.usage } : {}) } : receipt) });
    });
  }
  finishReview(input: ReviewReceipt): Promise<string> {
    return this.serial(async () => {
      const { path: _oldPath, ...receipt } = reviewReceiptSchema.parse(input); const state = await this.load();
      const previous = state.reviews.find(entry => entry.fingerprint === receipt.fingerprint);
      if (!previous || previous.status === 'failed' || receipt.status !== 'completed' || JSON.stringify(reviewRequestSchema.parse(previous)) !== JSON.stringify(reviewRequestSchema.parse(receipt))) throw new Error('AI 导读恢复记录不匹配');
      if (receipt.entries.length !== receipt.keys.length || new Set(receipt.entries.map(itemKey)).size !== receipt.keys.length || !receipt.entries.every(entry => receipt.keys.includes(itemKey(entry)))) throw new Error('AI 导读材料标识不匹配');
      for (const entry of receipt.entries) {
        const item = state.items.find(item => itemKey(item) === itemKey(entry));
        if (!item || entry.totalChars !== item.body.length || entry.sampledChars !== Math.min(2400, item.body.length) || !item.body.slice(0, entry.sampledChars).includes(entry.quote)) throw new Error('AI 导读来源证据不匹配');
      }
      const path = `${this.root}/AI导读/${receipt.fingerprint}.md`;
      const pendingPath = `${this.root}/_工作台/待提交/AI-${receipt.fingerprint}.json`;
      await this.ensureText(pendingPath, JSON.stringify(receipt));
      const contents = `---\nauthor: Silas\n---\n\n# AI 阅读选编\n\n模型 ${escapeLine(receipt.model)}；生成时间 ${receipt.createdAt}；提示版本 ${receipt.promptVersion}。\n\n${receipt.usage ? `提供方回执：输入 ${receipt.usage.inputTokens} tokens，输出 ${receipt.usage.outputTokens} tokens；金额按提供方账单核对。` : '提供方未返回 token 用量；费用待核对。'}\n\n${receipt.entries.map(entry => { const item = state.items.find(item => itemKey(item) === itemKey(entry))!; return `## ${escapeLine(item.title)}\n\n材料 [[${item.path}]] · ${entry.label} · 阅读价值 ${entry.score}/100\n\n推荐理由 ${escapeLine(entry.reason)}\n\n${escapeLine(entry.guide)}\n\n读取范围：前 ${entry.sampledChars} / ${entry.totalChars} 字符；来源覆盖 ${coverageLabels[item.coverage]}。${entry.sampledChars < entry.totalChars ? '只评估正文摘选。' : ''}\n\n原文证据 ${escapeLine(entry.quote)}`; }).join('\n\n')}\n`;
      await this.ensureText(path, contents);
      await this.commit({ ...state, reviews: state.reviews.map(entry => entry.fingerprint === receipt.fingerprint ? { ...receipt, path } : entry) }); await this.files.remove?.(pendingPath).catch(() => {}); return path;
    });
  }
  saveDaily(options: Partial<DailyOptions> = {}, contextHash = '', itemKeys?: readonly string[], grouping?:ReadonlyMap<string,Pick<ReadingItem,'topic'|'categoryId'|'categoryName'>>): Promise<string> {
    return this.serial(async () => {
      const state = await this.load(); const path = `${this.root}/今日阅读.md`;
      const existing = await this.files.read(path);
      const selected = itemKeys && new Set(itemKeys);
      const eligible=selected ? state.items.filter(item => selected.has(itemKey(item))) : state.items;
      const plan = makeDailyPlan(eligible.map(item=>({...item,...grouping?.get(itemKey(item))})), options, state.reviews, contextHash, new Date(this.now()));
      const contents = `---\nauthor: Silas\n---\n\n# 今日阅读 · ${plan.date}\n\n预算 ${plan.options.budgetMinutes} 分钟，最多 ${plan.options.maxItems} 项；已选 ${plan.picks.length} 项，约 ${plan.totalMinutes} 分钟。${plan.mode === 'rules' ? '规则精选；尚无当前配置的 AI 评分。' : '采用已保存的 AI 评价，未评估材料仍按规则选取。'}\n\n${plan.missingTopics.length ? `当前待读正文缺少 ${plan.missingTopics.join('、')}。\n\n` : ''}${plan.picks.map(({ item, minutes, reason, review, model }) => `- [[${item.path}|${escapeLine(item.title)}]] · ${topicLabels[item.topic]} · 约 ${minutes} 分钟${item.url ? ` · [原文](${safeLink(item.url)})` : ''}\n  推荐理由 ${escapeLine(reason)}\n  ${review ? `AI 导读（${escapeLine(model!)}；前 ${review.sampledChars}/${review.totalChars} 字符）${escapeLine(review.guide)}` : escapeLine(item.guide || coverageLabels[item.coverage])}`).join('\n\n') || '暂时没有预算内可选的待阅读正文；全部材料和视频更新仍可查看。'}\n\n视频链接在工作台“视频更新”中查看，观看耗时未知，不计入上述正文预算。\n`;
      const pendingPath=`${this.root}/_工作台/待提交/今日阅读.json`;
      const pending=await this.files.read(pendingPath);const recovery=pending===null?null:JSON.parse(pending);
      if (existing !== contents) {
        if (existing !== null && await hash(existing) !== state.dailyHash && !(recovery?.previousHash===state.dailyHash && recovery?.nextHash===await hash(existing))) throw new Error('今日阅读清单已被修改，已保留；工作台仍可直接阅读材料');
        await this.files.write(pendingPath,JSON.stringify({previousHash:state.dailyHash,nextHash:await hash(contents)}));
        await this.files.write(path, contents, existing);
      }
      await this.commit({ ...state, dailyHash: await hash(contents) });await this.files.remove?.(pendingPath).catch(()=>{});return path;
    });
  }
  dialogue(item: ReadingItem) {
    return this.serial(async()=>structuredClone((await this.load()).dialogues.find(entry=>entry.id===item.id&&entry.version===item.version)??null));
  }
  prepareRaw(item: ReadingItem): Promise<string> {
    return this.serial(async () => {
      const state = await this.load();
      const saved = state.items.find(entry => entry.id === item.id && entry.version === item.version);
      if (!saved) throw new Error('材料不存在');
      item = saved; await this.verifyOriginal(item);
      if (await this.files.read(item.path) === null) throw new Error('阅读材料缺失，请先恢复正文');
      const path = `${this.root}/交接材料/${item.id.slice(0, 20)}-${item.version.slice(0, 20)}.md`;
      await this.ensureText(path, `---\nauthor: Silas\n---\n\n# RAW 交接准备 · ${escapeLine(item.title)}\n\n状态为交接材料已准备，尚未登记 RAW。\n\n阅读材料 [[${item.path}]]\n\n${item.originalPath ? `来源原件 [[${item.originalPath}]]` : '尚无来源原件，正式登记前补齐来源证据。'}\n\n材料版本 ${item.version}\n\n覆盖范围 ${coverageLabels[item.coverage]}\n\n${item.gaps.map(gap => `- ${escapeLine(gap)}`).join('\n')}\n\n正式处理沿用 fanos-raw 的登记、讨论、归纳和晋升规则。\n`);
      return path;
    });
  }
}
export function renderMaterial(item: ReadingItem): string {
  return `---\nauthor: Silas\n---\n\n# ${escapeLine(item.title)}\n\n## 来源\n\n${escapeLine(item.source)}${item.url ? ` · [打开原文](${safeLink(item.url)})` : ''}\n\n${item.publishedAt ? `发布时间 ${escapeLine(item.publishedAt)}\n\n` : ''}采集时间 ${item.capturedAt}；${coverageLabels[item.coverage]}。\n\n${item.originalPath ? `原件 [[${item.originalPath}]]\n\n` : ''}${item.gaps.length ? `覆盖说明\n\n${item.gaps.map(gap => `- ${escapeLine(gap)}`).join('\n')}\n\n` : ''}${item.guide ? `## ${item.guideKind === 'ai' ? 'AI 导读' : '正文摘录提示'}\n\n${item.guide}\n\n` : ''}## 正文\n\n${item.body || '正文暂未取得，请打开原文阅读。'}\n`;
}
export function selectDaily(items: ReadingItem[], budget = 50): ReadingItem[] {
  return makeDailyPlan(items, { budgetMinutes: budget }).picks.map(pick => pick.item);
}
