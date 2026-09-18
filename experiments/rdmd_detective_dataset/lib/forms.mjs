import { SCHEMA } from './graph.mjs';

const MIN_HOP = SCHEMA.minHopToFirstEffect || 3;

function F(id, gold, far, repair) {
  return { id, gold, far, repair: repair || null };
}

const CATALOG = {
  research: {
    missing_dependency: [
      F('skip_source_grade',
        (n, c) => ({
          inputs: `${c.topic}公开网页摘录，未接入来源分级结果`,
          artifact: `${c.topic}-未分级摘录`,
          output: `直接把检索到的公开说法写进「${n.title}」，没有等来源分级。`,
          summary: `证据还没分可靠度就开始往下写，后面容易把二手传闻当成主结论。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-混级证据`,
          output: `「${n.title}」把未分级摘录写进发现，主结论和传闻挤在同一段。`,
          summary: `对外表述没有把一手核实和转述新闻拆开。`,
        })),
      F('skip_window_check',
        (n, c) => ({
          inputs: `只拿到检索策略，缺数据窗口确认`,
          artifact: `${c.topic}-窗口未核`,
          output: `在「${n.title}」里按默认近年往下写，没有核观察年。`,
          summary: `时间边界没钉死就继续，后面数字会对不齐。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-跨年混算`,
          output: `「${n.title}」把不同年份的份额加在同一张表里。`,
          summary: `结论段的时间口径互相打架。`,
        })),
    ],
    wrong_agent: [
      F('intern_takes_interview',
        (n, c) => ({
          agentId: `${c.domain}_intern_scribe`,
          artifact: `${c.topic}-实习生纪要`,
          output: `访谈改由记录员整理，只留下口号式原话。`,
          summary: `没有行业研究员追问口径，纪要偏短、缺反例。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-浅层引述`,
          output: `「${n.title}」只能引用纪要里的口号，补不上机制解释。`,
          summary: `结论停留在「受访者表示」，缺可核证据。`,
        })),
      F('pr_rewrites_findings',
        (n, c) => ({
          agentId: `${c.domain}_comms_editor`,
          artifact: `${c.topic}-对外口径稿`,
          output: `发现摘要改由传播编辑按亮点重写。`,
          summary: `限制条件和异议被收进脚注，主文只留好消息。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-亮点结论`,
          output: `「${n.title}」沿用亮点稿，把限制条件从正文拿掉。`,
          summary: `对外结论比证据更满。`,
        })),
    ],
    wrong_version: [
      F('year_window',
        (n, c) => ({
          version: '2019-window',
          artifact: `${c.topic}-2019快照`,
          output: `检索窗口停在 2019–2021，未切到当前观察年。`,
          summary: `格局数字来自旧年，后面若当现状用会漂。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-过期格局`,
          output: `「${n.title}」把旧年份额写成当前判断。`,
          summary: `交付口径还在复述过期观察年。`,
        })),
      F('preprint_not_final',
        (n, c) => ({
          version: 'preprint-only',
          artifact: `${c.topic}-预印本摘录`,
          output: `引用停在预印本，未换已发表修订。`,
          summary: `关键数字可能已被作者勘误。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-未勘误引用`,
          output: `「${n.title}」仍引用预印本里的旧系数。`,
          summary: `参考文献和正文数字对不上终稿。`,
        })),
    ],
    wrong_acceptance: [
      F('single_source_ok',
        (n, c) => ({
          acceptance: 'single-source',
          artifact: `${c.topic}-单源通过`,
          output: `一条媒体报道即视为交叉验证完成。`,
          summary: `独立来源门槛被放掉。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-单源结论`,
          output: `「${n.title}」把单篇报道升成行业判断。`,
          summary: `没有第二来源仍对外陈述。`,
        })),
      F('skip_dissent',
        (n, c) => ({
          acceptance: 'no-dissent-log',
          artifact: `${c.topic}-无异议稿`,
          output: `异议记录改成可选项，主结论直接过。`,
          summary: `反例不再挡住定稿。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-单边结论`,
          output: `「${n.title}」删掉反对证据，只保留顺向引用。`,
          summary: `预审看不到争议点。`,
        })),
    ],
    local_replan: [
      F('desk_research_only',
        (n, c) => ({
          artifact: `${c.topic}-桌面替代访谈`,
          output: `原定一手访谈改成再搜一轮公开稿。`,
          summary: `现场改计划：用二手综述顶替访谈。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-无一手结论`,
          output: `「${n.title}」只能引用公开稿，没有受访者原话。`,
          summary: `机制解释停在转述。`,
        }),
        (n, c) => repair(n, c, '补公开综述', '把桌面材料接回主结论')),
      F('cut_appendix',
        (n, c) => ({
          artifact: `${c.topic}-附录压缩`,
          output: `附录材料改成三页摘录，原始表不随文。`,
          summary: `为赶交付把附件临时砍短。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-不可复核附件`,
          output: `「${n.title}」给不出原始表，只能看摘录。`,
          summary: `外部无法按原数复核。`,
        }),
        (n, c) => repair(n, c, '补摘录索引', '把压缩附录挂回交付包')),
    ],
  },
  data: {
    missing_dependency: [
      F('skip_schema_check',
        (n, c) => ({
          inputs: `原始表直出，未接字段字典`,
          artifact: `${c.topic}-未核字段`,
          output: `清洗按列名猜测含义，没有等数据字典。`,
          summary: `同名异义字段会混进下游。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-混义特征`,
          output: `「${n.title}」把两套同名列拼成一列特征。`,
          summary: `发布集里的口径已经拧了。`,
        })),
      F('skip_null_policy',
        (n, c) => ({
          inputs: `清洗规则在，缺缺失值策略`,
          artifact: `${c.topic}-空值未策`,
          output: `空值按 0 填，没有等缺失值处理约定。`,
          summary: `真实缺失和零值混在一起。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-零值污染`,
          output: `「${n.title}」把填零后的列当成完整观测。`,
          summary: `校验通过率被空值填零抬高。`,
        })),
    ],
    wrong_agent: [
      F('bi_does_pipeline',
        (n, c) => ({
          agentId: `${c.domain}_bi_analyst`,
          artifact: `${c.topic}-报表师清洗`,
          output: `管道改由报表分析师在表格里手工改。`,
          summary: `没有数据工程师管重放和血缘。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-不可重放表`,
          output: `「${n.title}」只能交出一版手工表，没有任务日志。`,
          summary: `别人无法按同一脚本重生。`,
        })),
      F('vendor_ops_maps',
        (n, c) => ({
          agentId: `${c.domain}_vendor_ops`,
          artifact: `${c.topic}-供应商映射`,
          output: `字段映射改由供应商值班按经验对。`,
          summary: `枚举值没有进版本库。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-口头枚举`,
          output: `「${n.title}」沿用值班口头映射，对不上字典。`,
          summary: `发布说明写不清编码含义。`,
        })),
    ],
    wrong_version: [
      F('schema_freeze',
        (n, c) => ({
          version: 'schema-2023q4',
          artifact: `${c.topic}-2023Q4字典`,
          output: `仍按上年末字典解析，未切当前字段。`,
          summary: `新列会被丢掉或进溢出桶。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-旧字典产物`,
          output: `「${n.title}」缺失今年新增字段，却标成完整集。`,
          summary: `下游按新字典读会空列。`,
        })),
      F('tz_offset_old',
        (n, c) => ({
          version: 'tz-utc8-fixed',
          artifact: `${c.topic}-旧时区切片`,
          output: `日期切分仍固定东八，未跟源库时区。`,
          summary: `跨日记录会划错账期。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-错期汇总`,
          output: `「${n.title}」把跨日订单算进前一账期。`,
          summary: `对账数字和财务日切不一致。`,
        })),
    ],
    wrong_acceptance: [
      F('rowcount_only',
        (n, c) => ({
          acceptance: 'rowcount-ok',
          artifact: `${c.topic}-行数绿灯`,
          output: `行数对齐即通过，不查主键冲突。`,
          summary: `重复键被行数掩盖。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-重复键集`,
          output: `「${n.title}」把重复主键当合法观测发出去。`,
          summary: `特征表在实体粒度上已经炸了。`,
        })),
      F('null_rate_loose',
        (n, c) => ({
          acceptance: 'null-30pct',
          artifact: `${c.topic}-空值过宽`,
          output: `空值率放到 30% 仍算合格。`,
          summary: `关键列大面积空仍能过。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-空洞特征`,
          output: `「${n.title}」把高空值列标成可用特征。`,
          summary: `模型侧会当成有信号。`,
        })),
    ],
    local_replan: [
      F('drop_join_key',
        (n, c) => ({
          artifact: `${c.topic}-去主键拼接`,
          output: `关联改成按日期模糊匹配，不再等主键对齐。`,
          summary: `现场改成能出数的宽表。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-一对多宽表`,
          output: `「${n.title}」行数膨胀，实体对不回源表。`,
          summary: `发布集无法按主键对账。`,
        }),
        (n, c) => repair(n, c, '补模糊匹配说明', '把临时拼接规则写进发布注记')),
      F('sample_then_ship',
        (n, c) => ({
          artifact: `${c.topic}-抽样发布`,
          output: `全量跑不动，改抽 10% 先发布。`,
          summary: `把抽样临时当成正式集。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-偏样本`,
          output: `「${n.title}」按 10% 样本写覆盖率，当成全集。`,
          summary: `统计量对不上业务总量。`,
        }),
        (n, c) => repair(n, c, '补抽样权重', '给抽样集挂上回总体的权重')),
    ],
  },
  writing: {
    missing_dependency: [
      F('draft_without_outline',
        (n, c) => ({
          inputs: `${c.topic}素材堆，未接提纲`,
          artifact: `${c.topic}-无提纲草稿`,
          output: `正文直接起稿，没有等提纲锁结构。`,
          summary: `章节会在后面对不齐论点。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-散装正文`,
          output: `「${n.title}」段落跳切，论点和小标题对不上。`,
          summary: `定稿读起来像素材粘贴。`,
        })),
      F('polish_without_evidence',
        (n, c) => ({
          inputs: `只拿到语言偏好，缺证据段`,
          artifact: `${c.topic}-空论据润色`,
          output: `润色先把句子写满，证据还没补。`,
          summary: `流畅度上去了，可核事实没有。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-光滑空论`,
          output: `「${n.title}」读着通顺，但关键句没有出处。`,
          summary: `定稿无法过事实核验。`,
        })),
    ],
    wrong_agent: [
      F('sales_writes_body',
        (n, c) => ({
          agentId: `${c.domain}_sales_writer`,
          artifact: `${c.topic}-销售口吻稿`,
          output: `正文改由销售执笔，证据让位给话术。`,
          summary: `限制条件被写成「可灵活处理」。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-话术定稿`,
          output: `「${n.title}」把话术句留在结论里。`,
          summary: `对外文本不像核过的报告。`,
        })),
      F('model_paraphrase',
        (n, c) => ({
          agentId: `${c.domain}_paraphrase_bot`,
          artifact: `${c.topic}-改写稿`,
          output: `论据整理改成模型改写，不核对原句。`,
          summary: `数字和条件容易在改写里丢。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-改写失真`,
          output: `「${n.title}」里的数字已经和素材对不上。`,
          summary: `润色前需要先回源，但没回。`,
        })),
    ],
    wrong_version: [
      F('old_brief',
        (n, c) => ({
          version: 'brief-q1',
          artifact: `${c.topic}-Q1简报`,
          output: `提纲仍按一季度简报，未换最新口径。`,
          summary: `后面章节会写错当期重点。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-过期提纲稿`,
          output: `「${n.title}」还在回答上季度的问题。`,
          summary: `标题和当期任务错位。`,
        })),
      F('style_guide_v1',
        (n, c) => ({
          version: 'style-v1',
          artifact: `${c.topic}-旧体例`,
          output: `仍用已废止的标题层级和术语表。`,
          summary: `术语会和下一段新规范撞车。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-混用术语`,
          output: `「${n.title}」同一概念用了两套叫法。`,
          summary: `定稿体例不统一。`,
        })),
    ],
    wrong_acceptance: [
      F('page_count_only',
        (n, c) => ({
          acceptance: 'pages-ok',
          artifact: `${c.topic}-页数通过`,
          output: `页数够了就算过，不再查每段是否有证。`,
          summary: `注水段落可以过关。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-注水定稿`,
          output: `「${n.title}」用空段凑页，关键主张仍无出处。`,
          summary: `看起来完整，核验会失败。`,
        })),
      F('tone_over_fact',
        (n, c) => ({
          acceptance: 'tone-first',
          artifact: `${c.topic}-语气优先`,
          output: `只要语气稳就过，事实冲突不拦。`,
          summary: `前后数字可以不一致。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-自相矛盾稿`,
          output: `「${n.title}」摘要和正文数字互相打架。`,
          summary: `语言顺，事实不顺。`,
        })),
    ],
    local_replan: [
      F('bullet_dump',
        (n, c) => ({
          artifact: `${c.topic}-要点堆`,
          output: `写不下完整段，改成要点列表交差。`,
          summary: `论证链被临时拆成条目。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-无论证定稿`,
          output: `「${n.title}」只剩条目，读不出因果。`,
          summary: `不像报告，像备忘。`,
        }),
        (n, c) => repair(n, c, '补条目间因果', '把列表重新串回段落提纲')),
      F('reuse_old_chapter',
        (n, c) => ({
          artifact: `${c.topic}-旧章粘贴`,
          output: `缺的章节直接贴上期报告。`,
          summary: `用旧章顶工期。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-混期正文`,
          output: `「${n.title}」出现上期机构名和当期数字。`,
          summary: `读者会对时间线产生错觉。`,
        }),
        (n, c) => repair(n, c, '标旧章来源', '给粘贴章节加上期注记')),
    ],
  },
  ppt: {
    missing_dependency: [
      F('slides_before_findings',
        (n, c) => ({
          inputs: `只有结构草图，缺关键结论`,
          artifact: `${c.topic}-空结论页`,
          output: `先画页面，结论句还没抽出来。`,
          summary: `图表会先于判断出现。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-装饰性页`,
          output: `「${n.title}」页面好看，但标题句没有判断。`,
          summary: `讲稿只能念装饰性句子。`,
        })),
      F('visual_without_data',
        (n, c) => ({
          inputs: `视觉规范在，缺可画的数`,
          artifact: `${c.topic}-示意柱`,
          output: `图表用示意数据先占位。`,
          summary: `后面容易把示意当成真数。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-示意定稿`,
          output: `「${n.title}」把占位柱状图留在终稿。`,
          summary: `观众会按假数提问。`,
        })),
    ],
    wrong_agent: [
      F('designer_owns_story',
        (n, c) => ({
          agentId: `${c.domain}_visual_designer`,
          artifact: `${c.topic}-视觉主导稿`,
          output: `结构改由视觉设计按版式排，故事让位。`,
          summary: `关键句被缩成装饰标题。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-版式故事`,
          output: `「${n.title}」标题漂亮，信息层级乱。`,
          summary: `讲者找不到该停的页。`,
        })),
      F('exec_ghostwrite',
        (n, c) => ({
          agentId: `${c.domain}_exec_ghost`,
          artifact: `${c.topic}-领导口吻页`,
          output: `讲稿改成领导常用句，证据页后置。`,
          summary: `数字服务于金句。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-金句稿`,
          output: `「${n.title}」金句和图表对不上。`,
          summary: `Q&A 会被追问出处。`,
        })),
    ],
    wrong_version: [
      F('old_template',
        (n, c) => ({
          version: 'template-2022',
          artifact: `${c.topic}-旧母版`,
          output: `仍用已停用的母版色和页码规则。`,
          summary: `和现行品牌页对不上。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-混母版稿`,
          output: `「${n.title}」封面新、内页旧。`,
          summary: `视觉检查过不了。`,
        })),
      F('last_quarter_charts',
        (n, c) => ({
          version: 'charts-q4',
          artifact: `${c.topic}-上季图`,
          output: `图表直接沿用上季文件。`,
          summary: `坐标轴还是上季口径。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-错季图`,
          output: `「${n.title}」口头说本期，图还是上季。`,
          summary: `排练时一定会撞车。`,
        })),
    ],
    wrong_acceptance: [
      F('pretty_enough',
        (n, c) => ({
          acceptance: 'looks-fine',
          artifact: `${c.topic}-观感通过`,
          output: `对齐和留白过了就过，不再核数字。`,
          summary: `错轴也可以过。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-错轴终稿`,
          output: `「${n.title}」图轴截断，差异被放大。`,
          summary: `视觉检查当内容检查了。`,
        })),
      F('no_speaker_notes',
        (n, c) => ({
          acceptance: 'no-notes',
          artifact: `${c.topic}-无讲稿页`,
          output: `没有讲稿要点也能过。`,
          summary: `排练只能临场编。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-空讲稿`,
          output: `「${n.title}」页面在，讲者不知道停哪里。`,
          summary: `彩排会超时或漏点。`,
        })),
    ],
    local_replan: [
      F('screenshot_dump',
        (n, c) => ({
          artifact: `${c.topic}-截图拼页`,
          output: `来不及重绘，把表格截图贴进幻灯。`,
          summary: `字号和对比度都不管了。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-不可读图`,
          output: `「${n.title}」后排看不清截图字。`,
          summary: `演示中只能口头念数。`,
        }),
        (n, c) => repair(n, c, '重排关键数', '把截图里的关键数抄回大字标题')),
      F('cut_to_ten',
        (n, c) => ({
          artifact: `${c.topic}-十页压缩`,
          output: `时长不够，临时砍到十页。`,
          summary: `证据页被整页丢掉。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-无证据演示`,
          output: `「${n.title}」只剩主张页，图和出处都没了。`,
          summary: `问答会空。`,
        }),
        (n, c) => repair(n, c, '附录备份页', '把砍掉的证据放进不投屏附录')),
    ],
  },
  code: {
    missing_dependency: [
      F('impl_without_api',
        (n, c) => ({
          inputs: `需求备忘，未接接口约定`,
          artifact: `${c.topic}-私有形状`,
          output: `核心逻辑按猜测的字段开写，没有等接口设计。`,
          summary: `返回形会和调用方拧。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-错形实现`,
          output: `「${n.title}」按私有字段测过了，对接时对不上。`,
          summary: `评审只能看到能跑的错契约。`,
        })),
      F('merge_without_tests',
        (n, c) => ({
          inputs: `实现在，测试任务未完成`,
          artifact: `${c.topic}-无测合入`,
          output: `合并发布不等测试补齐。`,
          summary: `回归缺口会进主线。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-裸合入`,
          output: `「${n.title}」把无回归的改动标成可发布。`,
          summary: `线上行为只能靠运气。`,
        })),
    ],
    wrong_agent: [
      F('intern_owns_api',
        (n, c) => ({
          agentId: `${c.domain}_intern_dev`,
          artifact: `${c.topic}-实习生接口`,
          output: `接口设计改由实习生按示例抄。`,
          summary: `错误码和幂等没有设计。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-示例契约`,
          output: `「${n.title}」只覆盖了示例路径，边界全空。`,
          summary: `评审会卡在契约不全。`,
        })),
      F('pm_patches_code',
        (n, c) => ({
          agentId: `${c.domain}_pm_hotfix`,
          artifact: `${c.topic}-产品热修`,
          output: `核心逻辑改由产品在配置里热修。`,
          summary: `行为不在代码评审范围内。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-配置行为`,
          output: `「${n.title}」测试按代码写，运行看配置。`,
          summary: `发布说明写不清真实分支。`,
        })),
    ],
    wrong_version: [
      F('api_pin',
        (n, c) => ({
          version: 'api-v1-frozen',
          artifact: `${c.topic}-v1字段`,
          output: `实现钉死 v1 字段，未切到现行契约。`,
          summary: `新必填项会被丢掉。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-旧契约包`,
          output: `「${n.title}」请求缺现行必填，却当成功。`,
          summary: `联调会在网关被拒。`,
        })),
      F('lib_old_minor',
        (n, c) => ({
          version: 'lib-2.4.1',
          artifact: `${c.topic}-旧库调用`,
          output: `依赖仍锁在已宣布弃用的次版本。`,
          summary: `安全补丁和崩更行为都不在。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-弃用调用`,
          output: `「${n.title}」测试过的是弃用 API。`,
          summary: `发布环境若升库就会裂。`,
        })),
    ],
    wrong_acceptance: [
      F('happy_path_only',
        (n, c) => ({
          acceptance: 'happy-path',
          artifact: `${c.topic}-主路径绿`,
          output: `主路径通过即合入，错误码不测。`,
          summary: `失败分支可以是空的。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-无失败语义`,
          output: `「${n.title}」把超时也当成功展示。`,
          summary: `调用方无法区分失败。`,
        })),
      F('coverage_number',
        (n, c) => ({
          acceptance: 'coverage-60',
          artifact: `${c.topic}-覆盖率过线`,
          output: `行覆盖 60% 即过，不看分支。`,
          summary: `关键分支可以零覆盖。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-假绿测试`,
          output: `「${n.title}」报告全绿，权限分支没测到。`,
          summary: `评审被覆盖率数字挡住。`,
        })),
    ],
    local_replan: [
      F('hardcode_flag',
        (n, c) => ({
          artifact: `${c.topic}-硬编码开关`,
          output: `来不及做配置，在代码里写死特性开关。`,
          summary: `现场用常量顶配置中心。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-环境绑死`,
          output: `「${n.title}」在预发和线上行为不一致。`,
          summary: `回滚只能再改代码。`,
        }),
        (n, c) => repair(n, c, '抽出开关常量', '把硬编码接到现有配置项')),
      F('skip_review_hotfix',
        (n, c) => ({
          artifact: `${c.topic}-热修合入`,
          output: `评审窗口不够，热修直接进发布。`,
          summary: `用事后补评顶流程。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-未评发布`,
          output: `「${n.title}」把热修当成已评改动。`,
          summary: `变更记录是假的。`,
        }),
        (n, c) => repair(n, c, '补事后评审单', '给热修补一页变更说明')),
    ],
  },
  review: {
    missing_dependency: [
      F('mark_without_checklist',
        (n, c) => ({
          inputs: `材料在，对照清单未到`,
          artifact: `${c.topic}-无清单批注`,
          output: `凭印象标风险，没有等对照清单。`,
          summary: `漏项不会被清单抓住。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-印象结论`,
          output: `「${n.title}」风险表和清单对不上号。`,
          summary: `出具结论缺追踪项。`,
        })),
      F('conclude_without_rework',
        (n, c) => ({
          inputs: `风险在，修改还未回`,
          artifact: `${c.topic}-未复核结论`,
          output: `直接出具结论，不等复核修改。`,
          summary: `未关闭项会被写成已处理。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-假关闭`,
          output: `「${n.title}」把未回改的项标成通过。`,
          summary: `归档状态是错的。`,
        })),
    ],
    wrong_agent: [
      F('author_self_review',
        (n, c) => ({
          agentId: `${c.domain}_author_self`,
          artifact: `${c.topic}-作者自审`,
          output: `对照清单改由原作者自己勾。`,
          summary: `独立性没了。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-自批通过`,
          output: `「${n.title}」风险项被作者解释掉。`,
          summary: `结论没有第二双眼睛。`,
        })),
      F('intern_ticks',
        (n, c) => ({
          agentId: `${c.domain}_intern_checker`,
          artifact: `${c.topic}-勾选表`,
          output: `风险标注改由实习生按字面勾。`,
          summary: `实质风险不会被写成问题。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-表面通过`,
          output: `「${n.title}」清单全绿，正文里的实质冲突还在。`,
          summary: `复核只能重复勾选。`,
        })),
    ],
    wrong_version: [
      F('old_checklist',
        (n, c) => ({
          version: 'checklist-2022',
          artifact: `${c.topic}-旧清单`,
          output: `对照仍用已废止的清单条款。`,
          summary: `新风险类不会被标出。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-漏新条款`,
          output: `「${n.title}」没查现行条款，却出了无新风险的结论。`,
          summary: `归档会和现行制度冲突。`,
        })),
      F('old_severity',
        (n, c) => ({
          version: 'sev-v1',
          artifact: `${c.topic}-旧分级`,
          output: `严重级仍按旧三级，未用现行四级。`,
          summary: `该升级的项还停在提示。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-低报风险`,
          output: `「${n.title}」把应阻断项写成提示。`,
          summary: `结论过轻。`,
        })),
    ],
    wrong_acceptance: [
      F('fix_promised',
        (n, c) => ({
          acceptance: 'promise-ok',
          artifact: `${c.topic}-口头即过`,
          output: `作者答应改就算关闭。`,
          summary: `没有回改证据也能过。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-口头关闭`,
          output: `「${n.title}」关闭单上没有补丁或修订页。`,
          summary: `出具结论建立在承诺上。`,
        })),
      F('nits_only',
        (n, c) => ({
          acceptance: 'nits-pass',
          artifact: `${c.topic}-仅排版`,
          output: `只拦错别字，实质风险不当阻断。`,
          summary: `内容问题可以过。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-排版结论`,
          output: `「${n.title}」只留下格式意见。`,
          summary: `真正该拦的项不在结论里。`,
        })),
    ],
    local_replan: [
      F('sample_review',
        (n, c) => ({
          artifact: `${c.topic}-抽页评审`,
          output: `材料太长，改抽 20% 页评审。`,
          summary: `用抽样顶全量对照。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-未覆盖结论`,
          output: `「${n.title}」按抽样页出具全量通过。`,
          summary: `未看部分被当成无问题。`,
        }),
        (n, c) => repair(n, c, '标明抽样范围', '结论改写为仅覆盖抽到的页')),
      F('defer_blockers',
        (n, c) => ({
          artifact: `${c.topic}-阻断后置`,
          output: `阻断项改成下轮再看，本轮先过。`,
          summary: `用延期顶关闭。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-带伤通过`,
          output: `「${n.title}」把未关闭阻断写成通过。`,
          summary: `后续轮次不一定真开。`,
        }),
        (n, c) => repair(n, c, '开遗留票', '给后置项补跟踪编号')),
    ],
  },
  ops: {
    missing_dependency: [
      F('ship_without_env',
        (n, c) => ({
          inputs: `发布包在，环境清单未完成`,
          artifact: `${c.topic}-环境未核`,
          output: `配置发布不等环境准备完成。`,
          summary: `密钥和配额可能还是旧的。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-错环境放量`,
          output: `「${n.title}」把旧环境上的绿灯当成新环境健康。`,
          summary: `灰度观察会看错对象。`,
        })),
      F('full_without_canary',
        (n, c) => ({
          inputs: `配置在，灰度观察未出`,
          artifact: `${c.topic}-无灰度放量`,
          output: `直接放量，没有等灰度窗口。`,
          summary: `故障面从一小撮变成全体。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-全量暴露`,
          output: `「${n.title}」把首批错误当成偶发，继续全量。`,
          summary: `回滚窗口被自己吃掉。`,
        })),
    ],
    wrong_agent: [
      F('dev_oncall',
        (n, c) => ({
          agentId: `${c.domain}_dev_oncall`,
          artifact: `${c.topic}-开发值班`,
          output: `发布配置改由开发值班按感觉改。`,
          summary: `没有发布经理盯窗口和检查单。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-即兴发布`,
          output: `「${n.title}」变更没有发布时间线。`,
          summary: `复盘对不上操作人。`,
        })),
      F('vendor_restart',
        (n, c) => ({
          agentId: `${c.domain}_vendor_ops`,
          artifact: `${c.topic}-供应商重启`,
          output: `故障收集改成供应商重启服务。`,
          summary: `根因被重启盖住。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-无根因复盘`,
          output: `「${n.title}」只记录重启成功。`,
          summary: `同类故障还会来。`,
        })),
    ],
    wrong_version: [
      F('old_chart',
        (n, c) => ({
          version: 'chart-1.12',
          artifact: `${c.topic}-旧部署图`,
          output: `仍按旧 chart 值发布，未切现行清单。`,
          summary: `新探针和限额都不在。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-旧清单运行`,
          output: `「${n.title}」健康检查按旧探针报绿。`,
          summary: `现行告警规则对不上。`,
        })),
      F('stale_flag',
        (n, c) => ({
          version: 'flags-last-week',
          artifact: `${c.topic}-上周开关`,
          output: `特性开关仍是上周快照。`,
          summary: `本期该关的门还开着。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-错门放量`,
          output: `「${n.title}」流量进了不该开的门。`,
          summary: `观察指标会看起来像功能失败。`,
        })),
    ],
    wrong_acceptance: [
      F('http200',
        (n, c) => ({
          acceptance: 'http-200',
          artifact: `${c.topic}-探活通过`,
          output: `探活 200 即健康，不看错误率和延迟。`,
          summary: `部分失败也能过。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-假健康`,
          output: `「${n.title}」在高错误率下继续放量。`,
          summary: `回滚条件从未触发。`,
        })),
      F('no_rollback_drill',
        (n, c) => ({
          acceptance: 'no-drill',
          artifact: `${c.topic}-未演练`,
          output: `没做回滚演练也算可放量。`,
          summary: `真回滚时步骤是口头的。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-不会退`,
          output: `「${n.title}」故障时找不到回退包。`,
          summary: `复盘只能写操作混乱。`,
        })),
    ],
    local_replan: [
      F('restart_and_hope',
        (n, c) => ({
          artifact: `${c.topic}-重启顶修`,
          output: `灰度异常改成重启实例，不查配置。`,
          summary: `用重启换观察时间。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-复发故障`,
          output: `「${n.title}」把复发当成新事件。`,
          summary: `复盘看不到同一根因。`,
        }),
        (n, c) => repair(n, c, '记下重启窗口', '把临时重启标成未根治')),
      F('widen_then_watch',
        (n, c) => ({
          artifact: `${c.topic}-先扩再看`,
          output: `指标不稳就先扩容，再决定是否回滚。`,
          summary: `用容量掩盖错误。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-被扩容掩盖`,
          output: `「${n.title}」错误率被流量摊薄，写成改善。`,
          summary: `放量决策建立在假改善上。`,
        }),
        (n, c) => repair(n, c, '按错误绝对数看', '把扩容前后的失败次数并排')),
    ],
  },
  legal: {
    missing_dependency: [
      F('share_without_auth',
        (n, c) => ({
          inputs: `数据范围在，授权检查未完成`,
          artifact: `${c.topic}-未授权范围`,
          output: `对外口径先写，没有等授权结论。`,
          summary: `不该出的字段可能已经进稿。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-越权口径`,
          output: `「${n.title}」把未授权字段写进可公开说明。`,
          summary: `归档会留下违规对外记录。`,
        })),
      F('archive_without_limits',
        (n, c) => ({
          inputs: `敏感标注在，限制条款未确认`,
          artifact: `${c.topic}-无限制定稿`,
          output: `归档不等提出限制完成。`,
          summary: `使用边界没有写进档案。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-无边界档案`,
          output: `「${n.title}」档案看起来完整，缺使用限制。`,
          summary: `下次会按无限制去用。`,
        })),
    ],
    wrong_agent: [
      F('biz_self_check',
        (n, c) => ({
          agentId: `${c.domain}_biz_owner`,
          artifact: `${c.topic}-业务自检`,
          output: `授权检查改由业务负责人自己签。`,
          summary: `没有法务对照许可范围。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-自签授权`,
          output: `「${n.title}」把业务便利写成已授权。`,
          summary: `对外口径没有法律依据。`,
        })),
      F('vendor_counsel',
        (n, c) => ({
          agentId: `${c.domain}_vendor_counsel`,
          artifact: `${c.topic}-供应商意见`,
          output: `限制条款改用供应商法务的模板。`,
          summary: `模板不对我们的数据范围。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-错主体限制`,
          output: `「${n.title}」限制写的是供应商主体。`,
          summary: `我们自己的使用边界是空的。`,
        })),
    ],
    wrong_version: [
      F('old_regulation',
        (n, c) => ({
          version: 'reg-2021',
          artifact: `${c.topic}-2021法规摘`,
          output: `识别范围仍按 2021 文本，未切现行修订。`,
          summary: `新敏感类不会被标出。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-过期合规`,
          output: `「${n.title}」按旧法写无新增限制。`,
          summary: `现行修订下其实要限。`,
        })),
      F('old_license',
        (n, c) => ({
          version: 'license-v2',
          artifact: `${c.topic}-旧许可`,
          output: `授权仍引用已过期许可编号。`,
          summary: `范围可能已收缩。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-过期许可口径`,
          output: `「${n.title}」对外仍写旧许可覆盖。`,
          summary: `对方核验许可号会对空。`,
        })),
    ],
    wrong_acceptance: [
      F('internal_ok',
        (n, c) => ({
          acceptance: 'internal-ok',
          artifact: `${c.topic}-对内即过`,
          output: `对内能用就视为可对外。`,
          summary: `对外边界被内网习惯代替。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-内网口径外溢`,
          output: `「${n.title}」把对内术语直接写进外发。`,
          summary: `敏感项没有按对外标准再滤。`,
        })),
      F('redact_filename',
        (n, c) => ({
          acceptance: 'filename-redact',
          artifact: `${c.topic}-只改文件名`,
          output: `文件名去掉姓名就算脱敏。`,
          summary: `正文里的识别子还在。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-假脱敏`,
          output: `「${n.title}」附件正文仍能定位个人。`,
          summary: `归档的是未真正脱敏的包。`,
        })),
    ],
    local_replan: [
      F('verbal_exception',
        (n, c) => ({
          artifact: `${c.topic}-口头例外`,
          output: `来不及走限制条款，改口头同意先发。`,
          summary: `用例外顶书面限制。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-无书面限制`,
          output: `「${n.title}」档案里没有例外编号。`,
          summary: `事后无法证明范围。`,
        }),
        (n, c) => repair(n, c, '补例外编号', '把口头例外落成一页限制说明')),
      F('hash_and_send',
        (n, c) => ({
          artifact: `${c.topic}-哈希代替删除`,
          output: `敏感项改成哈希保留，不当真删除。`,
          summary: `可逆风险还在。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-可逆脱敏`,
          output: `「${n.title}」把哈希字段当成不可识别。`,
          summary: `持有对照表的人仍能还原。`,
        }),
        (n, c) => repair(n, c, '写清对照表控制', '注明哈希仍视为受限项')),
    ],
  },
  marketing: {
    missing_dependency: [
      F('copy_without_audience',
        (n, c) => ({
          inputs: `产品卖点在，人群未定`,
          artifact: `${c.topic}-无人群文案`,
          output: `文案先写，没有等目标人群。`,
          summary: `渠道和语气会对不准人。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-对空文案`,
          output: `「${n.title}」文案像对所有人说，转化假设空。`,
          summary: `投放核对不上人群包。`,
        })),
      F('launch_without_assets',
        (n, c) => ({
          inputs: `排期在，物料未齐`,
          artifact: `${c.topic}-缺物料排期`,
          output: `排期投放不等物料齐套。`,
          summary: `上线会用占位图。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-占位投放`,
          output: `「${n.title}」把占位图送进真实渠道。`,
          summary: `效果复核看的是残稿。`,
        })),
    ],
    wrong_agent: [
      F('intern_copy',
        (n, c) => ({
          agentId: `${c.domain}_intern_copy`,
          artifact: `${c.topic}-实习生文案`,
          output: `文案改由实习生按竞品改写。`,
          summary: `承诺句可能过满。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-过满承诺`,
          output: `「${n.title}」投放句带了产品并未承诺的效果。`,
          summary: `复核会和合规口径冲突。`,
        })),
      F('kol_rewrites',
        (n, c) => ({
          agentId: `${c.domain}_kol_editor`,
          artifact: `${c.topic}-达人改写`,
          output: `物料改由达人按口播习惯改。`,
          summary: `品牌限制词可能被拿掉。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-口播越界`,
          output: `「${n.title}」成片里出现未审的功效句。`,
          summary: `排期已经按这版去投。`,
        })),
    ],
    wrong_version: [
      F('old_offer',
        (n, c) => ({
          version: 'offer-spring',
          artifact: `${c.topic}-春季权益`,
          output: `文案仍写春季权益，未换当期规则。`,
          summary: `价格和时限都是旧的。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-过期权益投`,
          output: `「${n.title}」渠道页还在卖已下线权益。`,
          summary: `效果复核会看到投诉而非转化。`,
        })),
      F('old_pixel',
        (n, c) => ({
          version: 'pixel-v2',
          artifact: `${c.topic}-旧像素`,
          output: `投放仍打旧转化像素。`,
          summary: `回流事件对不上当期目标。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-错事件报表`,
          output: `「${n.title}」把旧事件当成本期转化。`,
          summary: `优化方向会被带偏。`,
        })),
    ],
    wrong_acceptance: [
      F('legal_later',
        (n, c) => ({
          acceptance: 'legal-later',
          artifact: `${c.topic}-先投后审`,
          output: `合规口审改到投放后再补。`,
          summary: `未审句可以先上。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-未审投放`,
          output: `「${n.title}」效果数据来自未审文案。`,
          summary: `下架时已经投出去了。`,
        })),
      F('ctr_only',
        (n, c) => ({
          acceptance: 'ctr-ok',
          artifact: `${c.topic}-点击即成`,
          output: `点击率够了就算物料合格，不看误导。`,
          summary: `标题党可以过。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-标题党投放`,
          output: `「${n.title}」高点击低履约被写成成功。`,
          summary: `复核指标选错了。`,
        })),
    ],
    local_replan: [
      F('boost_budget',
        (n, c) => ({
          artifact: `${c.topic}-加预算顶素材`,
          output: `物料不齐就加预算硬投。`,
          summary: `用钱换制作时间。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-贵且残`,
          output: `「${n.title}」花费上去了，素材仍是残稿。`,
          summary: `效果复核解释不了浪费。`,
        }),
        (n, c) => repair(n, c, '记下加投原因', '把加预算标成物料缺口补偿')),
      F('one_channel',
        (n, c) => ({
          artifact: `${c.topic}-单渠道应急`,
          output: `多渠道来不及，全压到一个渠道。`,
          summary: `人群覆盖被临时改写。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-覆盖失真`,
          output: `「${n.title}」把单渠道结果写成全盘验证。`,
          summary: `结论外推不成立。`,
        }),
        (n, c) => repair(n, c, '限制结论范围', '复核改写为仅该渠道')),
    ],
  },
  hr: {
    missing_dependency: [
      F('screen_without_role',
        (n, c) => ({
          inputs: `简历堆在，岗位要求未拆完`,
          artifact: `${c.topic}-无标准筛选`,
          output: `筛简历凭熟悉度，没有等岗位拆解。`,
          summary: `匹配标准会在后面漂移。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-印象名单`,
          output: `「${n.title}」面试名单对不上岗位关键项。`,
          summary: `评价表没有共同尺子。`,
        })),
      F('offer_without_bg',
        (n, c) => ({
          inputs: `评价在，背景核对未出`,
          artifact: `${c.topic}-未核发约`,
          output: `发 offer 不等背景核对。`,
          summary: `关键任职经历可能是空的。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-带风险要约`,
          output: `「${n.title}」把未核经历写成已确认。`,
          summary: `入职文件会和事实冲突。`,
        })),
    ],
    wrong_agent: [
      F('hiring_mgr_solo',
        (n, c) => ({
          agentId: `${c.domain}_hiring_mgr`,
          artifact: `${c.topic}-用人经理独面`,
          output: `面试安排改成用人经理一个人全包。`,
          summary: `没有独立面评对照。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-单视角评价`,
          output: `「${n.title}」记录只有用人经理印象。`,
          summary: `背景核对其实没有第二源。`,
        })),
      F('agency_screens',
        (n, c) => ({
          agentId: `${c.domain}_agency_recruiter`,
          artifact: `${c.topic}-中介筛选`,
          output: `筛简历改由中介按自己漏斗筛。`,
          summary: `岗位关键项可能被他们的模板替换。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-模板名单`,
          output: `「${n.title}」候选人像中介通用画像。`,
          summary: `面试评价对不上我们的岗位。`,
        })),
    ],
    wrong_version: [
      F('old_jd',
        (n, c) => ({
          version: 'jd-2024',
          artifact: `${c.topic}-旧岗位说明`,
          output: `拆要求仍用去年职位描述。`,
          summary: `新必备技能不会进筛选。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-错岗名单`,
          output: `「${n.title}」按旧技能面，当期职责没问。`,
          summary: `offer 理由和对岗需求错位。`,
        })),
      F('old_salary_band',
        (n, c) => ({
          version: 'band-h1',
          artifact: `${c.topic}-上半年带宽`,
          output: `要约仍按下半年前的薪酬带。`,
          summary: `现行带宽可能已经调整。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-错带要约`,
          output: `「${n.title}」数字不在现行带内，却当标准 offer。`,
          summary: `审批会在薪酬带上卡住。`,
        })),
    ],
    wrong_acceptance: [
      F('culture_fit_only',
        (n, c) => ({
          acceptance: 'culture-ok',
          artifact: `${c.topic}-投缘即过`,
          output: `感觉合适就过，技能项不挡。`,
          summary: `关键能力可以缺。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-投缘名单`,
          output: `「${n.title}」评价里几乎没有可核技能证据。`,
          summary: `背景核对不知道该核什么。`,
        })),
      F('one_yes',
        (n, c) => ({
          acceptance: 'single-yes',
          artifact: `${c.topic}-一票通过`,
          output: `一位面试官通过即可。`,
          summary: `反对票不拦要约。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-忽略反对`,
          output: `「${n.title}」把反对记录收进备注，仍发约。`,
          summary: `风险面被流程吃掉。`,
        })),
    ],
    local_replan: [
      F('skip_loop',
        (n, c) => ({
          artifact: `${c.topic}-减面应急`,
          output: `排期来不及，砍掉一轮对岗面试。`,
          summary: `用速度顶完整性。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-缺轮评价`,
          output: `「${n.title}」评价表缺对岗轮，仍写全面通过。`,
          summary: `offer 建立在不完整证据上。`,
        }),
        (n, c) => repair(n, c, '标缺失轮次', '评价结论改成未完成对岗轮')),
      F('verbal_offer',
        (n, c) => ({
          artifact: `${c.topic}-口头要约`,
          output: `书面 offer 来不及，先口头承诺。`,
          summary: `用口头顶审批。`,
        }),
        (n, c) => ({
          artifact: `${c.topic}-无书面约`,
          output: `「${n.title}」档案里没有已发出的书面条件。`,
          summary: `双方记住的数字可能不同。`,
        }),
        (n, c) => repair(n, c, '补口头纪要', '把承诺数字写成待审纪要')),
    ],
  },
};

