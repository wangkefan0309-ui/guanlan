import { z } from 'zod';
import { readingRoot, webUrl } from './model';
import { dailyOptionsSchema, defaultLearningGoals } from './daily-model';
import { explorationProviders } from './exploration';
import { discoveryTopicIds, discoveryTopicsSchema, type DiscoveryTopic } from './discovery-topics';

const baseSettingsDefaults = { directory: '09_信息源', serviceUrl: 'http://127.0.0.1:27183', serviceToken: '', guideUrl: 'https://api.deepseek.com', guideModel: 'deepseek-flash', guideKey: '', dailyBudget: 50, dailyMaxItems: 3, learningGoals: defaultLearningGoals, dailyAiLimit: 1, autoDailyAi: false, autoSync: true, syncIntervalMinutes: 5, autoExplore: false, searchProvider: 'deepseek-web' as typeof explorationProviders[number], searchKey: '', searchQueries: '国内热点 国际热点 商业 投资 财经\n生活 认知 年轻人成长 科技 AI', explorationGoals: '关注国内外热点、商业、投资财经、生活、认知成长、科技与AI；优先近期值得阅读或观看的文章、完整播客和长视频，也关注X的有实质内容的热门帖。保留年轻人成长与AI时代机会，说明为什么值得关注及证据缺口。热点需区分原始报道、观点和传言；不把流量视为质量，不提供投资买卖建议。', discoveryTopics: [...discoveryTopicIds] as DiscoveryTopic[], explorationMaxItems: 3, xEnabled: true, xProvider: 'free' as 'free' | 'socialdata', socialDataKey: '' };
export const settingsDefaults={...baseSettingsDefaults,historyMaxItems:2,initializedDirectories:[] as string[],directoryApproved:false};
export type Settings = typeof settingsDefaults;
export function apiBase(value: string): string {
  const url = new URL(webUrl.parse(value.trim()));
  if (url.search || url.hash) throw new Error('API 基础地址不能包含查询参数或锚点');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('远程服务必须使用 HTTPS');
  return url.toString().replace(/\/+$/, '');
}
export function parseSettings(input: unknown): Settings {
  const values = z.object({ directory:z.string(),serviceUrl:z.string(),serviceToken:z.string().max(8192),guideUrl:z.string().default(settingsDefaults.guideUrl),guideModel:z.string().trim().max(240).default(settingsDefaults.guideModel),guideKey:z.string().max(8192).default(''),dailyBudget:z.number().int().min(5).max(180).default(50),dailyMaxItems:z.number().int().min(1).max(5).default(3),learningGoals:z.string().trim().min(1).max(2000).default(defaultLearningGoals),dailyAiLimit:z.number().int().min(1).max(5).default(1),autoDailyAi:z.boolean().default(false),autoSync:z.boolean().default(true),syncIntervalMinutes:z.number().int().min(1).max(60).default(5) }).parse(input);
  const exploration = z.object({ autoExplore: z.boolean().default(false), searchProvider: z.enum(explorationProviders).default(settingsDefaults.searchProvider), searchKey: z.string().max(8192).default(''), searchQueries: z.string().trim().min(2).max(500).default(settingsDefaults.searchQueries), explorationGoals: z.string().trim().min(1).max(2000).default(settingsDefaults.explorationGoals), discoveryTopics: discoveryTopicsSchema.default([...discoveryTopicIds]), explorationMaxItems: z.number().int().min(1).max(12).default(3), xEnabled: z.boolean().default(true), xProvider: z.enum(['free', 'socialdata']).default('free'), socialDataKey: z.string().max(8192).default('') }).parse(input);
  const queries = exploration.searchQueries.split('\n').map(value => value.trim()).filter(Boolean);
  const storage=z.object({initializedDirectories:z.array(z.string()).max(100).default([]),directoryApproved:z.boolean().default(false)}).parse(input);
  const history=z.object({historyMaxItems:z.number().int().min(1).max(5).default(2)}).parse(input);
  storage.initializedDirectories=[...new Set(storage.initializedDirectories.map(readingRoot))];
  if (!queries.length || queries.length > 2 || queries.some(value => value.length < 2 || value.length > 240)) throw new Error('探索关键词需要1～2行，每行2～240字符');
  return { ...values, ...exploration,...storage,...history, socialDataKey: exploration.socialDataKey.trim(), searchKey: exploration.searchKey.trim(), searchQueries: queries.join('\n'), directory:readingRoot(values.directory.trim()),serviceUrl:apiBase(values.serviceUrl),serviceToken:values.serviceToken.trim(),guideUrl:values.guideUrl.trim() ? apiBase(values.guideUrl) : '',guideKey:values.guideKey.trim() };
}
export function restoreSettings(input: unknown): { settings: Settings; repaired: boolean; migrated: boolean } {
  const settings = { ...settingsDefaults, discoveryTopics: [...settingsDefaults.discoveryTopics] }; let repaired = false;
  if (!input || typeof input !== 'object'||Array.isArray(input)){if(input!=null){settings.autoSync=false;settings.autoExplore=false;settings.autoDailyAi=false;}return { settings, repaired: input != null, migrated: false };}
  for (const key of Object.keys(settings) as (keyof Settings)[]) {
    const value = (input as Record<string,unknown>)[key];
    if (value === undefined) continue;
    try { Object.assign(settings, { [key]: parseSettings({ ...settings, [key]:value })[key] }); } catch { repaired = true; }
  }
  // A repaired connection/path must not cause writes to a fallback directory.
  if(repaired){settings.autoSync=false;settings.autoExplore=false;settings.autoDailyAi=false;}
  return { settings, repaired, migrated: ['modelUrl', 'model', 'modelKey'].some(key => Object.hasOwn(input, key)) };
}
export function dailyOptions(settings: Settings) { return dailyOptionsSchema.parse({ budgetMinutes: settings.dailyBudget, maxItems: settings.dailyMaxItems, goals: settings.learningGoals }); }
export function settingsError(error:unknown):string{
 if(error instanceof z.ZodError){const labels:Record<string,string>={directory:'阅读目录',serviceUrl:'材料服务地址',serviceToken:'材料服务令牌',guideUrl:'模型 API 地址',guideModel:'模型名称',guideKey:'模型 Key',dailyBudget:'每日阅读预算',dailyMaxItems:'每日材料上限',dailyAiLimit:'每日 AI 批次上限',syncIntervalMinutes:'自动同步间隔',learningGoals:'学习目标',discoveryTopics:'发现板块',explorationMaxItems:'探索推荐上限',searchKey:'搜索 Key',socialDataKey:'SocialData Key'};return [...new Set(error.issues.map(i=>labels[String(i.path[0])]??'配置内容'))].join('、')+'无效，请按设置项说明填写；配置未保存';}
 return error instanceof Error?error.message:'配置未保存';
}
export async function withTimeout<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work,new Promise<never>((_resolve,reject)=> { timer=setTimeout(()=>reject(new Error(message)),milliseconds); })]); }
  finally { clearTimeout(timer); }
}
