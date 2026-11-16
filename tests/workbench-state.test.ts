import { describe, expect, it } from 'vitest';
import { isVideoLink,isVideoMaterial, knowledgeLane, latestItems, publicationLabel, previewText } from '../src/ui/workbench-state';
import type { KnowledgeStatus } from '../src/core/knowledge';
import type { ReadingItem } from '../src/core/model';

describe('工作台对已保存状态的呈现', () => {
  const status = (label: string, issue?: string): KnowledgeStatus => ({ label, receipt: null, outputs: [], issue });
  it('只有实际讨论和归纳回执进入相应分组，取消任务不算待处理', () => {
    for (const label of ['已提交，等待 RAW 回执', '已排队，等待 Claudian 空闲', 'RAW 加工中']) expect(knowledgeLane(status(label))).toBe('pending');
    expect(knowledgeLane(status('已取消待处理'))).toBe('cancelled');
    expect(knowledgeLane(status('等待讨论'))).toBe('discussion');
    expect(knowledgeLane(status('Wiki 已归纳'))).toBe('complete');
    expect(knowledgeLane(status('fanOS 已晋升'))).toBe('complete');
  });
  it('产物核验异常不会被归纳成功标签隐藏', () => {
    expect(knowledgeLane(status('Wiki 已归纳，晋升需核对', '哈希变化'))).toBe('issue');
    expect(knowledgeLane(status('处理失败，可恢复'))).toBe('issue');
    expect(knowledgeLane(status('fanOS 已晋升', '产物缺失'))).toBe('issue');
  });
  it('按库提交顺序取最新版本，并保留历史版本各自的进度', () => {
    const old = { id: 'a', version: 'old', progress: 'reading', position: '第三段' } as ReadingItem;
    const other = { id: 'b', version: 'one', progress: 'done' } as ReadingItem;
    const next = { id: 'a', version: 'new', progress: 'unread' } as ReadingItem;
    const input = [old, other, next];
    expect(latestItems(input)).toEqual([next, other]);
    expect(input[0]).toEqual(old); expect(old.position).toBe('第三段');
  });
  it('没有发布时间时不把收录时间呈现为发布日期', () => {
    expect(publicationLabel({ capturedAt: '2026-10-13T10:00:00Z' })).toBe('发布时间未知');
    expect(publicationLabel({ capturedAt: '2026-10-13T10:00:00Z', publishedAt: 'bad' })).toBe('发布时间待核对');
    expect(publicationLabel({ capturedAt: '2026-10-13T10:00:00Z', publishedAt: '2026-10-12T10:00:00Z' })).toContain('10/12');
  });
  it('已有文字稿显示为可读材料，元数据视频才使用观看入口', () => {
    expect(isVideoMaterial({identity:'youtube:abc'})).toBe(true);expect(isVideoMaterial({identity:'bilibili:test'})).toBe(true);expect(isVideoMaterial({identity:'https://example.org/article'})).toBe(false);
    expect(isVideoLink({ identity: 'youtube:abc', coverage: 'metadata' })).toBe(true);
    expect(isVideoLink({ identity: 'youtube:abc', coverage: 'partial' })).toBe(false);
    expect(isVideoLink({ identity: 'https://example.com/a', coverage: 'metadata' })).toBe(false);
  });
  it('卡片预览保留链接文字，移除长地址和图片语法，不改变正文', () => {
    const body = '# 标题\n\n[相关文章](https://example.org/a?tracking=123) ![配图](https://example.org/image.png)\n正文内容。';
    expect(previewText(body)).toBe('标题 相关文章 正文内容。');
    expect(body).toContain('tracking=123');
    expect(previewText('[完整链接文字](https://example.org/' + 'a'.repeat(5000))).toBe('完整链接文字');
  });
});