// ---------------------------------------------------------------------------
// step 层形态（agent_step）—— v4 收窄版
// ---------------------------------------------------------------------------
//
// 为什么不挂在 domain 目录下：step 层的漂移语义**不依赖业务域**。计划里的第 N 步被砍掉、
// 某一步换了执行者、某一步还在用上一版计划的说法 —— 这几件事在十个域里是同一件事。
// 硬套 domain 目录只会造出「行业研究的第 5 步用销售话术」这类不存在的组合，
// 而模型会去学那个组合。
//
// 另一个区别是**下游**：domain 目录的 far 写的是"结论/交付"受害，
// step 层的 far 只能写"同一条 sequence_of 链上的后续步骤"受害 —— 计划图上的漂移
// 首先污染的是链，而不是交付物。这是 step 层唯一能教给模型的因果形状。
//
// ## v4：为什么整套 gold/far 都要重写
//
// v3 往 step 节点写 `artifact`/`output`/`summary`/`inputs`。但真实投影在 step 层
// **一个字都不写**（实测表见 _real_live/AGENT_PLAN_OBSERVATION.zh-CN.md §4.2：
// 真跑一次投影，3 个 agent_step 节点的 public_summary 全空，富文本无对应列）。
// 语料里全满、上线全空 —— 模型训练时依赖的全部依据在生产上一个都不存在。
//
// 所以 step 形态现在只能做两件事：
//   gold —— 只在 `title` / `agentId` 上表达漂移，或者**什么都不动**（结构性漂移）；
//   far  —— 只在 `title` / `status` 上写后果。
//
// 三条硬规则：
//   1. gold **不许**碰 `status`。「谁的状态不是 completed」如果直接等于答案，模型学到的
//      就是一条读 status 的捷径，而不是"漂移沿链传播"。status 只能作为**后果**出现在
//      下游（far）—— 这正是 validate.mjs 里 statusShortcutBaseline 那条守卫要证明的事。
//   2. far 不许写任何富文本字段，也不许改 kind：挂在 step 上的富文本节点产品上不存在。
//   3. `wrong_acceptance` 在 step 层**没有形态**（见下面 STEP_TIER_HAS_NO_FORM）。
//      这不是遗漏，是诚实的能力削减，写进 PLAN_EXEC_TRUTH §8.2。

