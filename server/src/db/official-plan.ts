/**
 * 官方培养方案数据（唯一来源，人工核对）。
 *
 * 专业：上海理工大学 计算机科学与技术（专业代码 1208 / 080901），2024 级本科生
 * 学院：光电信息与计算机工程学院
 *
 * 原始文件：《上海理工大学本科培养计划（2024级）》上册
 *   信息公开网页：https://xxgk.usst.edu.cn/2024/1029/c8692a329070/page.htm
 *     （索取号 0302000-2024-0086，发布时间 2024-09-02）
 *   PDF 附件：https://xxgk.usst.edu.cn/_upload/article/files/3e/d9/1e34c76e4d8ba51adf5c5053d804/
 *             2199ba30-d831-4f96-bc03-9baacfd255bb.pdf
 *   PDF 页数：512；文件 SHA-256：db7bb0ab15539a1e29dd9950dab2589faf3d4161a7ce8e3c4d8aa48cd6787e66
 *
 * 页码对应（印刷页码 / PDF 页码）：
 *   * 计算机科学与技术(1208) 专业方案首页：138 / 161
 *   * 学分结构：140–141 / 163–164
 *   * (一)通识教育课程：IV–VII / 15–18
 *   * (二)学科基础课程 大类基础理论与实践：142 / 165
 *   * (三)专业课程 专业基础实践、核心课程、选修模块 1：143 / 166
 *   *   选修模块 2、实践必修、实践选修：144 / 167
 *   *   实践选修（续）、本研贯通、任选课程：145 / 168
 *
 * 重要约定：
 *   1. 课程代码 / 名称 / 学分 / 必修选修 / 建议修读学年学期 全部照抄官方表格，不做改写。
 *   2. 官方表格中只给出“类型 / 学分 / 备注”而没有课程号的模块（体育类课程、通识-综合素养类
 *      各模块、任选课程），本文件只登记模块要求，不编造课程号；其课程明细见学校
 *      “通识-综合素养类课程目录”，不在本培养计划内。
 *   3. 官方“通识-综合素养类 最低 14 学分”与其 6 个子模块最低学分之和 14.5 不一致
 *      （官方文件原样如此），本文件按子模块登记，并在 note 中记录该差异，不擅自修改。
 *   4. 教师、教学班时间与容量不属于官方培养计划，由本项目另行模拟配置，并标记为演示数据。
 */
import type { SqliteDb } from './index.js';

export type CourseNature = '必修' | '选修';

export interface OfficialCourse {
  /** 官方课程代码 */
  code: string;
  /** 官方课程名称 */
  name: string;
  /** 官方学分 */
  credits: number;
  nature: CourseNature;
  /** 官方“建议修读学年学期”，例如 一/1、二/2(短3) */
  suggestedTerm: string;
  /** 系统内部使用的课程类型（非官方字段，便于容量/规则处理） */
  courseType: 'required' | 'limited_elective' | 'elective' | 'general';
}

export interface OfficialModule {
  /** 内部模块代码（非官方字段） */
  code: string;
  /** 官方模块名称 */
  name: string;
  /** 官方顶层课程性质：通识教育课程 / 学科基础课程 / 专业课程 / 任选课程 */
  group: string;
  nature: CourseNature;
  /** 官方写明的最低要求学分 */
  minCredits: number;
  /** 内部优先级：1 = 硬性必修（D2 依据），2/3 = 选修 */
  priority: number;
  /** 官方印刷页码 */
  sourcePages: string;
  /** 官方备注（例如限选说明、模块差异） */
  note: string | null;
  /** 演示用开课单位（官方培养计划不提供，属于演示元数据） */
  department: string;
  courses: OfficialCourse[];
}

