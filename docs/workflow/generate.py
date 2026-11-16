"""Render the dated workflow reference. Run: py -3 -X utf8 docs/workflow/generate.py.

Node text and graph edges live here; workflow.md, index.html and SVGs are derived.
This script reads only named repository source paths and writes documentation.
"""
from pathlib import Path
import html
import json
import os
import sys

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[1]

def n(id, col, row, title, subtitle, kind='auto', detail='', source=''):
    return dict(id=id, col=col, row=row, title=title, subtitle=subtitle, kind=kind,
                detail=detail, source=source)

def e(a, b, label='', **kwargs):
    return dict(a=a, b=b, label=label, **kwargs)

charts = [
dict(id='overview', title='总览', subtitle='从发现材料到知识沉淀，三种入口汇入同一个阅读库。', nodes=[
    n('sub',0,0,'固定订阅','公众号 · YouTube · B站','auto','信源中维护来源、分类、检查间隔和启停。现有15项配置，14项启用；X属于探索渠道。','README.md'),
    n('explore',1,0,'兴趣探索','综合网页 + 可选X + 近期订阅','ai','按兴趣及八板块检索，用轻处理模型筛选；启用自动探索后，每天最多一批，目标由设置决定。','docs/active-exploration.md'),
    n('manual',2,0,'手动添加材料','链接 · MD · HTML · PDF · 字幕','manual','可仅导入阅读，也可在导入时明确选择讨论或直接写入Wiki。','docs/knowledge-integration.md'),
    n('ledger',0,1,'后台采集并保存','原页核验 → 去重 → 材料账本','auto','后台定时检查，文章保存原件和正文，视频订阅先保存元数据与观看链接。增量feed由ledger-index.json和ledger-entries提供。','docs/collection-setup.md'),
    n('cards',1,1,'远眺 · 推荐卡片','保留理由、证据、原链接及缺口','ai','推荐记录独立保存。外部推荐不会全部自动导入阅读库；近期订阅补充候选可复用已有正文。','docs/active-exploration.md'),
    n('import',2,1,'提取 / 导入 / 补文字稿','保留来源原件及覆盖范围','auto','扫描PDF不冒充OCR；视频先尝试公开字幕，受限时可导入自己的SRT/VTT。外部转换稿作为独立正文版本。','docs/knowledge-integration.md'),
    n('library',1,2,'Obsidian 阅读库','配置的库内相对目录','store','后台增量同步或主动导入后，保存原件、各版本正文、阅读进度、批注和索引；AI输出与原文分别保存。','docs/architecture.md'),
    n('today',0,3,'来讯 · 订阅更新','按作者发布日期；可选今日阅读','auto','当天清单默认50分钟、最多3篇，不限制全部订阅。规则清单无需模型，AI精选与短导读需另行生成，自动AI精选当前关闭。','README.md'),
    n('history',1,3,'拾遗 · 历史精选','默认每天2项，不调用模型','auto','全历史未读轮换，与当天探索去重。非空日清单保存后固定，已读或删除退出，当天不补位。','docs/history-highlights.md'),
    n('shelf',2,3,'藏卷 · 我的材料','检索 · 状态筛选 · 批量管理','manual','所有已收录材料集中管理。回收站保留正文、原件和版本，后续同步不会把删除内容自动加回。','docs/material-management.md'),
    n('read',1,4,'你阅读、观看、批注、判断','可随时结束，也可选择深入处理','manual','推荐、已读和短导读都不会自动授权知识加工。探索卡片也可直接打开原链接观看或阅读。','README.zh-CN.md'),
    n('end',0,5,'只阅读，到此完成','阅读进度与批注保留','manual','阅读和观看本身就是完整使用，不要求每篇都进入知识库。','README.zh-CN.md'),
    n('handoff',1,5,'选择指定材料交给 Claudian','保存版本、原件、会话及队列','manual','续思提供接续入口。只处理你明确选入的材料；先校验正文与原件，视频需要实际文字稿。','docs/knowledge-integration.md'),
    n('raw',1,6,'Claudian 按正式 RAW 协议加工','核验原件 → 登记 RAW → 提炼整合','ai','工作台准备交接与观察进度，Claudian使用当前选定知识模型调用正式fanos-raw流程。接口验证不等于加工完成。','docs/knowledge-integration.md'),
    n('dialogue',0,7,'先讨论，再明确归纳','默认路径：提问、修正、确认','manual','交付讨论底稿后，你继续交流，再明确要求“归纳并写入当前Wiki”。','docs/knowledge-integration.md'),
    n('direct',2,7,'直接写入 Wiki','明确点击后，跳过讨论','manual','这是对指定材料在08内客观整理及最终归纳的明确授权，不混入个人批注或聊天想法。','docs/knowledge-integration.md'),
    n('wiki',1,8,'08_LLM Wiki · 完成归纳','主题页 + 来源档案 + 地图 + 回执','store','依据当前run正式事件、原件哈希、材料版本和实际文件核验。历史成功或回答文字不能代替本次产物。','docs/knowledge-integration.md'),
    n('fanos',1,9,'另行授权后晋升 fanOS','明确目标笔记 / 看板 → 写入并回填','manual','只有明确目标和具体改动获授权后才晋升。Wiki完成与fanOS晋升分别核对；周期维护尚未启用。','docs/knowledge-integration.md'),
], edges=[e('sub','ledger'),e('explore','cards'),e('manual','import'),e('ledger','library','启动 / 打开 / 每5分钟同步'),e('cards','library','选择收录；已有正文则复用'),e('import','library'),e('library','today'),e('library','history'),e('library','shelf'),e('today','read'),e('history','read'),e('shelf','read'),e('cards','read','直接打开原文或观看',route='right'),e('read','end'),e('read','handoff','你选择深入处理'),e('handoff','raw'),e('raw','dialogue'),e('raw','direct'),e('dialogue','wiki','明确要求归纳'),e('direct','wiki'),e('wiki','fanos','另行授权具体目标')], notes=[
    '订阅采集、Obsidian同步、探索模型、Claudian知识加工分别运行、分别核验。',
    '电脑关机或休眠时不采集；Obsidian关闭时不发起插件探索或新的知识队列任务。',
    '总览中的知识链路是当前可用流程，不代表所有正式材料已经加工完成。']),
dict(id='subscriptions',title='订阅采集',subtitle='信源配置 → 平台采集 → 后台账本 → 插件同步 → 来讯。',nodes=[
    n('settings',1,0,'信源 · 添加或管理订阅','识别地址 → 分类 / 间隔 / 启停','manual','来源行启停立即保存；分类和间隔等弹窗设置需显式保存。关闭来源中止后续抓取，已收录材料保留。','README.md'),
    n('wx',0,1,'公众号 / 普通RSS','公众号全文RSS + 原页核验','auto','公众号核对账号、作者发布日期和正文；普通RSS/Atom保留feed正文，必要时回源。私密RSS只留本机。','docs/collection-setup.md'),
    n('yt',1,1,'YouTube','官方 Data API → Atom → 公开主页','auto','可以在后台保存并验证官方 API Key。备用路线有界读取；列表成功只说明拿到视频元数据，不说明拿到字幕。','docs/youtube-official-api.md'),
    n('bili',2,1,'B站','本机 RSSHub；失败可浏览器回退','auto','核对UID与视频身份，保存元数据及观看链接；适配XML不会冒充官方RSS。','docs/collection-setup.md'),
    n('validate',1,2,'核对来源、日期与内容','条件读取；每6小时完整核对','guard','正常按来源间隔采集，默认每小时。公众号当天候选核验原页；日期未知或未来不能冒充今日发布。','docs/architecture.md'),
    n('save',1,3,'按身份与内容版本去重保存','原件 / 正文或视频元数据','store','后台先保存单条材料，再提交索引与序号。失败不确认指纹；空feed成功与正文成功分别记账。','docs/architecture.md'),
    n('retry',2,3,'失败分类并保留检查历史','网络 / 授权 / 限流 / 存储','guard','网络按1、2、5、10、15分钟重试；授权和限流遵守各自条件。恢复检查只提前处理符合条件的网络失败。','docs/collection-setup.md'),
    n('feed',1,4,'后台增量材料 feed','ledger-index.json + ledger-entries','store','逐条读取并核验哈希；后台保存与阅读库同步是两个步骤。旧ledger.json仅保留历史。','docs/architecture.md'),
    n('sync',1,5,'插件同步已采集材料','启动、打开工作台、每5分钟','auto','不调用AI。检查并同步会先发起采集检查并同步已有材料，检查结束后再同步新材料，最多跟踪3分钟。','src/core/subscription-refresh.ts'),
    n('vault',1,6,'阅读库提交原件、正文与索引','整页成功后再推进同步游标','store','已登记正文批注保留并报告，独立新材料可继续同步；原件缺失、校验失败或写入失败继续阻止游标推进。','src/core/library.ts'),
    n('view',1,7,'来讯按作者日期展示','回看日期 / 跨日检索 / 阅读','auto','有界延迟补收最多前7天，必须先启用，且依赖上游仍保留条目及原页可读。补收归原日期，不挤进今天。','README.md'),
],edges=[e('settings','wx'),e('settings','yt'),e('settings','bili'),e('wx','validate'),e('yt','validate'),e('bili','validate'),e('validate','save','核验通过'),e('validate','retry','未通过'),e('retry','validate','按条件再检查',route='right'),e('save','feed'),e('feed','sync'),e('sync','vault'),e('vault','view')],notes=[
    '当前记录：15项配置、14项启用。2026-11-04 15:04只读核验时，14项启用来源均为ok；该时点不证明全历史覆盖。',
    '“同步已采集材料”只读后台已有内容；“检查并同步”同时衔接本轮采集与同步。',
    '来源识别、配置保存、采集、正文取得、同步成功分别核验，不共用一个“成功”。']),
dict(id='discovery',title='探索与阅读',subtitle='探索目标、今日阅读预算和历史精选数量是三套独立规则。',nodes=[
    n('trigger',1,0,'远眺 · 发现新内容','自动开启；也可手动发起','manual','插件启动、工作台打开、每小时、窗口恢复时检查当天批次；恢复只处理当日，不补跑停机期间每一天。','docs/active-exploration.md'),
    n('day',1,1,'检查当日回执，先保存历史引用','已完成 / 失败 / 未知，不重发','guard','新的探索先准备当天历史精选，再排除其链接；历史保存失败先报错。已存在日批次复用，不因升级重新计费。','src/plugin/main.ts'),
    n('web',0,2,'网页发现','DeepSeek联网 / 公开检索 / Tavily','ai','综合发现可使用DeepSeek原生联网；免Key HN/GitHub偏技术。Tavily是可选渠道，本机未配置。','docs/active-exploration.md'),
    n('x',1,2,'可选免费 X','自己的账号；共享日缓存','auto','最多3个Top首页，每页最多20帖，不翻页。失败或未知停止当天后续请求，不自动转付费SocialData。','docs/free-x-setup.md'),
    n('subs',2,2,'近期订阅正文补充','近7天未读 / 稍后读，最多6项','auto','使用已经保存的实际正文，明确标注订阅补充；排除已读、拒绝和近期推过的链接。','docs/active-exploration.md'),
    n('evidence',1,3,'合并候选、预筛与有限补证','最多24候选，证据与缺口分开','auto','网页最多核对6页，X每批最多补读3条实际外链。帖文、外链摘选和视频内容分别标记。','docs/active-exploration.md'),
    n('score',1,4,'轻处理模型筛选 + 程序校验','PASS · 价值≥60 · 相关性≥6','ai','还须具体增量或用途、证据足够且已评份量合格。未知作品份量留空；不把分数当真实性概率。原生联网与筛选分别计用量。','docs/active-exploration.md'),
    n('zero',2,5,'不够则如实少推或零推荐','保留排除原因与失败回执','guard','不降门槛凑数，不把只有标题、互动量或未看视频当作已评价全文。','docs/active-exploration.md'),
    n('picks',1,5,'远眺 · 目标每天1～3条','事件去重、板块与作者搭配','ai','与当天历史精选去重，并排除已读、回收站、拒绝及30天内推荐链接；推荐生成日期与内容日期分开。','docs/active-exploration.md'),
    n('open',0,6,'直接打开原文 / 观看','无需先收录','manual','仅打开外链不代表已经取得正文或字幕；可以只读不收录。','docs/active-exploration.md'),
    n('collect',1,6,'选择收录正文或取得文字稿','已有订阅正文直接复用','manual','X收录保存本条完整文字与原始对象，不包含回复、视频转写或外链全文；文章走普通导入。','docs/active-exploration.md'),
    n('reject',2,6,'拒绝该推荐','后续探索排除对应链接','manual','反馈进入去重排除，不重新生成当天推荐或改写历史评分。','docs/active-exploration.md'),
    n('readlib',1,7,'进入同一阅读库','原件、正文、进度与批注','store','重复收录去重，版本独立，原有批注和位置保留；不把AI摘要合并成来源正文。','docs/architecture.md'),
    n('today',0,8,'来讯 · 今日阅读','默认50分钟 / 最多3篇','auto','规则清单无需模型；可手动生成AI精选与短导读，默认每天一批、最多12篇，每篇前2400字符。自动AI精选当前关闭。','README.md'),
    n('history',1,8,'拾遗 · 历史精选','默认2项；全历史未读轮换','auto','无需新模型调用；未读至少7天、稍后读14天再推。日清单固定，已读或删除不补位。','docs/history-highlights.md'),
    n('shelf',2,8,'藏卷 · 检索与批量管理','未读 / 阅读中 / 稍后读 / 已读','manual','回收站保留原文件及各版本；删除状态阻止同步复活。未保存的阅读草稿会阻止批量改动。','docs/material-management.md'),
    n('read',1,9,'阅读、批注、保存进度','只阅读，或选择进入续思','manual','推荐不会自动标已读，已读不会自动写Wiki。阅读时可继续选入知识加工。','docs/knowledge-integration.md'),
],edges=[e('trigger','day'),e('day','web'),e('day','x'),e('day','subs'),e('web','evidence'),e('x','evidence'),e('subs','evidence'),e('evidence','score'),e('score','picks','达标后'),e('score','zero','不达标 / 无候选'),e('picks','open'),e('picks','collect'),e('picks','reject'),e('collect','readlib'),e('readlib','today'),e('readlib','history'),e('readlib','shelf'),e('today','read'),e('history','read'),e('shelf','read')],notes=[
    '探索每天目标1～3条；历史精选默认2项；今日阅读默认最多3篇。这些数量分别计算。',
    '当前记录的探索异常：11月2日novelty空值兼容失败未修复；11月3日started结果未知；11月4日completed不等于内容质量已核验。',
    '免费X没有数据API费；探索联网及模型筛选仍消耗模型用量。']),
dict(id='knowledge',title='知识沉淀',subtitle='工作台负责准备与接续，Claudian负责遵循正式协议加工，最终状态由产物证明。',nodes=[
    n('choose',1,0,'明确选中一份材料及版本','讨论，或直接写入 Wiki','manual','来自来讯、远眺、拾遗、藏卷或手动导入。允许只读；必须明确选择才进入加工。','docs/knowledge-integration.md'),
    n('check',1,1,'检查实际正文、原件与覆盖','视频先取得字幕；PDF保留原件','guard','原件和正文快照按哈希保护。短导读或推荐摘要不能当全文，正文快照排除AI导读。','docs/knowledge-integration.md'),
    n('missing',2,2,'不足或冲突，先补齐 / 核对','公开字幕失败可自行导入字幕','manual','无字幕或受限视频需要外部文字稿；扫描PDF需外部OCR/转换。用户修改和原件冲突不被覆盖。','docs/knowledge-integration.md'),
    n('queue',1,2,'保存接续笔记、冻结快照与队列','绑定会话，保存首次讨论/直达选择','store','队列按材料身份与版本保存。多篇串行，等待当前RAW任务结束，也保护其他聊天的文字/图片草稿及正在接收的回复。','docs/knowledge-integration.md'),
    n('bridge',1,3,'核对 Claudian 接口 → 保存提交意图','验证回执成功保存后才放行','guard','内置历史实测2.3.17；其他版本要验证当前版本与适配契约。验证不发模型请求；发送结果未知不重发。','src/plugin/claudian.ts'),
    n('raw',1,4,'Claudian 按 Vault 正式协议加工','复制并核验原件 → RAW登记 → 提炼','ai','遵循当前Vault的fanos-raw真源，使用Claudian当前知识模型。工作台轻处理模型与此链路分开，不由工作台伪造登记。','docs/knowledge-integration.md'),
    n('discussion',0,5,'默认：等待讨论','交付底稿 → 提问、修正、补充','manual','讨论后明确说“归纳并写入当前Wiki”；阅读完成或同意某句话不能代替最终归纳授权。','docs/knowledge-integration.md'),
    n('direct',2,5,'直达：跳过讨论','按原文客观整理指定材料','manual','点击直达即授权在08内完成归纳。优先整合已有主题，不掺入个人批注，不把作者主张当成已验证事实。','docs/knowledge-integration.md'),
    n('wiki',1,6,'实际写入 08_LLM Wiki','主题知识、来源档案、地图及正式回执','store','由Claudian保存产物和finalize事件。原件或版本不匹配、用户修改冲突时先停止报告。','docs/knowledge-integration.md'),
    n('observe',1,7,'续思核对当前任务结果','当前run + 同版本 + 哈希 + 实际文件','guard','RAW已登记、等待讨论、Wiki已归纳、fanOS已晋升分别显示。旧run成功不能覆盖新失败；仅发送不代表处理成功。','docs/knowledge-integration.md'),
    n('fanos',1,8,'另行授权具体目标后晋升 fanOS','目标笔记 / 看板 → 写入 → 回链核验','manual','晋升需明确目标和改动，校验写后哈希及来源/Wiki/看板回链；目标后续被编辑则保留并提示核对。','docs/knowledge-integration.md'),
],edges=[e('choose','check'),e('check','queue','正文与原件足够'),e('check','missing','缺口 / 冲突'),e('missing','check','补齐后',route='right'),e('queue','bridge'),e('bridge','raw'),e('raw','discussion'),e('raw','direct'),e('discussion','wiki','明确要求归纳'),e('direct','wiki','已明确选择直达'),e('wiki','observe'),e('observe','fanos','另外授权目标')],notes=[
    '接续准备 ≠ RAW已登记；接口验证通过 ≠ 模型加工成功；Wiki完成 ≠ fanOS晋升。',
    '原会话无法继续时可显式从已核验回执恢复。首轮只读；清除未发送的旧直达意图，归纳需再次明确给指令。',
    '已提交但结果未知不自动重发；关闭Obsidian后不继续插件自动出队，重开仅恢复当前阅读库已授权且尚未提交的队列。']),
dict(id='recovery',title='恢复与维护',subtitle='三条保障链独立于日常阅读；这张图说明处理规则，不表示已执行维护。',nodes=[
    n('net',0,0,'采集 / 同步出现问题','保留已有材料、进度和失败历史','guard','不因一次网络错误例行重配订阅或密钥，先看错误类型、重试时间和来源检查记录。','docs/collection-setup.md'),
    n('model',1,0,'模型 / 知识任务发起','先持久化批次或提交意图','store','每日AI、探索和知识发送分别记录首次任务，保留原始模型配置、结果与用量。','docs/architecture.md'),
    n('release',2,0,'维护者准备更新','隔离修复、检查、构建、签名','manual','代码变更执行适用检查；真实材料库不导入合成测试材料。插件与后台分别核验旧版本及更新结果。','docs/plugin-updates.md'),
    n('classify',0,1,'分类处理','网络 / 授权 / 限流 / 存储','guard','网络恢复只提前处理符合条件的网络来源；授权与限流不能因网络恢复而绕过。','docs/collection-setup.md'),
    n('result',1,1,'已知结果：先保存日志与回执','再保存导读 / 推荐 / 索引','store','生成结果保存失败时只补保存首次结果，保留原模型配置，不再次请求模型。','docs/architecture.md'),
    n('backup',2,1,'核验旧后台并正常停服','完整备份后升级','manual','只停止核实身份的自有进程。完整备份包含当前分段材料账本与索引，不拿旧ledger.json代替。','docs/operator-runbook.md'),
    n('backoff',0,2,'按类型退避重试','网络：1 / 2 / 5 / 10 / 15分钟','auto','暂时验证页或正文暂缺等失败可退避至1小时；其他错误按各自策略。排定时间不保证上游已恢复。','docs/collection-setup.md'),
    n('unknown',1,2,'超时 / 仅started / 发送未知','不自动重发','guard','保留原记录，等待明确结果或核对已有产物；未知结果不能通过重建批次来规避限制。','docs/architecture.md'),
    n('upgrade',2,2,'后台升级并核验数据','成功后准备本机签名更新通道','manual','程序升级、后台启动、材料保留和通道准备分别核验。升级成功不表示旧备份已云端归档。','docs/plugin-updates.md'),
    n('catchup',0,3,'恢复后按窗口补收','最多前7天，依赖上游仍可读','auto','需要已启用延迟补收，且不早于开始使用日；停机不保证全量补齐。原件与正文成功后才能记材料成功。','docs/collection-setup.md'),
    n('conflict',1,3,'文件被改或产物不匹配','保留用户内容，报告冲突','guard','正文版本独立；已登记批注可保留并报告，原件缺失/哈希失败或写入失败需先处理。','docs/architecture.md'),
    n('install',2,3,'插件检查后手动一键更新','签名、哈希、任务与草稿检查','manual','只替换自身4个程序文件；当前data.json与材料保留。事务失败按条件恢复，外部修改不强制覆盖。','docs/plugin-updates.md'),
    n('commit',0,4,'重新同步并提交检查点','整页成功后推进游标','store','原件缺失、哈希错误、实际写入失败继续阻止游标；已有批注保护不阻止独立新材料保存。','src/core/library.ts'),
    n('resume',1,4,'恢复首次结果或原知识会话','只在真实回执与文件匹配时恢复','manual','已落盘首次结果可补存。知识会话显式恢复首轮只读，不默默重发旧任务。','docs/knowledge-integration.md'),
    n('cloud',2,4,'历史后台快照加密归档','私有云上传 → 回读 → 逐文件核验','manual','云端依赖附件全部保留，密码独立保管。失败时保留本地未核验副本；不涉及当前运行数据清理。','docs/backup-retention.md'),
    n('retention',2,5,'核验通过后轮换旧副本','目标：两个不同版本各最新一份','guard','当前记录仍有5个版本的本地完整快照，两版本是核验后目标，尚未达成。这不等于整个Vault或完整源码备份。','docs/backup-retention.md'),
],edges=[e('net','classify'),e('classify','backoff'),e('backoff','catchup','恢复后'),e('catchup','commit'),e('model','result','拿到首次结果'),e('result','unknown','如果结果实际未知'),e('result','conflict','保存冲突',route='left'),e('conflict','resume'),e('release','backup'),e('backup','upgrade'),e('upgrade','install'),e('install','cloud'),e('cloud','retention','回读核验成功后')],notes=[
    '三列分别展示网络恢复、模型与知识恢复、程序更新和备份；流程可独立进行。',
    '未启用：受限字幕 / ASR、Wiki周期维护、云端运行和关机持续采集。',
    '自然跨日、登录变化、物理开机 / 休眠和长期稳定性仍需实际观察。']),
]