/**
 * step 节点上"后果"的两个可用通道：`status`（执行状态）与 `title`（措辞）。
 *
 * 两个都写：只看 status 的话四种漂移的后果长得一模一样，而 `type` 是要单独验收的一项
 * （rdmd_acceptance.py 第 2 项）；只看 title 的话又完全放弃了真实执行状态。
 */
function stepFar(node, { status, suffix }) {
  return { status, title: `${node.title}·${suffix}` };
}

/** step 的修补也只能是步骤：`addRepair` 会按 parent.kind 选形状，这里只给标题。 */
function stepRepair(title) {
  return { title };
}

const STEP_CATALOG = {
  // 结构性漂移：链上少一环。gold **一个字段都不改** —— 信号就是"少了一条
  // sequence_of 边"（由 applyLocalEdit 砍，且只砍来自上一步的边，不砍包含边）。
  // 给真凶补一句自述，等于把结构信号换成一句可背的话。
  missing_dependency: [
    F('step_skips_predecessor',
      () => ({}),
      (n) => stepFar(n, { status: 'blocked', suffix: '改按更早一环的产出继续' }),
      () => stepRepair('把缺的那一环补回链上')),
    F('step_borrows_other_branch',
      () => ({}),
      (n) => stepFar(n, { status: 'blocked', suffix: '改用另一条线的产出继续' }),
      () => stepRepair('把外线假设标回本链')),
  ],
  // 执行者换人。step 的 agentId 平时**继承**自所属任务，
  // 所以"与父任务不同"这件事本身就是越权代跑，是这个层级上唯一真实的 wrong_agent。
  wrong_agent: [
    F('step_offloaded_to_intern',
      (n, c) => ({ agentId: `${c.domain}_intern_step` }),
      (n) => stepFar(n, { status: 'blocked', suffix: '接手者问不出判断过程' }),
      () => stepRepair('把代跑那步的判据补回来')),
    F('step_human_override',
      (n, c) => ({ agentId: `${c.domain}_oncall_manual` }),
      (n) => stepFar(n, { status: 'blocked', suffix: '手工顶替的记录不在链上' }),
      () => stepRepair('把手工那步记回链上')),
  ],
  // 版本错位。step 上没有 `version`（是常量），所以口径只能落在**标题措辞**上 ——
  // 这也是产品上"这一步还在用上一版计划的说法"的真实可观测形式。
  wrong_version: [
    F('step_from_previous_revision',
      (n) => ({ title: `${n.title}·沿用上一版计划的说法` }),
      (n) => stepFar(n, { status: 'blocked', suffix: '按混版链接下去' }),
      () => stepRepair('把这一步改回本轮口径')),
    F('step_stale_tool_contract',
      (n) => ({ title: `${n.title}·仍按已停用的步骤口径` }),
      (n) => stepFar(n, { status: 'blocked', suffix: '按旧形状继续' }),
      () => stepRepair('按新口径重做这一步')),
  ],
  // 本地重规划。两种形式：
  //   spawned  —— 结构信号（applyLocalEdit 从这一步增派一个计划外的环节，gold 字段不动）；
  //   merged   —— 措辞信号（这一步被并进下一环）。
  // **没有**"砍掉这一步"的形式：真凶节点被删会被 gates 的 `gold_absent_in_prime` 拒掉
  // （真凶必须存在于两侧，否则归因无从校验），所以"砍步"只能在 agent_task 层表达。
  local_replan: [
    F('step_spawned_extra_step',
      () => ({}),
      (n) => stepFar(n, { status: 'running', suffix: '按增派后的链继续' }),
      () => stepRepair('把增派的那一环记进计划')),
    F('step_merged_into_next',
      (n) => ({ title: `${n.title}·并入下一环` }),
      (n) => stepFar(n, { status: 'running', suffix: '合并后不再单独落中间产物' }),
      () => stepRepair('把合并掉的中间产物挂回链上')),
  ],
};