export const USST_CS_2024_SOURCE = {
  school: '上海理工大学',
  major: '计算机科学与技术',
  majorCode: '080901',
  planCode: '1208',
  grade: '2024',
  college: '光电信息与计算机工程学院',
  totalCredits: 163.5,
  degree: '工学学士',
  duration: '基本学制四年，弹性学习年限最长六年',
  documentTitle: '上海理工大学本科培养计划（2024级）上册',
  disclosurePage: 'https://xxgk.usst.edu.cn/2024/1029/c8692a329070/page.htm',
  fileUrl:
    'https://xxgk.usst.edu.cn/_upload/article/files/3e/d9/1e34c76e4d8ba51adf5c5053d804/2199ba30-d831-4f96-bc03-9baacfd255bb.pdf',
  fileSha256: 'db7bb0ab15539a1e29dd9950dab2589faf3d4161a7ce8e3c4d8aa48cd6787e66',
  filePages: 512,
  planPages: '印刷页码 138–149（PDF 第 161–172 页）',
  creditStructurePages: '印刷页码 140–141（PDF 第 163–164 页）',
  generalEducationPages: '印刷页码 IV–VII（PDF 第 15–18 页）',
  note: '课程代码、名称、学分、必修选修属性、类别学分要求与建议修读学年学期均取自该官方文件；教师、教学班时间与容量由本项目另行模拟配置，属演示数据。',
} as const;

/** 官方学分结构（印刷页码 140–141 / PDF 163–164） */
export const USST_CS_2024_CREDIT_STRUCTURE = [
  { group: '通识教育课程', nature: '必修', kind: '理论课', credits: 28, ratio: '17.13%' },
  { group: '通识教育课程', nature: '选修', kind: '理论课', credits: 13, ratio: '7.95%' },
  { group: '通识教育课程', nature: '必修', kind: '实践课', credits: 3.5, ratio: '2.14%' },
  { group: '通识教育课程', nature: '选修', kind: '实践课', credits: 4, ratio: '2.45%' },
  { group: '学科基础课程', nature: '必修', kind: '理论课', credits: 50, ratio: '30.58%' },
  { group: '学科基础课程', nature: '必修', kind: '实践课', credits: 8, ratio: '4.89%' },
  { group: '专业课程', nature: '必修', kind: '理论课', credits: 12, ratio: '7.34%' },
  { group: '专业课程', nature: '选修', kind: '理论课', credits: 17, ratio: '10.40%' },
  { group: '专业课程', nature: '必修', kind: '实践课', credits: 23, ratio: '14.07%' },
  { group: '专业课程', nature: '选修', kind: '实践课', credits: 3, ratio: '1.83%' },
  { group: '任选课程', nature: '选修', kind: '—', credits: 2, ratio: '1.22%' },
] as const;

const COMPUTER = '光电信息与计算机工程学院';
const MATH = '理学院';
const FOREIGN = '外语学院';
const MARX = '马克思主义学院';
const PE = '体育部';

