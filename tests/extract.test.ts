import { describe, expect, it } from 'vitest';
import { extractHtml, identifyWechat } from '../src/server/extract';
import { publicAddress } from '../src/server/public-fetch';

describe('材料提取',()=>{
  it('微信公众号正文独立于页面脚本，图片保留出处并说明缺口',()=>{
    const html='<html><body><h1 id="activity-name">文章题目</h1><a id="js_name">账号甲</a><div id="js_content"><p>这是一段足够长的正文，保留原始解释和具体条件。</p><img data-src="https://example.org/image.png"><script>stealSecrets()</script></div></body></html>';
    const item=extractHtml(html,{url:'https://mp.weixin.qq.com/s/test'}); expect(item.source).toBe('账号甲'); expect(item.body).toContain('具体条件'); expect(item.body).not.toContain('stealSecrets'); expect(item.body).toContain('https://example.org/image.png'); expect(item.coverage).toBe('partial'); expect(item.guideKind).toBe('excerpt'); expect(item.gaps.join('')).toContain('尚未下载');
  });
  it('验证页只有元数据，不用页面提示冒充正文或 AI 导读',()=>{
    const item=extractHtml('<html><head><title>环境异常</title></head><body>请完成验证后继续访问</body></html>',{url:'https://mp.weixin.qq.com/s/test'});
    expect(item.coverage).toBe('metadata'); expect(item.body).toBe(''); expect(item.guideKind).toBe('none');
  });
  it('空正文容器回退到页面内嵌HTML，保留段落、链接并标明付费预览', () => {
    const html = `<html><body><h1 id="activity-name">文章标题</h1><div id="js_content"></div><script>var data={content_noencode:'<section><p>公开预览正文。</p><a href="https://example.org/reference">参考原文</a></section><p class="js_pay_preview_filter"><mp-pay-preview-filter></mp-pay-preview-filter></p>'};</script></body></html>`;
    const item = extractHtml(html, { url: 'https://mp.weixin.qq.com/s/empty-container' });
    expect(item.body).toContain('公开预览正文。'); expect(item.body).toContain('[参考原文](https://example.org/reference)');
    expect(item.body).not.toContain('<section>'); expect(item.title).toBe('文章标题'); expect(item.coverage).toBe('partial');
    expect(item.gaps.join('')).toContain('付费预览');
  });
  it('脚本占位不阻止字段回退，真实DOM正文优先于内嵌旧字段', () => {
    const html = `<html><body><div id="js_content"><script>placeholder()</script></div><script>var content_noencode='<p>字段正文</p>';</script></body></html>`;
    expect(extractHtml(html, { url: 'https://mp.weixin.qq.com/s/a', title: 'RSS标题' })).toMatchObject({ title: 'RSS标题', body: '字段正文', coverage: 'partial' });
    expect(extractHtml(html.replace('<script>placeholder()</script>', '<p>DOM正文</p>'), { url: 'https://mp.weixin.qq.com/s/a' }).body).toBe('DOM正文');
  });
  it('零宽占位不能冒充正文，回退仍保留原容器的付费边界，纯文本标签保持字面值', () => {
    const html = `<html><body><div id="js_content">\u200b<mp-pay-preview-filter></mp-pay-preview-filter></div><script>var content_noencode='教程里输入 <span> 再继续';</script></body></html>`;
    const item = extractHtml(html, { url: 'https://mp.weixin.qq.com/s/zero-width' });
    expect(item.body).toContain('教程里输入 <span> 再继续'); expect(item.title).toBe('教程里输入 <span> 再继续');
    expect(item.gaps.join('')).toContain('付费预览');
    expect(extractHtml('<div id="js_content">\u200b</div>', { url: 'https://mp.weixin.qq.com/s/empty' }).coverage).toBe('metadata');
  });
  it('完整HTML片段允许尾部微信自定义付费标记及空元素', () => {
    for (const tail of ['<mp-pay-preview-filter></mp-pay-preview-filter>', '<br>']) {
      const html = `<html><body><div id="js_content"></div><script>var content_noencode='<p>这是公开预览。</p>${tail}';</script></body></html>`;
      const item = extractHtml(html, { url: 'https://mp.weixin.qq.com/s/preview-tail' });
      expect(item.body).toBe('这是公开预览。'); expect(item.title).toBe('这是公开预览。');
      if (tail.startsWith('<mp-')) expect(item.gaps.join('')).toContain('付费预览');
    }
  });
  it('短内容按明确的 content_noencode 字段提取，解码而不执行脚本',()=>{
    const html="<html><body><script>var info={nick_name:'dontbesilent',user_name:'gh_123',content_noencode:'这是一份真实的短内容，第一段说明问题。\\x0a\\x0a第二段说明条件。'};var biz = '' || 'ABC==';</script></body></html>";
    const item=extractHtml(html,{url:'https://mp.weixin.qq.com/s/short'}); expect(item.body).toContain('第二段说明条件'); expect(item.source).toBe('dontbesilent'); expect(identifyWechat(html)).toEqual({name:'dontbesilent',biz:'ABC==',wechatId:'gh_123'});
  });
  it('拒绝私有、回环、元数据服务和 IPv4 映射地址',()=>{
    for(const address of ['127.0.0.1','10.1.2.3','192.168.1.1','169.254.169.254','172.16.1.1','100.64.1.1','::1','::ffff:127.0.0.1','fe80::1']) expect(publicAddress(address)).toBe(false);
    expect(publicAddress('8.8.8.8')).toBe(true); expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  });
});
