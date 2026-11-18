"""Generate public Markdown and SVGs from the original workflow graph."""

from copy import deepcopy
import os
from urllib.parse import quote

from public_english import CHARTS, EDGE_LABELS, NODES

# These fields in the original diagrams describe the maintainer's dated setup.
ZH_OVERRIDES = {
    ('overview', 'sub'): {
        'subtitle': '公众号 · YouTube · B站 · RSS',
        'detail': '在信源里维护来源、分类、检查间隔和启停。X 作为可选渠道在远眺里使用。',
    },
    ('overview', 'explore'): {
        'detail': '按兴趣和八个板块检索，用轻处理模型筛选。自动探索可启用，当天最多生成一批，默认最多推荐三条。',
    },
    ('overview', 'library'): {
        'title': 'Obsidian 阅读库',
        'subtitle': '你设置的库内相对目录',
    },
    ('subscriptions', 'yt'): {
        'detail': '配置并验证自己的 Key 后优先调用官方接口，失败时尝试频道 Atom 和同频道公开页。列表返回的是视频元数据。获取字幕走独立流程。',
    },
    ('subscriptions', 'sync'): {
        'subtitle': '启动、打开工作台、按同步间隔',
        'detail': '“检查并同步”发起到期来源及符合条件的网络故障来源检查，同时同步账本已有材料。等待本轮结束后再同步新增材料，最多跟踪三分钟，全程无需模型。',
    },
    ('discovery', 'web'): {
        'detail': '可选 DeepSeek 原生联网、无需检索 Key 的 Hacker News/GitHub 公开检索，或自行配置 Tavily。公开检索偏技术主题。',
    },
    ('recovery', 'retention'): {
        'detail': '云端回读和逐文件核验通过后，本机历史后台快照保留两个不同版本各最新一份。云端依赖单独保留，活跃运行数据和 Vault 在该规则范围之外。',
        'source': 'docs/backup-retention.md',
    },
}

ZH_FACTS = {
    ('subscriptions', 'sync'): {'触发': '启用同步后，启动插件、打开工作台和定时触发。默认间隔五分钟，也可手动操作'},
    ('discovery', 'day'): {'触发': '今天首次手动探索，或启用自动探索后到达当日检查时机'},
    ('discovery', 'score'): {'模型': '使用配置的轻处理连接。DeepSeek 原生联网与模型筛选分别记录用量'},
    ('reading', 'review'): {'触发': '手动生成，或主动启用自动 AI 精选后按每日限额触发'},
}
ZH_OMIT_FACTS = {('recovery', 'retention'): {'当前记录'}}
ZH_NOTES = {
    'subscriptions': [
        '“同步已采集材料”读后台账本。“检查并同步”衔接本轮采集与同步。“立即检查更新”会显式检查已保存的启用来源。',
        '来源识别、保存配置、读取条目、取得正文和 Vault 同步分别留有结果。',
    ],
    'discovery': [
        '探索推荐默认最多三条，拾遗默认两项，今日选读默认最多三篇，分别计算。',
        '免费 X 无数据 API 费。模型联网和筛选各自计量。模型结果未知时保留原批次，后续可以核对落盘记录。',
    ],
}
EN_NOTES = {
    'overview': [
        'Collection requires an awake computer and running service. Plugin discovery and new knowledge submissions require Obsidian to be open.',
    ],
    'subscriptions': [
        'Source identification, saving the configuration, collecting entries, obtaining verified text, and syncing to the Vault each have their own outcome.',
        'Sync collected items reads the ledger. Check and sync also starts a check of due and eligible network-failed sources. Check now explicitly checks saved enabled sources.',
    ],
    'discovery': [
        'Discovery defaults to three picks, Rediscover to two picks, and Today’s Reading to three items. Each has its own setting.',
        'Free X has no data API charge. Search and scoring can use paid model tokens.',
    ],
    'reading': [
        'The daily guide threshold is 40. Discovery requires a value score of at least 60 and additional relevance and evidence checks.',
        'Rediscover makes no model calls and keeps its saved daily list fixed. Trash retains underlying files.',
    ],
    'importing': [
        'Video entries, transcript coverage, and completed knowledge tasks each have their own result. Captions supply text and leave visual context unexamined.',
        'Switching folders opens a separate library. Move materials, indexes, trash state, and downstream references together during an explicit migration.',
        'Manual RAW preparation produces a staging file. Formal RAW registration and Wiki completion are separate operations.',
    ],
    'knowledge': [
        'Each milestone has its own evidence, from interface verification and send intent to RAW registration, Wiki synthesis, and promotion.',
        'The first recovery round reads a verified prior receipt. It clears unsent direct synthesis intent. Synthesis then needs a new instruction.',
        'An unconfirmed submission stays recorded. After reopening Obsidian, only authorized unsent work in the current library resumes.',
    ],
    'recovery': [
        'The three lanes can run independently. Service readiness, installed plugin state, and backup verification each have their own evidence.',
        'The documented setup collects locally while the machine is awake. Video text uses public captions or a supplied transcript. Wiki updates use explicit handoff.',
    ],
}