export const USST_CS_2024_MODULES: OfficialModule[] = [
  // ------------------------- 通识教育课程（最低 48.5 学分） -------------------------
  {
    code: 'GE-IDEOLOGY',
    name: '通识-思政类',
    group: '通识教育课程',
    nature: '必修',
    minCredits: 17,
    priority: 1,
    sourcePages: 'IV / PDF 15',
    note: null,
    department: MARX,
    courses: [
      { code: '39000010', name: '形势与政策(Ⅰ)', credits: 1, nature: '必修', suggestedTerm: '一/1', courseType: 'general' },
      { code: '39000050', name: '中国近现代史纲要', credits: 3, nature: '必修', suggestedTerm: '一/1-一/2', courseType: 'general' },
      { code: '39000083', name: '思想道德与法治', credits: 3, nature: '必修', suggestedTerm: '一/1-一/2', courseType: 'general' },
      { code: '32000120', name: '毛泽东思想和中国特色社会主义理论体系概论', credits: 3, nature: '必修', suggestedTerm: '二/1-二/2', courseType: 'general' },
      { code: '39000020', name: '形势与政策(Ⅱ)', credits: 1, nature: '必修', suggestedTerm: '一/2', courseType: 'general' },
      { code: '39000086', name: '马克思主义基本原理', credits: 3, nature: '必修', suggestedTerm: '二/1-二/2', courseType: 'general' },
      { code: '39000090', name: '习近平新时代中国特色社会主义思想概论', credits: 3, nature: '必修', suggestedTerm: '二/1-二/2', courseType: 'general' },
    ],
  },
  {
    code: 'GE-MILITARY-1',
    name: '通识-军体类 01',
    group: '通识教育课程',
    nature: '必修',
    minCredits: 2.5,
    priority: 1,
    sourcePages: 'IV / PDF 15',
    note: null,
    department: PE,
    courses: [
      { code: '41100010', name: '军训', credits: 1, nature: '必修', suggestedTerm: '一/1', courseType: 'general' },
      { code: '41000010', name: '军事理论', credits: 1, nature: '必修', suggestedTerm: '一/1', courseType: 'general' },
      { code: '31000050', name: '学生体质健康标准测试', credits: 0.5, nature: '必修', suggestedTerm: '三/1、四/1', courseType: 'general' },
    ],
  },
  {
    code: 'GE-MILITARY-2',
    name: '通识-军体类 02（体育类课程）',
    group: '通识教育课程',
    nature: '必修',
    minCredits: 4,
    priority: 1,
    sourcePages: 'IV / PDF 15',
    note: '官方表格为“体育类课程 4.0 学分（一/1-二/2）”，未给出具体课程号；课程目录见学校体育类课程附表。',
    department: PE,
    courses: [],
  },
  {
    code: 'GE-LANGUAGE',
    name: '通识-语言类（英语类课程）',
    group: '通识教育课程',
    nature: '必修',
    minCredits: 8,
    priority: 1,
    sourcePages: 'IV–V / PDF 15–16',
    note: '英语类课程组共 14 学分可选，非外语类专业最低要求 8 学分；学生按分级考试起点顺序修读（官方注 2）。',
    department: FOREIGN,
    courses: [
      { code: '15005170', name: '大学英语(1)', credits: 3, nature: '必修', suggestedTerm: '一/1', courseType: 'general' },
      { code: '15004960', name: '大学英语(2)', credits: 3, nature: '必修', suggestedTerm: '一/1', courseType: 'general' },
      { code: '15004970', name: '交互实用英语', credits: 1, nature: '必修', suggestedTerm: '一/1', courseType: 'general' },
      { code: '15004980', name: '交互综合英语', credits: 1, nature: '必修', suggestedTerm: '一/1', courseType: 'general' },
      { code: '15004990', name: '学术英语读写', credits: 3, nature: '必修', suggestedTerm: '一/2', courseType: 'general' },
      { code: '15005000', name: '学术英语听说', credits: 1, nature: '必修', suggestedTerm: '二/1', courseType: 'general' },
      { code: '15004650', name: '跨文化交际', credits: 2, nature: '必修', suggestedTerm: '二/2', courseType: 'general' },
    ],
  },
  {
    code: 'GE-COMPUTER',
    name: '通识-计算机类',
    group: '通识教育课程',
    nature: '必修',
    minCredits: 3,
    priority: 1,
    sourcePages: 'V / PDF 16',
    note: '官方注 3：工科试验班(电子与信息类)限选“程序设计及实践(C)”。本专业培养计划的大类基础实践为“程序设计课程设计(C)”，本系统按 C 语言路径演示。',
    department: COMPUTER,
    courses: [
      { code: '12004060', name: 'Python 程序设计', credits: 3, nature: '选修', suggestedTerm: '一/1-一/2', courseType: 'general' },
      { code: '12002000', name: '程序设计及实践(C)', credits: 3, nature: '选修', suggestedTerm: '一/1-一/2', courseType: 'general' },
      { code: '12001740', name: '程序设计及实践(JAVA)', credits: 3, nature: '选修', suggestedTerm: '一/1-一/2', courseType: 'general' },
      { code: '12001750', name: '信息系统与数据库技术及实践', credits: 3, nature: '选修', suggestedTerm: '一/1-一/2', courseType: 'general' },
      { code: '12004100', name: '数据科学通识导论', credits: 3, nature: '选修', suggestedTerm: '一/1-一/2', courseType: 'general' },
      { code: '12004090', name: '计算机网络技术', credits: 3, nature: '选修', suggestedTerm: '一/1-一/2', courseType: 'general' },
    ],
  },
  {
    code: 'GE-LITERACY-INNOVATION',
    name: '通识-综合素养类-创新思维与创业实践',
    group: '通识教育课程',
    nature: '必修',
    minCredits: 4,
    priority: 1,
    sourcePages: 'V / PDF 16',
    note: '官方表格为“类型/学分/备注”，未给出课程号：创新实践导论 2.0（短 1，智能化制造类）、创新创业大作业 2.0、其他 2.0。非智能化制造类工学专业必修“创新创业大作业”2 学分，另任选 2 学分。',
    department: COMPUTER,
    courses: [],
  },
  {
    code: 'GE-LITERACY-HUMANITY',
    name: '通识-综合素养类-人文经典与文化传承',
    group: '通识教育课程',
    nature: '必修',
    minCredits: 4,
    priority: 1,
    sourcePages: 'V–VI / PDF 16–17',
    note: '“四史”教育专题课程 1.0（《改革开放史》《社会主义发展史》《中华人民共和国史》《中国共产党历史》），其他 3.0；官方未给出课程号。',
    department: MARX,
    courses: [],
  },
  {
    code: 'GE-LITERACY-ART',
    name: '通识-综合素养类-艺术修养与审美体验',
    group: '通识教育课程',
    nature: '选修',
    minCredits: 2,
    priority: 2,
    sourcePages: 'VI / PDF 17',
    note: '官方只给模块最低 2 学分，未给出课程号。',
    department: '相关学院（演示）',
    courses: [],
  },
  {
    code: 'GE-LITERACY-GLOBAL',
    name: '通识-综合素养类-全球视野与文明对话',
    group: '通识教育课程',
    nature: '选修',
    minCredits: 2,
    priority: 2,
    sourcePages: 'VI / PDF 17',
    note: '官方只给模块最低 2 学分，未给出课程号。',
    department: '相关学院（演示）',
    courses: [],
  },
  {
    code: 'GE-LITERACY-SCIENCE',
    name: '通识-综合素养类-科学探索与持续发展',
    group: '通识教育课程',
    nature: '必修',
    minCredits: 2,
    priority: 1,
    sourcePages: 'VI / PDF 17',
    note: '官方：科学与工程伦理 1.0（必修）+ 其他 1.0；官方未给出课程号。',
    department: COMPUTER,
    courses: [],
  },
  {
    code: 'GE-LITERACY-LABOR',
    name: '通识-综合素养类-劳动教育',
    group: '通识教育课程',
    nature: '必修',
    minCredits: 0.5,
    priority: 1,
    sourcePages: 'VI / PDF 17',
    note: '劳动教育实践 0.5 学分（32 学时，官方注 5），未给出课程号。',
    department: COMPUTER,
    courses: [],
  },

  // ------------------------- 学科基础课程 -------------------------
  {
    code: 'BASE-GENERAL-THEORY',
    name: '大类基础理论',
    group: '学科基础课程',
    nature: '必修',
    minCredits: 26,
    priority: 1,
    sourcePages: '142 / PDF 165',
    note: null,
    department: MATH,
    courses: [
      { code: '12004460', name: '工程学导论(2 组)', credits: 1, nature: '必修', suggestedTerm: '一/1', courseType: 'required' },
      { code: '14003060', name: '工程制图(1)', credits: 2, nature: '必修', suggestedTerm: '一/1', courseType: 'required' },
      { code: '22000210', name: '高等数学 A(1)', credits: 6, nature: '必修', suggestedTerm: '一/1', courseType: 'required' },
      { code: '22000622', name: '线性代数 B', credits: 2, nature: '必修', suggestedTerm: '一/2', courseType: 'required' },
      { code: '12004470', name: '信息智能与物联网技术', credits: 1, nature: '必修', suggestedTerm: '一/2', courseType: 'required' },
      { code: '12002050', name: '电路原理', credits: 4, nature: '必修', suggestedTerm: '一/2', courseType: 'required' },
      { code: '22000050', name: '大学物理 A(1)', credits: 4, nature: '必修', suggestedTerm: '一/2', courseType: 'required' },
      { code: '22000220', name: '高等数学 A(2)', credits: 6, nature: '必修', suggestedTerm: '一/2', courseType: 'required' },
    ],
  },
  {
    code: 'BASE-GENERAL-PRACTICE',
    name: '大类基础实践',
    group: '学科基础课程',
    nature: '必修',
    minCredits: 2.5,
    priority: 1,
    sourcePages: '142 / PDF 165',
    note: null,
    department: COMPUTER,
    courses: [
      { code: '12100710', name: '程序设计课程设计(C)', credits: 2, nature: '必修', suggestedTerm: '一/2(短 1)', courseType: 'required' },
      { code: '12101000', name: '电路原理实验', credits: 0.5, nature: '必修', suggestedTerm: '一/2', courseType: 'required' },
    ],
  },
  {
    code: 'BASE-MAJOR-THEORY',
    name: '专业基础理论',
    group: '学科基础课程',
    nature: '必修',
    minCredits: 24,
    priority: 1,
    sourcePages: '142 / PDF 165',
    note: null,
    department: COMPUTER,
    courses: [
      { code: '12002040', name: '离散数学', credits: 3, nature: '必修', suggestedTerm: '二/1', courseType: 'required' },
      { code: '12004546', name: 'JAVA 编程与开发', credits: 3, nature: '必修', suggestedTerm: '二/1', courseType: 'required' },
      { code: '22000172', name: '概率论与数理统计 B', credits: 3, nature: '必修', suggestedTerm: '二/1', courseType: 'required' },
      { code: '12002920', name: '数据结构', credits: 3, nature: '必修', suggestedTerm: '二/1', courseType: 'required' },
      { code: '12002231', name: '数据库原理(双语)', credits: 3, nature: '必修', suggestedTerm: '二/2', courseType: 'required' },
      { code: '12002950', name: '计算机组成', credits: 3, nature: '必修', suggestedTerm: '二/2', courseType: 'required' },
      { code: '12004529', name: '操作系统 D', credits: 3, nature: '必修', suggestedTerm: '二/2', courseType: 'required' },
      { code: '12001780', name: '计算机网络', credits: 3, nature: '必修', suggestedTerm: '二/2', courseType: 'required' },
    ],
  },
  {
    code: 'BASE-MAJOR-PRACTICE',
    name: '专业基础实践',
    group: '学科基础课程',
    nature: '必修',
    minCredits: 5.5,
    priority: 1,
    sourcePages: '143 / PDF 166',
    note: null,
    department: COMPUTER,
    courses: [
      { code: '22100040', name: '大学物理实验(1)', credits: 0.5, nature: '必修', suggestedTerm: '二/1', courseType: 'required' },
      { code: '12101420', name: '数据结构实验', credits: 0.5, nature: '必修', suggestedTerm: '二/1', courseType: 'required' },
      { code: '12101410', name: 'JAVA 编程与开发实验', credits: 0.5, nature: '必修', suggestedTerm: '二/1', courseType: 'required' },
      { code: '12101840', name: '数据库原理实验', credits: 0.5, nature: '必修', suggestedTerm: '二/2', courseType: 'required' },
      { code: '12101460', name: '计算机组成实验', credits: 0.5, nature: '必修', suggestedTerm: '二/2', courseType: 'required' },
      { code: '12100570', name: '计算机网络实验', credits: 0.5, nature: '必修', suggestedTerm: '二/2', courseType: 'required' },
      { code: '12101400', name: '操作系统实验', credits: 0.5, nature: '必修', suggestedTerm: '二/2', courseType: 'required' },
      { code: '12102660', name: '工程认识实习', credits: 1, nature: '必修', suggestedTerm: '二/2(短 3)', courseType: 'required' },
      { code: '12101470', name: '电子实习 A', credits: 1, nature: '必修', suggestedTerm: '二/2(短 3)', courseType: 'required' },
    ],
  },

  // ------------------------- 专业课程（55 学分） -------------------------
  {
    code: 'MAJOR-CORE',
    name: '专业核心课程',
    group: '专业课程',
    nature: '必修',
    minCredits: 6,
    priority: 1,
    sourcePages: '143 / PDF 166',
    note: null,
    department: COMPUTER,
    courses: [
      { code: '12003550', name: 'Web 应用开发', credits: 3, nature: '必修', suggestedTerm: '三/1', courseType: 'required' },
      { code: '12003540', name: '软件协同设计 A', credits: 3, nature: '必修', suggestedTerm: '三/2', courseType: 'required' },
    ],
  },
  {
    code: 'MAJOR-ELECTIVE-1',
    name: '专业选修模块 1',
    group: '专业课程',
    nature: '选修',
    minCredits: 9,
    priority: 2,
    sourcePages: '143 / PDF 166',
    note: null,
    department: COMPUTER,
    courses: [
      { code: '12003450', name: '人工智能 A', credits: 3, nature: '选修', suggestedTerm: '三/1', courseType: 'limited_elective' },
      { code: '12003580', name: '项目管理与过程改进', credits: 3, nature: '选修', suggestedTerm: '三/1', courseType: 'limited_elective' },
      { code: '12004150', name: '大数据分析', credits: 3, nature: '选修', suggestedTerm: '三/1', courseType: 'limited_elective' },
      { code: '12003620', name: '移动应用开发', credits: 3, nature: '选修', suggestedTerm: '三/1', courseType: 'limited_elective' },
      { code: '12003270', name: '数字图像处理 A', credits: 3, nature: '选修', suggestedTerm: '三/1', courseType: 'limited_elective' },
    ],
  },
  {
    code: 'MAJOR-ELECTIVE-2',
    name: '专业选修模块 2',
    group: '专业课程',
    nature: '选修',
    minCredits: 8,
    priority: 2,
    sourcePages: '144 / PDF 167',
    note: null,
    department: COMPUTER,
    courses: [
      { code: '12004544', name: '分布式计算', credits: 2, nature: '选修', suggestedTerm: '三/2', courseType: 'limited_elective' },
      { code: '12003590', name: '软件测试', credits: 3, nature: '选修', suggestedTerm: '三/2', courseType: 'limited_elective' },
      { code: '12004525', name: '编译原理 D', credits: 2, nature: '选修', suggestedTerm: '三/2', courseType: 'limited_elective' },
      { code: '12004564', name: '信息安全原理及应用', credits: 3, nature: '选修', suggestedTerm: '三/2', courseType: 'limited_elective' },
      { code: '12004511', name: '嵌入式系统软件开发技术', credits: 3, nature: '选修', suggestedTerm: '三/2', courseType: 'limited_elective' },
    ],
  },
  {
    code: 'MAJOR-PRACTICE-REQUIRED',
    name: '实践必修',
    group: '专业课程',
    nature: '必修',
    minCredits: 23,
    priority: 1,
    sourcePages: '144 / PDF 167',
    note: null,
    department: COMPUTER,
    courses: [
      { code: '12102070', name: '软件工程实验', credits: 0.5, nature: '必修', suggestedTerm: '三/1', courseType: 'required' },
      { code: '12102090', name: 'Web 应用开发实验', credits: 0.5, nature: '必修', suggestedTerm: '三/1', courseType: 'required' },
      { code: '12102080', name: '软件协同设计实验', credits: 0.5, nature: '必修', suggestedTerm: '三/2', courseType: 'required' },
      { code: '12102160', name: '算法设计与分析实验', credits: 0.5, nature: '必修', suggestedTerm: '三/2', courseType: 'required' },
      { code: '12101030', name: '数据结构课程设计', credits: 2, nature: '必修', suggestedTerm: '三/1(短 4)', courseType: 'required' },
      { code: '12102994', name: '计算机项目综合开发创新实践', credits: 3, nature: '必修', suggestedTerm: '四/1', courseType: 'required' },
      { code: '12102992', name: '专业综合技能实习', credits: 6, nature: '必修', suggestedTerm: '四/1', courseType: 'required' },
      { code: '12102920', name: '毕业设计', credits: 10, nature: '必修', suggestedTerm: '四/2', courseType: 'required' },
    ],
  },
  {
    code: 'MAJOR-PRACTICE-ELECTIVE',
    name: '实践选修',
    group: '专业课程',
    nature: '选修',
    minCredits: 3,
    priority: 2,
    sourcePages: '144–145 / PDF 167–168',
    note: null,
    department: COMPUTER,
    courses: [
      { code: '12101950', name: '人工智能实验', credits: 0.5, nature: '选修', suggestedTerm: '三/1', courseType: 'limited_elective' },
      { code: '12102130', name: '项目管理与过程改进实验', credits: 0.5, nature: '选修', suggestedTerm: '三/1', courseType: 'limited_elective' },
      { code: '12101710', name: '数字图像处理实验', credits: 0.5, nature: '选修', suggestedTerm: '三/1', courseType: 'limited_elective' },
      { code: '12102170', name: '移动应用开发实验', credits: 0.5, nature: '选修', suggestedTerm: '三/1', courseType: 'limited_elective' },
      { code: '12102700', name: '大数据分析实验', credits: 0.5, nature: '选修', suggestedTerm: '三/1', courseType: 'limited_elective' },
      { code: '12103006', name: '信息安全原理及应用实验', credits: 0.5, nature: '选修', suggestedTerm: '三/2', courseType: 'limited_elective' },
      { code: '12102140', name: '软件测试实验', credits: 0.5, nature: '选修', suggestedTerm: '三/2', courseType: 'limited_elective' },
      { code: '12102150', name: '编译原理实验', credits: 0.5, nature: '选修', suggestedTerm: '三/2', courseType: 'limited_elective' },
      { code: '12102110', name: '分布式计算实验', credits: 0.5, nature: '选修', suggestedTerm: '三/2', courseType: 'limited_elective' },
      { code: '12101610', name: '嵌入式系统实验 A', credits: 0.5, nature: '选修', suggestedTerm: '三/2', courseType: 'limited_elective' },
    ],
  },
  {
    code: 'MAJOR-GRADUATE-LINK',
    name: '本研贯通',
    group: '专业课程',
    nature: '选修',
    minCredits: 6,
    priority: 2,
    sourcePages: '145 / PDF 168',
    note: null,
    department: COMPUTER,
    courses: [
      { code: '12002240', name: '软件工程', credits: 3, nature: '选修', suggestedTerm: '三/1', courseType: 'limited_elective' },
      { code: '12003610', name: '算法设计与分析', credits: 3, nature: '选修', suggestedTerm: '三/2', courseType: 'limited_elective' },
    ],
  },
  {
    code: 'FREE-ELECTIVE',
    name: '任选课程',
    group: '任选课程',
    nature: '选修',
    minCredits: 2,
    priority: 3,
    sourcePages: '145 / PDF 168',
    note: '官方只给 2 学分任选要求，未给出课程清单。',
    department: '相关学院（演示）',
    courses: [],
  },
];

