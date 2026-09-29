/**
 * 真实班级名单（由「班级成员」截图逐条录入）。
 *
 * 为什么放在代码里：数据库文件在 `.gitignore` 中不会进版本库，
 * 若只把账号写进本地库，别人拉代码后 `npm run db:reset` 得到的库里没有这些账号，
 * 用学号登录会直接报「用户名或密码不正确」。写进种子数据才能让所有人开箱可用。
 *
 * 数据来源与规则：
 *   - 名单、学号、教师信息来自班级成员页截图（52 名学生 + 1 位教师）；
 *   - 初始口令 = 学号本人（`username` 也是学号，故二者相同）；
 *   - 这批账号是真实名单，写入时 `is_demo = 0`，与 seed 生成的演示学生区分开。
 *
 * 待确认项（截图未提供）：
 *   - 沪江学院 11 名留学生未显示专业。种子数据里学生的 `major` 与 `program_id`
 *     必须与培养方案一致才能走通选课与毕业审核，因此暂时都挂到官方培养方案
 *     （080901 计算机科学与技术），`major` 也记为该专业；拿到各人真实专业后改这里即可。
 */

/** 官方培养方案代码（见 db/official-plan.ts：上海理工大学 080901 计算机科学与技术 2024 级） */
const PROGRAM_CODE = '080901';

/** 入学年份：名单学号均为 2024 级（2435xxxx / 2412xxxx） */
export const CLASS_ROSTER_ADMITTED_YEAR = 2024;

export interface ClassRosterStudent {
  studentNo: string;
  name: string;
  /**
   * 截图里的院系（仅用于溯源说明；students 表没有院系列，此处不落库）。
   */
  college: string;
  programCode: string;
}

export const CLASS_ROSTER_TEACHER = {
  name: '李锐',
  department: '光电信息与计算机工程学院',
  title: null as string | null,
};

/** 光电信息与计算机工程学院：41 人 */
const OECE_STUDENTS: Array<[studentNo: string, name: string]> = [
  ['2435050907', '张彦君'],
  ['2435051222', '苏昱嘉'],
  ['2435051911', '胡术淇'],
  ['2435052403', '黄琦铮'],
  ['2435052929', '周正杰'],
  ['2435054322', '项伟成'],
  ['2435055208', '陈嘉豪'],
  ['2435055230', '周智轩'],
  ['2435060115', '贾旭'],
  ['2435060118', '李奕斐'],
  ['2435060127', '杨毅诚'],
  ['2435060208', '朱文清'],
  ['2435060230', '张正航'],
  ['2435060403', '贾雨涵'],
  ['2435060409', '柴清会'],
  ['2435060419', '吕文曦'],
  ['2435060506', '孙鹤娉'],
  ['2435060627', '叶锦方'],
  ['2435060806', '谭云轩'],
  ['2435060927', '殷浩然'],
  ['2435061008', '钟瑶萍'],
  ['2435061021', '汪盈宝'],
  ['2435061101', '樊欣灵'],
  ['2435061112', '李成耀'],
  ['2435061209', '鲍志航'],
  ['2435061222', '谈俊哲'],
  ['2435061406', '徐佳莹'],
  ['2435061501', '陈锦霞'],
  ['2435061708', '张钰轩'],
  ['2435061910', '陈越云'],
  ['2435061913', '胡凯文'],
  ['2435061923', '席文易'],
  ['2435062015', '李卓恒'],
  ['2435062115', '连远皓'],
  ['2435062313', '程新楠'],
  ['2435062328', '余东阳'],
  ['2435062329', '张奕凡'],
  ['2435062417', '卢一鸣'],
  ['2435062706', '孙妍姝'],
  ['2435062707', '周雨欣'],
  ['2435062710', '陈晔春'],
];

/** 沪江学院（美育中心合署）：11 人 */
const HJ_STUDENTS: Array<[studentNo: string, name: string]> = [
  ['2412087101', 'ALEXANDROVA ANASTASIA'],
  ['2412087102', 'ALLAKOVA MAHRI'],
  ['2412087103', 'ANNAMYRADOVA LACHYN'],
  ['2412087105', 'IGDIROVA AYGOZEL'],
  ['2412087106', 'SEYITNAZAROVA OGULGURBAN'],
  ['2412087107', 'BASHIMOV SHAMYRAT'],
  ['2412087108', 'GURBANGYLYJOV TAGANGYLYCH'],
  ['2412087109', 'JUMADURDYYEV NAZAR'],
  ['2412087110', 'NURYAGDYYEV TIMUR'],
  ['2412087111', 'SAPARGELDIYEV MUHAMMET'],
  ['2412087112', 'YAZBERDIYEV PENA'],
];

export const CLASS_ROSTER_STUDENTS: ClassRosterStudent[] = [
  ...OECE_STUDENTS.map(([studentNo, name]) => ({
    studentNo,
    name,
    college: '光电信息与计算机工程学院',
    programCode: PROGRAM_CODE,
  })),
  ...HJ_STUDENTS.map(([studentNo, name]) => ({
    studentNo,
    name,
    college: '沪江学院（美育中心合署）',
    programCode: PROGRAM_CODE,
  })),
];