/**
 * step 层**没有形态**的漂移类型，以及为什么。
 *
 * `wrong_acceptance` 依赖"这一步的验收标准被改松了"这个概念，而 plan step 的载荷只有
 * `{step, status}`（见 projectAgentPlanSteps 与 uBuddyAgentPlanSteps.js 的字段形状），
 * 验收标准在这个层级没有来源。编一段 acceptance 文本能凑出样本，但那是在教模型
 * 一个生产上永远不会出现的字段 —— 宁可少一种漂移，也不造假。
 *
 * 所以 step 层只承载 **4/5** 种漂移。这一条在 dataset.test.mjs 里有显式断言
 * （不是"恰好没测到"），也写进了 PLAN_EXEC_TRUTH §8.2。
 */
export const STEP_TIER_MISSING_FORMS = Object.freeze({
  wrong_acceptance: 'plan step 的载荷只有 {step, status}，验收标准在 step 层没有来源',
});

/** 某个漂移类型在 step 层有没有形态。采样器据此把 step 节点排除在候选之外。 */
export function stepFormAvailable(type) {
  return Boolean(STEP_CATALOG[type] && STEP_CATALOG[type].length);
}

// step 层形态只按 drift 类型索引；查不到就回落到 domain 目录。
export function pickStepForm(type, rng) {
  const list = STEP_CATALOG[type];
  return list && list.length ? list[rng.int(list.length)] : null;
}