reading_chart = dict(id='reading',title='阅读与精选',subtitle='来讯看当天，拾遗消化历史，藏卷管理所有材料；AI短导读是单独的可选路径。',nodes=[
    n('library',1,0,'同一阅读库与索引','当前材料、各版本、阅读状态与批注','store','三个阅读入口复用同一ReadingLibrary，使用真实文件和索引，不重复复制正文。','docs/architecture.md'),
    n('today',0,1,'来讯 · 今日阅读候选','当天订阅正文，不限制全部来讯','auto','按作者真实发布日期归档，排除已读、稍后读、纯元数据和验证用途；阅读中优先。AI资讯/热点过旧时不自动精选。','docs/architecture.md'),
    n('old',1,1,'拾遗 · 全历史候选','当天之前的历史未读材料','auto','不限近7天。日期未知时按本地保存边界判断历史，不补造作者日期。视频有可打开原链接也可选，但明确没有文字稿。','docs/history-highlights.md'),
    n('all',2,1,'藏卷 · 全部已收录材料','跨日检索与阅读状态筛选','manual','按未读、阅读中、稍后读、已读查看，也可从日期页回看历史；批量选择覆盖筛选结果的全部分页。','docs/material-management.md'),
    n('rule',0,2,'规则生成今日清单','默认50分钟 / 最多3篇','auto','预算按阅读速度估算，默认每分钟450字；板块搭配、在读优先。保存清单采用比较写入，用户修改保留并提示。','docs/architecture.md'),
    n('rotate',1,2,'价值 + 积压轮换','默认每天2项，可设1～5项','auto','先照顾少推荐的材料，兼顾优先级、在读、正向评价和最早积压；未读至少7天、稍后读至少14天再推。','docs/history-highlights.md'),
    n('manage',2,2,'批量状态与回收站操作','保留阅读位置；草稿未存先拦截','manual','已读、未读、稍后读按文章更新，原件和批注不改；删除同一文章全部版本，仅移入索引回收站。','docs/material-management.md'),
    n('ai',0,3,'可选：生成 AI 精选与导读','当前自动开关关闭；可手动生成','manual','只做轻处理，使用设置中的模型连接。每天默认1批；同批复用，失败或未知也计限额，不能通过重试重发。','README.md'),
    n('refs',1,3,'保存当天固定版本引用','与当天探索按规范化链接去重','store','不复制正文、不调用模型；非空清单提交后固定。已读或删除退出，当天不补位；后来出现新版本不替换旧引用。','docs/history-highlights.md'),
    n('trash',2,3,'可恢复删除','正文、原件、版本仍保留','store','删除仅影响本阅读库，不改共享后台材料账本。同步跳过同一来源身份，不会自动复活；已有知识任务不被撤销。','docs/material-management.md'),
    n('review',0,4,'摘选输入 → 模型 → 校验','最多12篇，每篇前2400字符','ai','编号原文证据最多8段，程序按编号回取原文。输出PASS/BLOCK/UNKNOWN；PASS且≥40分参与AI排序，未评估项继续规则排序。不能把摘选评价当全文精读。','docs/architecture.md'),
    n('restore',2,4,'恢复原材料及全部版本','沿用原路径、批注、状态与位置','manual','恢复后继续按原材料身份和版本去重；不会重跑探索或知识模型，也不等于重新授权Wiki加工。','docs/material-management.md'),
    n('guide',0,5,'独立保存导读、证据与用量','再更新回执索引和清单','store','导读位于AI导读目录，原回答无效时保存到模型回执，不当作有效导读。保存失败只补存首次结果；原文与AI内容分别保留。','docs/architecture.md'),
    n('read',1,6,'阅读 / 观看 / 批注 / 保存位置','可以直接读原文，也可看短导读','manual','不会因为推荐一次就标已读。未保存的正文修改要先处理，批量状态和知识队列保护草稿。','docs/knowledge-integration.md'),
    n('finish',0,7,'阅读完成即可结束','不强制沉淀每篇材料','manual','只阅读观看也是完整使用。工作台不因已读或赞同一句话自动生成Wiki。','README.zh-CN.md'),
    n('continue',2,7,'明确选入知识加工','讨论后归纳 / 直接写入Wiki','manual','从材料详情或推荐卡片进入续思，使用指定版本、实际正文与原件；先补足证据，再调用Claudian。','docs/knowledge-integration.md'),
],edges=[e('library','today'),e('library','old'),e('library','all'),e('today','rule'),e('old','rotate'),e('all','manage'),e('rule','ai','你选择AI时'),e('rule','read','直接阅读，无需模型',route='left'),e('rotate','refs'),e('manage','trash','选择删除'),e('manage','read','阅读 / 改状态',route='right'),e('trash','restore'),e('refs','read','打开原版本',route='near-right'),e('ai','review'),e('review','guide'),e('guide','read'),e('restore','read'),e('read','finish'),e('read','continue')],notes=[
    '今日阅读最多3篇、历史精选默认2项、探索目标1～3条分别计算；任何数量都不限制你查看全部材料。',
    '今日阅读的AI排序门槛是40分；探索推荐门槛是60分且另有相关性等条件，两套规则不混用。',
    '历史精选不新增模型调用，清单固定后不因为当天读完而继续补位；删除材料暂不释放磁盘文件。'])