CONTRACTS = {
    'overview': [
        ('docs/architecture.md', '进程与存储边界', 'Process and storage boundaries'),
        ('docs/first-release.md', '实现范围', 'Implemented capabilities'),
    ],
    'subscriptions': [
        ('docs/collection-setup.md', '信源、采集与重试', 'Sources, collection, and retry'),
        ('src/server/subscriptions.ts', '来源调度与验证', 'Source scheduling and verification'),
        ('src/core/subscription-refresh.ts', '检查并同步', 'Check and sync'),
        ('src/core/library.ts', '逐页提交', 'Per-page commit'),
    ],
    'discovery': [
        ('docs/active-exploration.md', '供给、排序及日批次', 'Supply, scoring, and daily runs'),
        ('src/core/exploration-scoring.ts', '评分校验', 'Score validation'),
        ('src/server/exploration-evidence.ts', '外链取证', 'External evidence'),
    ],
    'reading': [
        ('docs/history-highlights.md', '历史精选、版本引用和轮换', 'Historical rotation and version references'),
        ('src/core/daily.ts', '每日规则选读与导读', 'Daily shortlist and guides'),
        ('src/core/library.ts', '阅读索引和回收站', 'Reading index and trash'),
    ],
    'importing': [
        ('docs/integration-guide.md', '导入、同步与字幕 HTTP 契约', 'Import, sync, and captions HTTP contracts'),
        ('src/server/feed-fetch.ts', '订阅读取', 'Feed transport'),
        ('src/core/library.ts', '版本与写入保护', 'Versioning and write protection'),
    ],
    'knowledge': [
        ('docs/knowledge-integration.md', 'RAW、Wiki、恢复与晋升', 'RAW, Wiki, recovery, and promotion'),
        ('src/core/knowledge.ts', '回执与产物校验', 'Receipt and output verification'),
        ('src/plugin/claudian.ts', 'Claudian 接口适配', 'Claudian adapter'),
    ],
    'recovery': [
        ('docs/operator-runbook.md', '本机运维', 'Local operation'),
        ('docs/plugin-updates.md', '插件安装与更新', 'Plugin installation and updates'),
        ('docs/backup-retention.md', '私有归档与轮换', 'Private archive and rotation'),
    ],
}


def link(path, label, output, root):
    relative = os.path.relpath(root / path, output).replace(os.sep, '/')
    return f'[{label}]({quote(relative, safe="/._-")})'


