import { expect, it } from 'vitest';
import { apiBase, restoreSettings, withTimeout, parseSettings, settingsDefaults } from '../src/core/settings';
it('整份配置变成数组或文本时暂停自动任务，不当作首次安装',()=>{for(const input of [[], '损坏配置']){const restored=restoreSettings(input);expect(restored.repaired).toBe(true);expect(restored.settings.autoSync).toBe(false);expect(restored.settings.autoExplore).toBe(false);}expect(restoreSettings(null).repaired).toBe(false);});

it('旧伴读设置退出配置，保留每日导读 Key、限额、服务连接和目标', () => {
  const restored = restoreSettings({ modelUrl: 'https://retired.example.com', model: 'retired-model', modelKey: 'retired-key', guideKey: ' keep-guide-key ', serviceToken: ' keep-token ', dailyAiLimit: 2, learningGoals: '原来的阅读目标' });
  expect(restored.migrated).toBe(true); expect(restored.repaired).toBe(false);
  expect(restored.settings).not.toHaveProperty('model'); expect(restored.settings).not.toHaveProperty('modelUrl'); expect(restored.settings).not.toHaveProperty('modelKey');
  expect(restored.settings.guideKey).toBe('keep-guide-key'); expect(restored.settings.serviceToken).toBe('keep-token');
  expect(restored.settings.dailyAiLimit).toBe(2); expect(restored.settings.learningGoals).toBe('原来的阅读目标');
  expect(restoreSettings(restored.settings).migrated).toBe(false);
});
it('无效存储配置恢复，基础地址拒绝查询参数或远程明文 HTTP', () => {
  const restored = restoreSettings({ directory: '../private', serviceUrl: 42, guideKey: ' valid ' });
  expect(restored.repaired).toBe(true); expect(restored.settings.directory).toBe('09_信息源'); expect(restored.settings.guideKey).toBe('valid');
  expect(() => apiBase('https://example.org/v1?key=x')).toThrow('查询参数'); expect(() => apiBase('http://example.org')).toThrow('HTTPS'); expect(apiBase(' https://example.org/v1/ ')).toBe('https://example.org/v1');
});
it('无响应请求超时恢复控制权', async () => { await expect(withTimeout(new Promise(() => {}), 10, '响应超时')).rejects.toThrow('响应超时'); });
it('多板块和X设置本地保存、缺Key不启用请求；旧连接与自定义兴趣保留',()=>{
  const restored=restoreSettings({guideKey:'existing',searchProvider:'public',explorationGoals:'我自定义的兴趣'}).settings;
  expect(restored.discoveryTopics).toHaveLength(8);expect(restored.explorationMaxItems).toBe(3);expect(restored.socialDataKey).toBe('');expect(restored.searchProvider).toBe('public');expect(restored.explorationGoals).toBe('我自定义的兴趣');expect(restored.autoExplore).toBe(false);
  expect(restoreSettings({ explorationMaxItems: 6 }).settings.explorationMaxItems).toBe(6);
  const next=parseSettings({...settingsDefaults,discoveryTopics:['life'],socialDataKey:' local-key ',explorationMaxItems:12});expect(next.socialDataKey).toBe('local-key');expect(next.discoveryTopics).toEqual(['life']);
  expect(()=>parseSettings({...settingsDefaults,discoveryTopics:[]})).toThrow();expect(()=>parseSettings({...settingsDefaults,explorationMaxItems:13})).toThrow();expect(()=>parseSettings({...settingsDefaults,discoveryTopics:['life','life']})).toThrow();
});