import_chart = dict(id='importing',title='导入与文字稿',subtitle='手动材料和推荐收录都先形成可追溯的材料，再选择是否进入知识流程。',nodes=[
    n('start',1,0,'添加材料 / 推荐卡片收录','选择材料和导入后的处理方式','manual','可选择仅导入、导入并交给Claudian、导入并直接写入Wiki；实际保存失败时不冒充后续任务已完成。','docs/knowledge-integration.md'),
    n('link',0,1,'文章链接 / X帖文','保留原始链接与来源身份','manual','普通文章请求公开原页；X收录复用已校验缓存，保存本条完整文字和原始接口对象，不包含回复、外链全文或视频转写。','docs/active-exploration.md'),
    n('file',1,1,'MD / HTML / PDF','稳定身份与原字节','manual','同一材料更新复用identity，用内容哈希区分版本。同名不同材料需区分来源身份，不凭标题覆盖旧文件。','docs/integration-guide.md'),
    n('video',2,1,'YouTube / B站 / SRT / VTT','取得视频文字稿，或导入自有字幕','manual','视频订阅和推荐元数据不是文字稿；公开视频字幕端点不写订阅feed。用户自有字幕可直接导入。','docs/knowledge-integration.md'),
    n('fetch',0,2,'读取原页或本条缓存','提取文字，保留原件和缺口','auto','普通网页仅允许公网和标准端口，逐跳校验，不执行脚本或调用模型/MinerU。仅保留远程绝对图片地址，相对图片移除；保留HTML不等于完整离线页面。免费X原件缺失或哈希失败阻止收录。','docs/integration-guide.md'),
    n('parse',1,2,'解析文件 / 附加PDF转换稿','原件保留；转换稿独立版本','auto','扫描PDF不会伪装成已OCR。MinerU等转换稿需外部取得后补充，当前不内置MinerU服务。','docs/knowledge-integration.md'),
    n('transcript',2,2,'尝试公开字幕 / 解析字幕文件','保留时间定位与语言说明','auto','公开字幕标记partial，注明自动字幕和画面缺口。SRT/VTT保留原字节；逆序或零时长保留句子并提示待核对。','docs/knowledge-integration.md'),
    n('material',1,3,'形成材料及覆盖说明','正文 / 部分文字 / 仅元数据','guard','来源原件、提取正文、AI生成内容始终分开；标题和推荐摘要不能替代缺失的实际内容。','docs/architecture.md'),
    n('backend',0,3,'服务导入先写后台账本','普通链接 / HTML / PDF 的导入请求','store','POST /v1/import成功会先登记后台材料账本，再返回Material，不创建订阅。插件收到返回后直接保存阅读库；外部HTTP客户端导入后需同步已采集材料。插件本地解析的MD/SRT/VTT、视频字幕和X单帖返回不走这一步。','src/server/service.ts'),
    n('missing',2,3,'正文不足或字幕受限','可先读链接；知识加工前补齐','manual','登录限制、无公开字幕、X/其他平台视频或额外分P需要外部文字稿。没有自动下载音视频或启用付费ASR。','docs/knowledge-integration.md'),
    n('identity',1,4,'核对材料身份与内容版本','规范化URL / 稳定文件identity','guard','材料ID来自来源身份，版本哈希包含正文、覆盖等内容；板块、采集时间和AI导读不制造新正文版本。','docs/architecture.md'),
    n('same',0,5,'同身份、同版本','复用首次材料与保存元数据','auto','不重复创建正文版本，保留首次保存的材料信息、阅读位置和批注；已有回收站记录要求先恢复。','docs/architecture.md'),
    n('new',1,5,'新材料或新内容版本','为正文版本分配独立路径','auto','不会用新正文覆盖原版本；同一PDF的新转换稿也不能沿用旧转换稿的Wiki成功状态。','docs/architecture.md'),
    n('blocked',2,5,'原件 / 文件发生冲突','保留用户内容并报告','guard','原件缺失、哈希变化或非法路径不能被“重试导入”绕过；已登记正文批注保留并报告，按实际原因处理。','docs/architecture.md'),
    n('save',1,6,'恢复记录 → 原件 / 正文 → 索引','比较写入；失败保留恢复点','store','先保存首次材料与原件的恢复记录，再落原件和正文，最后提交索引；重试补交同一结果，不强写用户改动。','docs/architecture.md'),
    n('ready',1,7,'材料已保存到阅读库','阅读、批注、检索与后续接续','store','插件导入弹窗把返回材料直接保存到当前阅读库。/v1/import已先写后台账本；HTTP客户端需后续同步。视频文字稿、X单帖和插件本地解析的MD/SRT/VTT不因此进入后台feed；所有这些操作都不创建订阅。','docs/integration-guide.md'),
    n('read',0,8,'仅导入阅读','按自己的节奏阅读','manual','保存、阅读和观看不依赖Claudian可用，也不会自动正式登记RAW。','docs/knowledge-integration.md'),
    n('discuss',1,8,'导入并讨论','进入知识队列，先交付底稿','manual','明确选择后，按当前版本冻结正文、准备接续笔记和队列；实际RAW由Claudian核验与登记。','docs/knowledge-integration.md'),
    n('direct',2,8,'导入并直接写入Wiki','明确授权指定材料在08内归纳','manual','跳过讨论但保留来源、原件和正式核验；不因此授权写fanOS、Inbox或个人记忆。','docs/knowledge-integration.md'),
],edges=[e('start','link'),e('start','file'),e('start','video'),e('link','fetch'),e('file','parse'),e('video','transcript'),e('fetch','backend','普通文章'),e('fetch','material','X单帖返回',bend=-12),e('parse','backend','HTML / PDF',bend=12),e('backend','material'),e('parse','material','MD本地解析'),e('transcript','material','取得文字'),e('transcript','missing','受限或缺失'),e('material','identity'),e('identity','same','已存在'),e('identity','new','新版本'),e('identity','blocked','校验失败'),e('same','ready','复用',route='left'),e('new','save'),e('save','ready'),e('ready','read'),e('ready','discuss'),e('ready','direct')],notes=[
    '视频条目成功、字幕取得成功和知识加工成功分别判断。公开字幕仍不包含画面信息。',
    '更换阅读目录会建立独立库，不自动搬迁旧材料、索引、回收站、知识队列或RAW/Wiki引用。',
    '旧的手动RAW交接准备保留，但准备文件不等于正式RAW登记，更不等于Wiki或fanOS完成。'])

