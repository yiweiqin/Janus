export const WORLD_SEED = 20260912;
export const ORG_COUNT = 12;
export const PEOPLE_PER_ORG = 10;
export const AGENTS_PER_PERSON = 5;
export const GENERATED_AT = '2026-09-12T00:00:00.000Z';

export const FAMILIES = {
  research: family({
    id: 'research',
    title: '信息整理',
    verb: '检索、分级并整理证据',
    produces: ['notes', 'dataset'],
    consumes: [],
    deliverableTypes: ['spreadsheet', 'document', 'report'],
    supportedTaskTypes: ['research', '信息整理'],
    baseTags: ['research', '信息整理', 'analysis'],
    facets: [
      facet('source_grade', '来源分级', ['source_verify', '来源分级'], '先区分一手核实、官方口径和转述新闻，再往下写。'),
      facet('year_window', '年份窗口', ['year_window', '时间口径'], '先钉死观察年与对比年，禁止跨年混算。'),
      facet('primary_quote', '一手摘录', ['primary_source', '一手摘录'], '优先摘可回溯的原始表述，少用二手转述。'),
      facet('claim_split', '主张拆分', ['claim_atom', '主张拆分'], '把事实、推断和评价拆开，不写进同一格。'),
    ],
    unsupported: '不直接写对外文案、不做幻灯片版式、不改代码。',
  }),
  data: family({
    id: 'data',
    title: '数据清洗',
    verb: '把摘录做成可对齐的表',
    produces: ['dataset'],
    consumes: ['notes'],
    deliverableTypes: ['spreadsheet'],
    supportedTaskTypes: ['data', '数据清洗'],
    baseTags: ['data', '数据', '清洗', 'spreadsheet'],
    facets: [
      facet('unit_align', '口径对齐', ['unit_align', '口径对齐'], '统一单位、币种和统计口径后再汇总。'),
      facet('missing_mark', '缺失标记', ['missing_flag', '缺失标记'], '空值和估计值分开标记，不拿均值填没。'),
      facet('join_key', '关联键', ['join_key', '关联键'], '先核主键再拼接，避免同名实体混行。'),
      facet('outlier_note', '异常注释', ['outlier_note', '异常注释'], '极端值保留并注释来源，不静默删除。'),
    ],
    unsupported: '不撰写对外结论段、不画演示版式。',
  }),
  writing: family({
    id: 'writing',
    title: '文案写作',
    verb: '把证据写成可对外的文字',
    produces: ['report'],
    consumes: ['notes', 'dataset', 'verdict'],
    deliverableTypes: ['report', 'document'],
    supportedTaskTypes: ['writing', '文案写作'],
    baseTags: ['writing', '文案', '写作', 'copy', 'report'],
    facets: [
      facet('brand_tone', '品牌语气', ['brand_tone', '品牌语气'], '按指定品牌口吻写，不混入口语或内部黑话。'),
      facet('tech_spec', '技术说明书', ['tech_spec', '技术说明书'], '按接口、字段和约束写，不写成营销句。'),
      facet('exec_brief', '决策摘要', ['exec_brief', '决策摘要'], '先写决策者要的结论和限制，再给证据。'),
      facet('citation_bind', '引用绑定', ['citation_bind', '引用绑定'], '每句对外数字都绑回表格或摘录编号。'),
    ],
    unsupported: '不负责幻灯片版式，不改生产代码。',
  }),
  ppt: family({
    id: 'ppt',
    title: '演示文稿',
    verb: '把报告做成可讲的页',
    produces: ['presentation'],
    consumes: ['report', 'dataset', 'notes'],
    deliverableTypes: ['presentation'],
    supportedTaskTypes: ['presentation', '演示文稿'],
    baseTags: ['ppt', 'presentation', '图表', 'deck', 'slides'],
    facets: [
      facet('chart_hierarchy', '图表层级', ['chart_hierarchy', '图表层级'], '一页一个主张，主图先于装饰。'),
      facet('brand_layout', '品牌版式', ['brand_layout', '品牌版式'], '沿用指定字体、色板和页眉，不另起视觉系统。'),
      facet('talk_track', '讲稿节奏', ['talk_track', '讲稿节奏'], '按讲解时长排页，口头补充不写进正文。'),
      facet('number_callout', '数字强调', ['number_callout', '数字强调'], '关键数字单独强调，并与报告口径一致。'),
    ],
    unsupported: '不重做底层调研，不改代码仓库。',
  }),
  code: family({
    id: 'code',
    title: '代码交付',
    verb: '把需求落成可验证改动',
    produces: ['code_change'],
    consumes: ['report'],
    deliverableTypes: ['code_change'],
    supportedTaskTypes: ['code_change', '代码交付'],
    baseTags: ['code', 'backend', '编程', '开发'],
    facets: [
      facet('api_pin', '接口钉死', ['api_pin', '接口钉死'], '按已确认字段和错误码改，不擅自扩接口。'),
      facet('test_gate', '测试门禁', ['test_gate', '测试门禁'], '改动必须带可运行检查，不只贴补丁。'),
      facet('compat_window', '兼容窗口', ['compat_window', '兼容窗口'], '保留旧调用直到迁移说明写清。'),
      facet('perm_scope', '权限范围', ['perm_scope', '权限范围'], '只改授权范围内的路径和角色，不扩大权限。'),
    ],
    unsupported: '不写对外宣传稿，不做演示版式。',
  }),
  review: family({
    id: 'review',
    title: '验收审核',
    verb: '按契约核对交付是否可过',
    produces: ['verdict'],
    consumes: ['report', 'presentation', 'code_change', 'dataset'],
    deliverableTypes: ['document', 'report'],
    supportedTaskTypes: ['review', '验收审核'],
    baseTags: ['review', '验收', '审核', 'source_verify'],
    facets: [
      facet('source_trace', '来源可追溯', ['source_trace', '来源可追溯'], '数字和引用必须能回到摘录或表。'),
      facet('accept_gate', '验收条款', ['accept_gate', '验收条款'], '只按事先写明的条款判过或驳回。'),
      facet('risk_flag', '风险标记', ['risk_flag', '风险标记'], '把不确定项单独列出，不改写成确定结论。'),
      facet('version_pin', '版本钉死', ['version_pin', '版本钉死'], '确认当前有效结果版本，拒绝过期稿。'),
    ],
    unsupported: '不代替上游重做调研或重写代码。',
  }),
};