/** 全部有官方课程号的课程（跨模块去重，保持官方表格顺序） */
export const USST_CS_2024_COURSES: Array<OfficialCourse & { moduleCode: string }> = (() => {
  const seen = new Set<string>();
  const out: Array<OfficialCourse & { moduleCode: string }> = [];
  for (const module of USST_CS_2024_MODULES) {
    for (const course of module.courses) {
      if (seen.has(course.code)) continue;
      seen.add(course.code);
      out.push({ ...course, moduleCode: module.code });
    }
  }
  return out;
})();

/** 学年学期 → 学年序号与学期序号；'二/2(短3)' → { year: 2, term: 2, short: 3 } */
export function parseSuggestedTerm(text: string): { year: number; term: number; short: number | null } | null {
  const normalized = text.replace(/[（(]/g, '(').replace(/[）)]/g, ')');
  const match = /^([一二三四])[/／](\d)(?:\(短\s*(\d+)\))?/.exec(normalized);
  if (!match) return null;
  const yearMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4 };
  return { year: yearMap[match[1]] ?? 1, term: Number(match[2]), short: match[3] ? Number(match[3]) : null };
}

/**
 * 根据“当前学期 + 入学年份”推算学生当前所处的教学阶段。
 * 例：入学 2024，学期 2026-2027-1 → 三/1。
 */
