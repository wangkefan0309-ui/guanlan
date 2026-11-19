// Adapted from AIHOT 59c8c814 packages/backend/src/sources/rss.ts.
// Copyright (c) 2026 数字生命卡兹克; MIT license in THIRD_PARTY_NOTICES/AIHOT-MIT.txt.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseHTML } from 'linkedom';
import { canonicalIdentity, webUrl } from '../core/model';
import { asRecord, asText, field } from '../core/structured';

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', cdataPropName: '#cdata',
  processEntities: true, htmlEntities: true, trimValues: false, parseTagValue: false,
  stopNodes: ['feed.entry.title[type=xhtml]', 'feed.entry.summary[type=xhtml]', 'feed.entry.content[type=xhtml]'],
});
function text(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return text(item['#cdata'] ?? item['#text']);
  }
  return '';
}
function array<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function plain(value: string): string { return parseHTML(`<html><body>${value}</body></html>`).document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
export interface RssEntry { url: string; identity?: string; title: string; publishedAt?: string; bodyHtml: string; summary: string }
export interface FeedIdentity { platform?: 'wechat' | 'youtube' | 'bilibili' | 'rss'; accountId?: string; expectedName?: string }
/** Call only after parseRss has validated the same XML. */
export function feedName(xml: string): string {
  const document: unknown = parser.parse(xml);
  const name = plain(text(field(document, 'rss', 'channel', 'title') ?? field(document, 'feed', 'title')));
  if (!name || name.length > 160) throw new Error('订阅没有提供有效账号名称');
  return name;
}
export function parseRss(xml: string, responseUrl: string, summaryIsBody = false, source: FeedIdentity = {}): RssEntry[] {
  if (Buffer.byteLength(xml) > 4_000_000) throw new Error('订阅 XML 超过 4 MB');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('订阅 XML 不支持 DTD 或自定义实体');
  if (XMLValidator.validate(xml) !== true) throw new Error('订阅 XML 不完整或格式无效');
  const document: unknown = parser.parse(xml);
  const channel = asRecord(field(document, 'rss', 'channel'));
  const feed = asRecord(field(document, 'feed'));
  if (!channel && !feed) throw new Error('更新链接没有返回 RSS 2.0 或 Atom');
  if (source.expectedName && plain(text(channel?.title ?? feed?.title)) !== source.expectedName) throw new Error('订阅账号名称与配置不匹配');
  if (source.platform === 'youtube') {
    const uri = text(field(feed?.author, 'uri'));
    if (!feed || !uri || new URL(uri).pathname !== `/channel/${source.accountId}` || !['www.youtube.com', 'youtube.com'].includes(new URL(uri).hostname)) throw new Error('YouTube 频道身份与配置不匹配');
  }
  if (source.platform === 'bilibili') {
    const uri = text(channel?.link);
    if (!channel || !uri || new URL(uri).hostname !== 'space.bilibili.com' || new URL(uri).pathname.replace(/\/$/, '') !== `/${source.accountId}`) throw new Error('B站 UP 身份与配置不匹配');
  }
  const entries = array(channel ? channel.item : feed?.entry);
  if (entries.length > 200) throw new Error('订阅页超过 200 项，请减小上游分页大小');
  const base = new URL(asText(feed?.['@xml:base']) ?? '', responseUrl).toString();
  const out: RssEntry[] = [];
  for (const value of entries) {
    const entry = asRecord(value);
    if (!entry) throw new Error('订阅条目格式无效');
    let link: string;
    let bodyHtml: string;
    const summary = plain(text(channel ? entry.description : entry.summary));
    let title = text(entry.title);
    if (feed) {
      const entryBase = new URL(asText(entry['@xml:base']) ?? '', base).toString();
      const alternate = array(entry.link).map(asRecord).find(item => item && (!item['@rel'] || item['@rel'] === 'alternate'));
      const href = asText(alternate?.['@href']);
      if (!href) throw new Error('Atom 条目缺少原文链接');
      link = new URL(href, new URL(asText(alternate?.['@xml:base']) ?? '', entryBase)).toString();
      const content = entry.content, attributes = asRecord(content);
      const type = attributes?.['@type'] ?? 'text';
      bodyHtml = text(entry['content:encoded']);
      if (!bodyHtml && !attributes?.['@src']) {
        if (type === 'text') bodyHtml = `<p>${escapeHtml(text(content))}</p>`;
        else if (type === 'html' || type === 'xhtml') bodyHtml = text(content);
      }
      if (!bodyHtml && summaryIsBody) bodyHtml = text(entry.summary);
      const titleType = field(entry.title, '@type');
      if (titleType === 'html' || titleType === 'xhtml') title = plain(title);
    } else {
      const guid = entry.guid;
      link = text(entry.link) || (field(guid, '@isPermaLink') === 'false' ? '' : text(guid));
      if (!link.trim()) throw new Error('RSS 条目缺少原文链接');
      link = new URL(link.trim(), responseUrl).toString();
      bodyHtml = text(entry['content:encoded']) || (summaryIsBody ? text(entry.description) : '');
      title = plain(title);
    }
    webUrl.parse(link);
    let identity: string | undefined;
    const articleUrl = new URL(link);
    if (source.platform === 'youtube') {
      const videoId = text(entry['yt:videoId']);
      const uri = text(field(entry.author, 'uri'));
      const videoLink = articleUrl.pathname === '/watch' && articleUrl.searchParams.get('v') === videoId || articleUrl.pathname === `/shorts/${videoId}`;
      if (!/^[\w-]{11}$/.test(videoId) || !['www.youtube.com', 'youtube.com'].includes(articleUrl.hostname) || !videoLink || new URL(uri).pathname !== `/channel/${source.accountId}` || !['www.youtube.com', 'youtube.com'].includes(new URL(uri).hostname)) throw new Error('YouTube 视频或作者身份无法核对');
      link = `https://www.youtube.com/watch?v=${videoId}`; identity = `youtube:${videoId}`;
    } else if (source.platform === 'bilibili') {
      const bvid = articleUrl.pathname.match(/^\/video\/(BV[\w]{10})\/?$/)?.[1];
      if (!['www.bilibili.com', 'bilibili.com'].includes(articleUrl.hostname) || !bvid) throw new Error('B站订阅条目必须提供视频原链接');
      link = `https://www.bilibili.com/video/${bvid}`; identity = `bilibili:${bvid}`;
    } else if (source.platform !== 'rss' && articleUrl.hostname !== 'mp.weixin.qq.com') throw new Error('订阅条目必须提供微信公众号原文链接，请关闭上游本地文章链接');
    title = title.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!title) throw new Error('订阅条目缺少标题');
    // Editing an old Atom entry today does not make it a newly published item.
    const date = text(entry.pubDate) || text(entry.published);
    const timestamp = Date.parse(date);
    // Some WeRSS versions XML-escape a literal CDATA wrapper inside content:encoded.
    if (bodyHtml.startsWith('<![CDATA[') && bodyHtml.endsWith(']]>')) bodyHtml = bodyHtml.slice(9, -3);
    out.push({ url: canonicalIdentity(link), ...(identity ? { identity } : {}), title, bodyHtml, summary, ...(Number.isFinite(timestamp) ? { publishedAt: new Date(timestamp).toISOString() } : {}) });
  }
  return out;
}