export function stepFormIds(domain, type) {
  return (STEP_CATALOG[type] || []).map((form) => formIdOf(domain, type, form));
}

function repair(parent, ctx, title, summary) {
  return {
    title,
    summary,
    inputs: `${parent.output || parent.title}`,
    output: `${ctx.topic}-临时接回主链`,
  };
}

export function pickForm(domain, type, rng, { kind = '' } = {}) {
  // step 层只按 drift 类型取形态：见 STEP_CATALOG 上方关于"语义与业务域无关"的说明。
  //
  // v4 起**取不到就返回 null，不回落到 domain 目录**。回落会把 artifact/output/summary
  // 写到 step 节点上，造出一个产品上不存在的形状（真实投影在 step 层一个字都不写），
  // 而模型会去学那个形状 —— 那比少一种漂移更糟。调用方（applyLocalEdit）必须放弃注入。
  if (kind === 'agent_step') return pickStepForm(type, rng);
  const pack = CATALOG[domain] || CATALOG.research;
  const list = pack[type] || CATALOG.research[type];
  return list[rng.int(list.length)];
}

export function formIdOf(domain, type, form) {
  return `${domain}.${type}.${form.id}`;
}

export function lookupForm(domain, type, formId) {
  const short = String(formId || '').split('.').pop();
  const stepForm = (STEP_CATALOG[type] || []).find((item) => item.id === short);
  if (stepForm) return stepForm;
  const pack = CATALOG[domain] || CATALOG.research;
  const list = pack[type] || CATALOG.research[type];
  return list.find((item) => item.id === short) || list[0];
}

export function applyFormToNode(node, form, ctx) {
  Object.assign(node, form.gold(node, ctx));
}

export function applyFormFar(node, form, ctx) {
  Object.assign(node, form.far(node, ctx));
}

export function minHopDefault() {
  return MIN_HOP;
}

export function allFormIds() {
  const ids = [];
  for (const [domain, pack] of Object.entries(CATALOG)) {
    for (const [type, list] of Object.entries(pack)) {
      for (const form of list) ids.push(formIdOf(domain, type, form));
      // step 层形态按"域 × 类型"展开：id 里带域，才能和 domain 目录一样按域区分。
      ids.push(...stepFormIds(domain, type));
    }
  }
  return ids;
}

export function allStepFormIds() {
  const out = [];
  for (const domain of Object.keys(CATALOG)) {
    for (const type of Object.keys(STEP_CATALOG)) out.push(...stepFormIds(domain, type));
  }
  return out;
}