export function currentStage(term: string, admittedYear: number): { year: number; term: number; label: string } | null {
  const match = /^(\d{4})-(\d{4})-(\d)$/.exec(term.trim());
  if (!match) return null;
  const startYear = Number(match[1]);
  const termNo = Number(match[3]);
  const year = startYear - admittedYear + 1;
  if (year < 1 || year > 6) return null;
  const labels = ['一', '二', '三', '四', '五', '六'];
  return { year, term: termNo, label: `${labels[year - 1]}/${termNo}` };
}

/** 把官方建议学期转换成相对当前阶段的排序权重：<0 补修，0 本学期，>0 以后学期 */
export function suggestedTermOffset(suggestedTerm: string, stage: { year: number; term: number } | null): number | null {
  if (!stage) return null;
  const parsed = parseSuggestedTerm(suggestedTerm);
  if (!parsed) return null;
  return (parsed.year - stage.year) * 2 + (parsed.term - stage.term);
}

/** 演示数据的统一标记文案 */
export const DEMO_DATA_NOTICE =
  '演示数据：课程代码/名称/学分/必修选修属性/建议修读学期来自上海理工大学 2024 级计算机科学与技术专业官方培养计划；教师、教学班时间与容量、学生账号与修读记录均为本系统模拟配置。';

/** 便捷统计：官方课程门数（用于测试与文档） */
export function officialCourseCount(): number {
  return USST_CS_2024_COURSES.length;
}

/** 预留：允许未来从数据库校验培养方案是否与官方一致 */
export function programSourceSummary(db: SqliteDb): unknown {
  return db
    .prepare('SELECT code, name, grade, major, total_credits, version, source_file, source_url, source_pages FROM programs')
    .all();
}