export const ARCHETYPES = [
  { id: 'content', title: '内容交付组', slots: ['research', 'writing', 'ppt', 'review'], twin: 'writing' },
  { id: 'product', title: '产品文档组', slots: ['research', 'data', 'writing', 'code'], twin: 'research' },
  { id: 'engineering', title: '工程交付组', slots: ['research', 'code', 'review', 'writing'], twin: 'code' },
  { id: 'campaign', title: '传播战役组', slots: ['research', 'writing', 'ppt', 'data'], twin: 'ppt' },
  { id: 'analytics', title: '分析报表组', slots: ['data', 'research', 'writing', 'ppt'], twin: 'data' },
  { id: 'ops', title: '运营复盘组', slots: ['research', 'data', 'review', 'writing'], twin: 'review' },
  { id: 'briefing', title: '汇报材料组', slots: ['research', 'writing', 'ppt', 'review'], twin: 'ppt' },
  { id: 'growth', title: '增长实验组', slots: ['research', 'data', 'code', 'writing'], twin: 'writing' },
];

export const ORGS = [
  org('org_01_consumer', '北境消费研究社', '消费电子份额', '2023-2025 国内手机线上份额', '市场研究部'),
  org('org_02_platform', '开平接口文档组', '开放平台 API', '订单查询接口 v3 字段冻结', '产品文档部'),
  org('org_03_release', '观澜灰度运营室', '灰度发布', '支付页 5% 灰度一周复盘', '运营部'),
  org('org_04_brand', '青梧品牌战役组', '季度品牌战役', '春季会员日主视觉与文案', '品牌传播部'),
  org('org_05_fund', '澄川持仓研究台', '基金持仓', '主动权益基金重仓变化', '金融研究部'),
  org('org_06_paper', '松风学术情报组', '论文综述', '多模态检索近三年方法综述', '学术情报部'),
  org('org_07_policy', '苔溪政策口径组', '政务公开', '地方产业补贴申报口径', '政策研究部'),
  org('org_08_device', '衡石器械注册组', '医疗器械注册', 'II 类检测报告与说明书对齐', '注册事务部'),
  org('org_09_course', '拾光课程设计组', '培训大纲', '内部数据分析入门课改版', '培训部'),
  org('org_10_commerce', '潮汐电商增长组', '活动落地页', '大促会场转化文案与表格', '增长部'),
  org('org_11_access', '叠翠权限工单组', '内部权限', '生产只读账号开通路径', '内部 IT 部'),
  org('org_12_client', '远帆客户汇报组', '咨询交付', '季度业务回顾客户汇报', '客户成功部'),
];

export const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '黄', '赵', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭', '林', '何', '高', '梁'];
export const GIVENS = ['一帆', '思远', '嘉宁', '子轩', '雨桐', '明哲', '书瑶', '浩然', '可欣', '致远', '景行', '语嫣', '清越', '安然', '博文', '若溪', '宁泽', '晓川', '予安', '嘉树'];
export const TITLES = ['研究员', '产品经理', '运营负责人', '客户经理', '分析师', '项目经理', '内容主编', '交付经理', '增长经理', '文档负责人'];

function family(value) {
  return Object.freeze(value);
}

function facet(id, name, tags, rule) {
  return Object.freeze({ id, name, tags, rule });
}

function org(id, name, domain, topic, departmentName) {
  return Object.freeze({ id, name, domain, topic, departmentName });
}

export function familyOf(id) {
  const item = FAMILIES[id];
  if (!item) throw new Error(`unknown_family:${id}`);
  return item;
}

export function flavorLine(org, family, facet) {
  return `${org.domain}·${org.topic}：${family.verb}，细节能力是「${facet.name}」。${facet.rule}`;
}

export function personName(orgIndex, personIndex) {
  const surname = SURNAMES[orgIndex % SURNAMES.length];
  const given = GIVENS[(orgIndex * 3 + personIndex) % GIVENS.length];
  return `${surname}${given}`;
}

export function orgSplit(orgId) {
  const index = ORGS.findIndex((org) => org.id === orgId);
  if (index >= 11) return 'test';
  if (index >= 10) return 'development';
  return 'train';
}

export function agentDisplayName(family, facet, twin) {
  return twin ? `${family.title}·${facet.name}（近邻）` : `${family.title}·${facet.name}`;
}
