import { z } from 'zod';

export const discoveryTopicIds = ['domestic', 'international', 'business', 'investing', 'finance', 'life', 'growth', 'technology'] as const;
export type DiscoveryTopic = typeof discoveryTopicIds[number];
export const discoveryTopics: { id: DiscoveryTopic; name: string; terms: string[] }[] = [
  { id: 'domestic', name: '国内热点', terms: ['中国', '国内', '社会', '民生'] },
  { id: 'international', name: '国际热点', terms: ['国际', '全球', 'world', 'geopolitics'] },
  { id: 'business', name: '商业', terms: ['商业', '创业', 'business', 'startup'] },
  { id: 'investing', name: '投资', terms: ['投资', '资产配置', 'investing', 'portfolio'] },
  { id: 'finance', name: '财经', terms: ['财经', '经济', 'economy', 'finance'] },
  { id: 'life', name: '生活', terms: ['生活', '健康', 'lifestyle', 'wellbeing'] },
  { id: 'growth', name: '认知与成长', terms: ['认知', '年轻人', '个人成长', 'learning'] },
  { id: 'technology', name: '科技与AI', terms: ['科技', '人工智能', 'AI', 'technology'] },
];
export const discoveryTopicsSchema = z.array(z.enum(discoveryTopicIds)).min(1).max(8).refine(ids => new Set(ids).size === ids.length, '发现板块不能重复');
export function topicName(id?: string): string { return discoveryTopics.find(topic => topic.id === id)?.name ?? '未归类'; }
export function discoveryGoals(topics: DiscoveryTopic[], preferences: string): string {
  return `关注板块：${topics.map(topicName).join('、')}。任一板块的实质相关即可，关键词之间不要求同时命中。\n${preferences}`.slice(0, 2000);
}
/** Three first-page Top searches cover the selected sections with OR terms.
 * No cursor, individual profile calls, or paid thread expansion. */
export function socialDataQueries(topics: DiscoveryTopic[], now: Date): string[] {
  discoveryTopicsSchema.parse(topics);
  const groups: string[][] = [[], [], []];
  const ordered = discoveryTopics.filter(topic => topics.includes(topic.id));
  ordered.forEach((topic, index) => groups[index % 3]!.push(...topic.terms));
  const since = Math.floor(now.getTime() / 1000) - 7 * 86400;
  const until = Math.floor(now.getTime() / 1000);
  return groups.filter(group => group.length).map(group => `(${group.map(term => term.includes(' ') ? `"${term}"` : term).join(' OR ')}) min_faves:5 -filter:replies since_time:${since} until_time:${until}`);
}