charts[2]['title']='兴趣探索'
charts.insert(3,reading_chart)
charts.insert(4,import_chart)
for chart in charts:
    if chart['id']=='overview':
        for edge in chart['edges']:
            if edge['a']=='cards' and edge['b']=='read':edge['route']='near-right'
    if chart['id']=='recovery':
        node=next(node for node in chart['nodes'] if node['id']=='result')
        node.update(title='核对首次结果与保存状态',subtitle='已有结果补存；未知停止重发',kind='guard',detail='已拿到首次结果时先保存日志与回执，再保存导读、推荐和索引。没有最终结果则保留未知；已有结果保存失败只补存，不再次调用模型。')
        for edge in chart['edges']:
            if edge['a']=='result' and edge['b']=='conflict':edge['route']='near-right'
    if chart['id']=='knowledge':
        next(node for node in chart['nodes'] if node['id']=='bridge')['title']='验证接口并保存提交意图'

enrichment = {
    ('overview','library'):{'触发':'后台同步成功，或主动材料导入成功','输入':'有来源身份、内容版本、覆盖范围的Material','保存':'阅读材料/、原件/、_工作台/state.json','完成依据':'实际文件与索引对应，冲突按规则报告'},
    ('subscriptions','validate'):{'触发':'后台每30秒找出到期来源；正常来源默认每小时','输入':'已启用来源的feed/API/公开页及首次配置快照','处理':'身份、链接、作者日期、正文与有界补收窗口核验','失败':'不记正文成功，不确认尚未保存的指纹'},
    ('subscriptions','save'):{'输入':'核验后的文章正文或视频元数据','保存':'后台ledger-entries/<序号>-<哈希>.json，再提交ledger-index.json','完成依据':'单条文件、索引序号与哈希匹配','失败':'保留首次结果，索引或指纹不推进'},
    ('subscriptions','sync'):{'触发':'插件启动、打开工作台、当前每5分钟；或手动点击','输入':'/v1/feed?after=游标&instance=实例','输出':'当前阅读库内的新材料和版本','区别':'“同步已采集材料”不发起新采集；“检查并同步”衔接两者'},
    ('subscriptions','vault'):{'处理':'分页读取，每页逐条导入，再提交该页检查点','保护':'保留正文批注；删除身份跳过；实际写入受比较保护','完成依据':'页内材料处理成功，索引保存成功','失败':'原件缺失、哈希失败、实际写入失败时不推进游标'},
    ('discovery','day'):{'触发':'启用自动探索后，插件在当日检查时进入','保存':'_工作台/探索/state.json和批次日志','日去重':'已完成、失败、结果未知的本日批次不重发','前置':'先固定当天历史引用，防止同日重复推荐'},
    ('discovery','score'):{'输入':'最多24候选，主摘选每条最多2400字符','模型':'轻处理连接；当前配置为DeepSeek路线，联网与筛选分别记用量','入选':'PASS、价值≥60、相关性≥6，且有具体增量或用途等条件','失败':'缺字段、越界或错误引用保留失败回执；不凑数'},
    ('reading','review'):{'触发':'手动生成AI精选；当前自动开关关闭','输入':'最多12篇，每篇前2400字符，附编号原文证据','输出':'判断、分数、理由、短导读、原文证据与用量','保护':'先提交started；失败/未知计日限额；保存失败只补首次结果'},
    ('reading','refs'):{'保存':'_工作台/state.json中的historyDays','内容':'材料身份、固定版本、推荐理由、日期，不复制正文','固定规则':'当日非空清单成功提交后固定；修改数量用于后续日期','恢复':'需保留完整同组阅读目录和索引，不能只恢复引用'},
    ('importing','save'):{'输入':'稳定身份、正文版本、首次原件与覆盖说明','顺序':'首次恢复记录 → 原件 → 正文 → 索引 → 清理恢复记录','保护':'null仅创建；已知旧内容原子比较后替换','失败':'保留实际已写文件及恢复记录，不伪造全部成功'},
    ('knowledge','queue'):{'保存':'知识接续/下的任务笔记与冻结正文；_工作台/知识接续/中的私有回执','绑定':'材料身份 + 版本 + 原件哈希 + Claudian会话','队列':'同一RAW任务结束后再提交下一篇；未发送可取消','保护':'有当前文字/图片草稿或回复进行中时等待'},
    ('knowledge','bridge'):{'前置':'内置历史适配版本，或确切当前版本和适配契约已验证','保存':'先保存会话绑定，再保存提交意图，最后原生发送','接口检查':'不发送消息、不证明模型连接与知识产物成功','未知':'已提交但结果未知不自动重发；重复点击复用原会话'},
    ('knowledge','observe'):{'已排队':'材料、原件、快照、接续笔记和队列意图已保存，尚未提交','已提交':'发送意图已保存，等待正式RAW回执','完成依据':'当前run正式事件、当前材料版本、同哈希原件与实际产物一致','不等同':'RAW已登记、等待讨论、Wiki已归纳、fanOS已晋升分别判断'},
    ('recovery','retention'):{'当前记录':'本地完整后台快照仍有5个版本','目标':'云端回读和逐文件核验成功后，保留两个不同版本各最新一份','云端':'历史依赖附件全部保留，不套用本地两版本规则','范围':'仅历史后台快照；不是完整Vault/源码备份，不提供云端采集'},
}
for chart in charts:
    for node in chart['nodes']:
        node['facts']=enrichment.get((chart['id'],node['id']),{})