def public_charts(original, english):
    charts = deepcopy(original)
    for chart in charts:
        chart_id = chart['id']
        chart['notes'] = EN_NOTES[chart_id] if english else ZH_NOTES.get(chart_id, chart['notes'])
        if english:
            chart['title'], chart['subtitle'] = CHARTS[chart_id]
            assert set(NODES[chart_id]) == {node['id'] for node in chart['nodes']}, chart_id
        for node in chart['nodes']:
            node_id = node['id']
            key = chart_id, node_id
            node.update(ZH_OVERRIDES.get(key, {}))
            if english:
                node['title'], node['subtitle'], node['detail'] = NODES[chart_id][node_id]
                node['facts'] = {}  # Translated facts are incorporated into the descriptions.
            else:
                if node['source'] == 'README.md':
                    node['source'] = 'README.zh-CN.md'
                node['detail'] = node['detail'].replace('当前自动开关关闭', '自动模式默认关闭').replace('自动AI精选当前关闭', '自动 AI 精选默认关闭')
                node['subtitle'] = node['subtitle'].replace('当前自动开关关闭', '自动模式默认关闭').replace('；', '，')
                node['facts'].update(ZH_FACTS.get(key, {}))
                for field in ZH_OMIT_FACTS.get(key, ()):
                    del node['facts'][field]
        for edge in chart['edges']:
            if english and edge['label']:
                edge['label'] = EDGE_LABELS[edge['label']]
            elif edge['label'] == '启动 / 打开 / 每5分钟同步':
                edge['label'] = '启动 / 打开 / 定时同步'
            elif edge['label'] == '选择收录；已有正文则复用':
                edge['label'] = '选择收录或复用'

    return charts


def write_public_reference(original, root, workflow_dir, render_svg):
    for lang in ('zh-CN', 'en'):
        english = lang == 'en'
        charts = public_charts(original, english)
        output = workflow_dir / 'public' / lang
        output.mkdir(parents=True, exist_ok=True)
        title = 'Guanlan workflow reference' if english else '观澜完整工作流与技术说明'
        back = link('README.md' if english else 'README.zh-CN.md', 'Project README' if english else '返回项目 README', output, root)
        switch = '[简体中文](../zh-CN/README.md)' if english else '[English](../en/README.md)'
        legend = (
            'Green marks automatic or rule-based steps. Gold is user input or permission, purple is model work, blue is persistence, and red is verification or a safeguard.'
            if english else '绿色表示自动或规则步骤，金色表示用户操作或授权，紫色表示模型参与，蓝色表示保存，红色表示核验或保护。'
        )
        intro = (
            'These diagrams describe the v0.22.5 design. Click through to the contracts for the behavior of each module. Default settings and optional paths are shown in the steps.'
            if english else '七张图展示 v0.22.5 的设计。每一步旁边附有契约或源码，可核对输入、输出、留存文件和失败后的处理。'
        )
        lines = [f'# {title}', '', f'{back} · {switch}', '', intro, '', legend, '',
                 ' · '.join(f'[{chart["title"]}](#{chart["id"]})' for chart in charts), '']
        for chart in charts:
            chart_id = chart['id']
            nodes = chart['nodes']
            ids = {node['id'] for node in nodes}
            assert len(ids) == len(nodes), chart_id
            assert all(edge['a'] in ids and edge['b'] in ids for edge in chart['edges']), chart_id
            assert all((root / node['source']).is_file() for node in nodes), chart_id
            (output / f'{chart_id}.svg').write_text(render_svg(chart, public=True), encoding='utf-8')
            lines += [
                f'<a name="{chart_id}"></a>', '', f'## {chart["title"]}', '',
                chart['subtitle'], '',
                f'[![{chart["title"]}]({chart_id}.svg)]({chart_id}.svg)', '',
            ]
            lines += [f'- {note}' for note in chart['notes']] + ['']
            lines += [f'### {"Steps" if english else "逐步说明"}', '']
            for node in nodes:
                source = link(node['source'], 'Reference' if english else '实现依据', output, root)
                lines.append(f'- **{node["title"]}** · {node["detail"]} {source}')
                for key, value in node['facts'].items():
                    lines.append(f'  - **{key}** {value}')
            lines += ['', ' · '.join(
                link(path, en_label if english else zh_label, output, root)
                for path, zh_label, en_label in CONTRACTS[chart_id]
            ), '']
        (output / 'README.md').write_text('\n'.join(lines), encoding='utf-8')
        print(f'{lang}: {len(charts)} diagrams, {sum(len(chart["nodes"]) for chart in charts)} steps')