COLORS = {'auto':('#edf5f2','#216957'),'manual':('#fff5e6','#9a6119'),'ai':('#f0edfa','#70529a'),'store':('#eaf2fc','#356495'),'guard':('#fbefef','#a65353')}
LABELS = {'auto':'自动 / 规则','manual':'你的操作 / 授权','ai':'模型参与','store':'保存的文件 / 状态','guard':'校验 / 保护'}

def render_svg(chart, *, public=False):
    header = 80 if public else 0
    width, height = 1230, (max(x['row'] for x in chart['nodes'])+1)*144+32+header
    positions={x['id']:(60+x['col']*395,28+header+x['row']*144) for x in chart['nodes']}
    elements=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-label="{html.escape(chart["title"])}" style="font-family:Microsoft YaHei,system-ui,sans-serif">',
              '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#91a4ad"/></marker></defs>']
    if public:
        elements += [
            f'<rect x="1" y="1" width="{width-2}" height="{height-2}" rx="18" fill="#f9fbfb" stroke="#cbd8d8"/>',
            '<path d="M 1 80 H 1229" stroke="#dbe5e5"/>',
            '<rect x="33" y="25" width="5" height="31" rx="2" fill="#317963"/>',
            f'<text x="53" y="48" font-size="24" font-weight="700" fill="#203c42">{html.escape(chart["title"])}</text>',
            '<text x="1182" y="47" text-anchor="end" font-size="14" font-weight="650" letter-spacing="2" fill="#4c6c6c">GUANLAN</text>',
        ]
    for edge in chart['edges']:
        rotation=''
        sx,sy=positions[edge['a']]; tx,ty=positions[edge['b']]
        if edge.get('route'):
            right=edge['route'] in ('right','near-right')
            outer=(sx+348 if edge['route']=='near-right' else 1210) if right else 20
            ax,bx=(sx+310,tx+310) if right else (sx,tx)
            ay,by=sy+46,ty+46
            if edge['route']=='near-right':
                d=f'M {ax} {ay} H {outer} V {by} H {bx}'
            else:
                ax=sx+155;ay=sy+92
                d=f'M {ax} {ay} V {ay+23} H {outer} V {by} H {bx}'
            lx,ly=outer+(-9 if right else 9),(ay+by)/2
            anchor='end' if right else 'start'
            if edge['route'] in ('left','right') or (public and edge['route']=='near-right'):
                lx=outer+(-13 if right else 13)
                anchor='middle'
                rotation=f' transform="rotate(-90 {lx} {ly})"'
            else:ly+=12
        else:
            if sy==ty:
                ax,ay=sx+310,sy+46;bx,by=tx,ty+46
                d=f'M {ax} {ay} H {bx}'
                lx,ly=(ax+bx)/2,ay-7;anchor='middle'
            else:
                ax,ay=sx+155,sy+92; bx,by=tx+155,ty
                mid=(ay+by)/2+edge.get('bend',0)
                d=f'M {ax} {ay} V {mid} H {bx} V {by}'
                lx,ly=(ax+bx)/2,mid-7; anchor='middle'
        elements.append(f'<path d="{d}" fill="none" stroke="#91a4ad" stroke-width="1.65" marker-end="url(#arrow)"/>')
        if edge['label']:
            elements.append(f'<text x="{lx}" y="{ly}"{rotation} text-anchor="{anchor}" font-size="12" fill="#536872" stroke="#fafcfb" stroke-width="5" paint-order="stroke">{html.escape(edge["label"])}</text>')
    keyboard = '' if public else ' tabindex="0" role="button"'
    cursor = '' if public else ' style="cursor:pointer"'
    for node in chart['nodes']:
        x,y=positions[node['id']]; bg,fg=COLORS[node['kind']]
        elements.append(f'<g class="flow-node" data-node="{node["id"]}"{keyboard} aria-label="{html.escape(node["title"])}"{cursor}><title>{html.escape(node["detail"])}</title><rect x="{x}" y="{y}" width="310" height="92" rx="13" fill="{bg}" stroke="{fg}" stroke-opacity="0.25"/><rect x="{x}" y="{y+19}" width="4" height="54" rx="2" fill="{fg}"/><text x="{x+19}" y="{y+35}" fill="{fg}" font-size="17" font-weight="650">{html.escape(node["title"])}</text><text x="{x+19}" y="{y+63}" fill="#4d6069" font-size="12.8">{html.escape(node["subtitle"])}</text></g>')
    elements.append('</svg>')
    return ''.join(elements)

if sys.argv[1:] == ['--public']:
    from public_reference import write_public_reference

    write_public_reference(charts, ROOT, OUT, render_svg)
    raise SystemExit(0)

raise SystemExit('Usage: python docs/workflow/generate.py --public')
