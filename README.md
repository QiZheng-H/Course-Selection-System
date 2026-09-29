# 大学选课系统

一个可以完整演示“志愿提交 → 统一分配 → 毕业保障 → 结果发布 → 候补与退改选”的选课系统。
面向本机浏览器演示，模块化单体架构，数据落在单个 SQLite 文件里，不依赖任何外部服务。

> 目前状态：需求中的核心流程已实现并有自动化测试覆盖（数据库 → 后端 → 前端 → 测试 → README 均已产出）。
> 未实现或刻意不做的东西都写在 [§9 已知边界](#9-已知边界与不做的事情) 里，不夸大完成度。

---

## 1. 快速开始

需要 **Node.js ≥ 20**（开发验证使用 Node 24；`better-sqlite3` 会在安装时编译原生模块）。

```bash
# 1) 安装依赖（npm workspaces：server + web）
npm install

# 2) 建库并写入演示数据（100 名学生 / 28 门课程 / 50 个教学班）
npm run db:reset

# 3) 同时启动后端与前端（两个终端）
npm run dev:server     # http://127.0.0.1:3001
npm run dev:web        # http://127.0.0.1:5173  ← 浏览器打开这个
```

只跑后端也能演示：Vite 开发服务器会把 `/api` 代理到 `3001`。
如果希望用一个地址访问（不使用 Vite 开发服务器），先构建前端再启动后端：

```bash
npm run build && npm start     # 浏览器打开 http://127.0.0.1:3001
```

自检命令：

```bash
npm run typecheck   # 前后端 TypeScript 严格模式检查
npm run test        # 后端自动化测试（57 个用例）
npm run demo        # 完整流程演示脚本（需要后端已启动）
```

> 演示数据自带一个状态为**正式受理**的选课批次（`2026-2027-1 第一轮选课（演示批次）`），
> 所以打开页面就能直接提交志愿、冻结、试算与发布，不需要先手建批次。
> 想要从零开始也可以在 **批次控制** 里新建，或执行 `npm run demo` 走一遍完整流程。
> 注意：`正式受理` 阶段是“提交志愿”，正式的选退课在结果**发布之后**才开放。

### 演示账号

| 角色 | 用户名 | 密码 | 说明 |
|---|---|---|---|
| 管理员 | `admin` | `admin123` | 资料发布、批次控制、分配与发布、毕业保障、异常处理 |
| 学生 | `20241001` … `20241100` | `123456` | 100 个学号，全部同一初始口令 |

重新生成演示数据（会删除 `server/data/course-selection.db`）：

```bash
npm run db:reset
```

> 数据库文件与导入上传目录都在 `.gitignore` 里，不会进版本库。
> 如果升级了 Node 大版本后启动报原生模块错误，执行 `npm rebuild better-sqlite3` 即可。

---

## 2. 技术栈与架构

| 层 | 选型 | 说明 |
|---|---|---|
| 数据库 | SQLite + better-sqlite3 | 单文件、同步 API；手写 SQL + `user_version` 迁移，便于审查约束 |
| 后端 | Node.js + Express + TypeScript | 模块化单体，按业务域分包 |
| 前端 | Vue 3 + TypeScript + Vite + vue-router | 学生端与管理员端共用一个登录入口 |
| 测试 | Vitest + supertest | 每个用例一个独立 SQLite 文件，直接打真实 HTTP 接口 |

为什么用同步驱动 + 单后端实例：名额是唯一会被并发争抢的资源，
同步事务让“读计数 → 判断 → 占用”天然串行，配合数据库唯一约束即可杜绝超额。
真正的并发安全在数据库层：`uq_enrollment_active_course`（同一学生同一课程一条有效记录）、
`CHECK (reserved_seats <= capacity)`，以及事务内的真实计数复核。

```
选课系统/
├── server/                      后端（模块化单体）
│   ├── src/
│   │   ├── config.ts            运行时配置（端口、数据库路径、任务超时）
│   │   ├── index.ts             HTTP 入口
│   │   ├── core/                错误码、时间冲突、审计、口令、工具
│   │   ├── db/                  连接与迁移、schema、演示数据、CLI
│   │   ├── middleware/          请求上下文、鉴权、统一错误处理
│   │   ├── routes/index.ts      全部 HTTP 路由（API 契约的唯一事实来源）
│   │   └── modules/
│   │       ├── auth/            登录、会话、改密
│   │       ├── users/           账号管理与批量导入
│   │       ├── catalog/         课程、教学班、容量与时段
│   │       ├── curriculum/      培养方案、必需课程、毕业保障名单、替换授权
│   │       ├── rules/           统一规则层（冲突/资格/学分/需求等级/替代组/联合可行性）
│   │       ├── preference/      志愿草稿、校验、提交版本、撤回
│   │       ├── enrollment/      正式选课服务（唯一允许占用/释放名额的模块）
│   │       ├── allocation/      冻结快照、统一分配、毕业兜底、试算与发布
│   │       ├── waitlist/        候补队列、暂挂、提升、公开补选判定
│   │       ├── materials/       资料导入解析、版本发布、学生确认
│   │       ├── preallocation/   专业课预分配与调整余量
│   │       └── agent/           选课助手（离线规则引擎 + 可选在线模型）
│   ├── scripts/demo.ts          完整流程演示脚本
│   └── tests/                   自动化测试（公平排序/冲突/容量/回滚/保障/恢复/权限/导入）
├── web/                         前端（学生端 + 管理员端）
├── examples/                    可直接上传的示例导入文件（含说明）
├── docs/数据库设计.md           ER 图、数据字典、约束与事务边界说明
├── .env.example                 可配置项示例
└── README.md
```

---

## 3. 完整演示步骤

推荐按下面的顺序走一遍，正好对应需求里的业务阶段。
每一步都给出“在哪操作”和“应该看到什么”。

### ① 资料准备与专业课预分配（管理员）

1. 用 `admin` 登录，进入 **资料核对发布**：可以看到资料版本列表。
   点“选择文件”上传 `CSV / XLSX / DOCX / 文字型 PDF`，选择资料类型（课程 / 教学班 / 培养方案 / 修读记录 / 预分配），
   系统只会生成**导入批次与校验报告**，不会直接改正式数据。
   仓库里的 `examples/` 目录提供了四个可直接上传的示例文件（课程 / 教学班 / 修读记录 / 预分配），
   按 `examples/README.md` 的顺序演示即可。
2. 确认校验报告没有 error 后点 **发布**：生成带内容哈希的资料版本，旧版本自动失效。
3. 进入 **预分配与分配**：可以看到预分配校验结果（“可落实 N 条 / 会失败 M 条”，失败原因会说明调整余量），
   点 **落实预分配** 后这些名额就以 `preallocation` 来源占用了正式容量。

> 示例数据里已经有 30 条待落实的预分配，可以直接演示。

### ② 志愿预览与提交（学生）

1. 用 `20241001 / 123456` 登录，**选课概览** 会显示当前批次状态与时间。
2. 在 **课程检索** 里按关键词 / 院系 / 类型筛选，点课程看教学班（教师、时段、容量 / 已选 / 预留），
   可以直接选课、退课、同课换班，也可以用它来确认“哪些课能选”。
3. 在 **偏好与规划** 里写一句自然语言偏好，例如：

   > 必须选数据结构，尽量选人工智能导论，周三不要排课，不超过 22 学分

   点“生成规划”：会得到 1 套推荐 + 最多 2 套有明显区别的备选，
   每门课都带依据（需求等级、原因）和未满足项；点某门课的“为什么”可以看到来源（培养方案版本、修读记录、名额计数、分配依据）。
   点“填入志愿草稿”只会写草稿，**不会自动提交**。
4. 在 **志愿提交** 里检查全局排名（每门课程唯一）、替代组（组内最多落实一门）、同一课程的教学班偏好顺序，
   先“校验”再“提交”。提交成功会生成版本号，并展示固定的随机键。

### ③ 截止、冻结与统一分配（管理员）

1. **批次控制**：把批次推进到“正式受理”；到点后点 **冻结**（截止）。
   冻结前如果有已提交志愿的学生还没确认修读记录，系统会拦住并列出名单。
2. **预分配与分配** 里点 **试算**：得到落实 / 未落实数量、保障处理情况、异常条数，可以打开执行详情看**逐条判定**
   （需求等级、志愿排名、随机键、判定结果与原因）。
3. 确认无误后点 **发布**：结果写成正式选课记录。发布是**可安全重试**的，同一个幂等键重复执行不会重复扣名额。

### ④ 结果发布、候补与退改选（学生 + 管理员）

1. 管理员进入 **异常与记录**：在发布前必须给每条关键保障异常一个明确处理结果。
2. 管理员点 **把首轮落选转入候补**，再把批次切到“候补与补选”。
3. 学生回到 **结果与候补**：能看到每门落选课程的**当前顺位**（系统不承诺顺位永不后移）、
   暂挂原因（时间冲突 / 学分已满 / 缺授权）与关闭原因；可以新增或修改候补申请、退出、手动“重新检查”。
4. 学生在 **正式课表** 里查看最终课表与每门课的来源（预分配 / 分配 / 候补 / 手工）。
5. 名额释放（有人退课 / 换班）时，系统会按“需求等级 → 排名 → 固定随机键”自动提升合格候补；
   **有合格候补时不会绕过队列公开补选**。

### ⑤ 结束

管理员把批次推进到“已结束”。之前所有关键操作、资料版本、分配依据、授权与课表变更都能在
**操作记录 / 审计日志** 里查到。

### 一条命令跑完整流程

后端启动后执行：

```bash
npm run demo
```

脚本会用真实 HTTP 接口走完上面所有阶段（创建批次 → 学生提交 → 冻结 → 试算 → 发布 → 候补 → 结课），
并在终端打印每一步的结果。为了让候补流程一定能演到，脚本会在“制造竞争”那一步
把某门课程的容量收紧到只留 1 个名额，再用 10 名学生抢它，最后演示
“队列里有人时别人抢不到 → 持有者退课 → 候补第一名被自动提升”。

---

## 4. 核心业务规则（代码里真正执行的那一套）

**排序优先级**：培养需求等级 → 全局志愿排名 → 固定随机键。

- **D2**：正式规则或管理员确认“本学期必须完成”，且尚无足够安排；
- **D1**：可以补足未完成的必修或类别学分，且尚无足够安排；
- **D0**：已有足够安排后的改善申请，或额外兴趣；
- “建议本学期修读”不自动算 D2（需要管理员在培养方案 `direct` 关系或“本学期必须完成课程”里明确）。
- 每次成功安排后会重新计算剩余需求，候补也按最新状态排序。

**志愿表达**：所有申请课程共用不重复的全局排名；同一课程只出现一次（不同教学班放在该课程的偏好顺序里）；
课程可以组成互斥替代组，每组最多落实一门，同一课程不能跨组重复——**多建替代组不会增加第一志愿**。
备选之间允许时间冲突，但最终落实的完整课表必须无冲突。

**固定随机键**：同学期“学生 + 课程”的键在**提交志愿时**一次性生成，同课不同班共用。
重交、撤回后重入、任务重试、重新加入候补都不会重抽，也不采用等待时间加分。

**整体替换**：先检查替换后的完整课表，成功才在**同一事务**内落实目标课并释放原课；失败时原课保留，
不会出现“退了原课却没选上目标课”。所有新增 / 退课 / 换班 / 替换 / 候补提升 / 分配落实 / 预分配
都经过同一个正式选课服务，是唯一允许占用与释放名额的入口。

**毕业保障**：管理员按课程确认保护名单；系统生成教学班预留建议，并检查一个学生的**多门必要课程是否联合可行**
（只看单门容量是不够的）；普通竞争结束后才进行毕业兜底，兜底优先使用预留名额；
整门课程的保护需求全部落实后才释放剩余预留。无解 / 缺授权 / 未提交 / 全部拒绝的会进入**异常清单**，
不自动视为保障完成。

**候补**：首轮未选中的有效申请自动候补；暂挂（时间冲突、学分不足、缺授权）只是条件不满足，仍然占队列位置，
条件变化后重新检查即可恢复；永久失效（课程取消、资格不符、已落实）会关闭并注明原因。

**错误可解释**：接口统一返回 `{ ok:false, error:{ code, message, details } }`，
前端按 `code` 区分显示——例如 `NO_CAPACITY`（名额已满）、`RESERVED_CAPACITY_ONLY`（只剩毕业保障预留名额）、
`TIME_CONFLICT`（时间冲突，附带冲突时段）、`DUPLICATE_COURSE`、`CREDIT_LIMIT_EXCEEDED`、
`AUTHORIZATION_INVALIDATED`、`MATERIAL_NOT_CONFIRMED`、`BATCH_FROZEN`、`IDEMPOTENCY_MISMATCH`。

---

## 5. 选课助手（Agent）

- **分工**：模型只负责“理解偏好”和“解释原因”；排课、规则检查、容量与正式结果全部由确定性程序完成。
- **默认离线**：不配置任何东西时使用离线规则引擎（也支持把中文偏好解析成结构化条件），**不需要联网、不上传资料**。
- **可选在线模型**：在管理端把配置项 `agent_online_enabled` 设为 `true`，并按 `.env.example` 填
  `LLM_PROVIDER / LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL`。模型返回必须是合法 JSON，否则视为失败。
- **故障降级**：模型未配置、超时、报错或返回结构不合法时，自动降级为规则引擎，
  并在界面上如实提示（“已降级为规则引擎规划”），而不是假装成功。
- **边界**：Agent 永远不会直接提交志愿或修改正式课表，只能生成草稿供学生确认。

---

## 6. 数据库设计

完整设计见 **[docs/数据库设计.md](docs/数据库设计.md)**：核心实体与关系、Mermaid ER 图、
逐表数据字典、主键 / 外键 / 唯一约束 / 索引说明、必须靠事务与服务保证的规则、
典型流程读写路径、演示数据与后续迁移规范。

迁移文件在 `server/src/db/migrations/`，按 `NNN_描述.sql` 命名并在事务中执行：

| 文件 | 内容 |
|---|---|
| `001_init.sql` | 全部核心表（账号、课程、教学班、培养方案、修读记录、资料版本、预分配、批次、快照、分配任务、志愿、选课记录、保障预留、授权、候补、审计、异常） |
| `002_term_required.sql` | 管理员确认的“本学期必须完成”课程（D2 的正式依据之一） |
| `003_preference_drafts.sql` | 志愿草稿（与提交版本分开存） |
| `004_material_scope_and_prealloc.sql` | 扩展资料版本 scope；修正预分配批次的关联目标 |
| `005_confirmations_nullable.sql` | 允许在尚无正式资料版本时完成修读记录确认 |

---

## 7. 接口一览

所有接口都在 `/api` 下，响应统一为 `{ ok: true, data }` 或 `{ ok: false, error }`。
会话使用 httpOnly Cookie；所有写操作都支持 `idempotencyKey`（重复提交只执行一次）。
权威定义见 `server/src/routes/index.ts`。

| 分类 | 接口 |
|---|---|
| 登录 | `POST /auth/login`、`POST /auth/logout`、`GET /auth/me`、`POST /auth/password` |
| 学生 | `GET /student/profile`、`GET /student/records`、`POST /student/records/confirm`、`GET /student/progress`、`GET /student/timeline`、`GET /student/batches` |
| 检索 | `GET /courses`、`GET /courses/:id`、`GET /classes`、`GET /classes/:id`、`GET /terms` |
| 选课 | `GET /timetable`、`GET /eligibility/:classId`、`POST /enroll`、`POST /drop`、`POST /swap`、`POST /upgrade`、`GET /operations`、`GET /authorizations` |
| 志愿 | `GET/PUT /preferences/draft`、`POST /preferences/validate`、`GET /preferences`、`POST /preferences/submit`、`POST /preferences/withdraw`、`GET /preferences/random-keys` |
| 候补 | `GET/POST /waitlist`、`DELETE /waitlist/:id`、`POST /waitlist/recheck`、`GET /waitlist/queue` |
| 助手 | `GET /agent/status`、`POST /agent/plan`、`POST /agent/parse`、`GET /agent/explain` |
| 管理：账号 | `GET/POST /admin/users`、`PATCH /admin/users/:id/status`、`POST /admin/users/:id/password`、`POST /admin/users/import` |
| 管理：配置 | `GET/PUT /admin/configs` |
| 管理：课程 | `GET /admin/courses`、`GET/POST /admin/classes`、`PATCH /admin/classes/:id`、`PATCH /admin/classes/:id/status`、`GET /admin/classes/:id/roster` |
| 管理：培养方案 | `GET /admin/programs`、`GET /admin/programs/:id`、`POST /admin/term-required` |
| 管理：批次 | `GET/POST /admin/batches`、`PATCH /admin/batches/:id`、`POST /admin/batches/:id/transition`、`GET /admin/batches/:id/submissions` |
| 管理：分配 | `POST /admin/batches/:id/freeze`、`POST /admin/batches/:id/allocate`（`mode=simulate|publish`）、`GET /admin/batches/:id/runs`、`GET /admin/batches/:id/snapshot`、`GET /admin/runs/:runId`、`POST /admin/batches/:id/enqueue-waitlist` |
| 管理：保障 | `GET/POST /admin/guarantee`、`POST /admin/guarantee/authorizations` |
| 管理：资料 | `POST /admin/imports`（multipart）、`GET /admin/imports`、`POST /admin/imports/:id/publish`、`GET /admin/versions` |
| 管理：预分配 | `GET /admin/preallocations`、`POST /admin/preallocations/apply`、`POST /admin/preallocations/:id/revert` |
| 管理：异常与审计 | `GET /admin/exceptions`、`POST /admin/exceptions/:id/resolve`、`GET /admin/audit`、`GET /admin/operations`、`GET /admin/stats` |

---

## 8. 测试覆盖

`npm run test` 会运行 57 个用例（Vitest + supertest，直接请求真实 HTTP 接口，每个用例独立数据库）：

| 文件 | 覆盖内容 |
|---|---|
| `tests/smoke.test.ts` | 健康检查、登录、会话、角色权限、演示数据规模 |
| `tests/rules.test.ts` | 时间冲突（多时段 / 单双周 / 教学周交集）、学分上限、重复课程、整体替换回滚、同课换班、幂等键、退课释放名额、培养需求抵扣、替代组规则、毕业联合可行性、志愿校验与数据归属 |
| `tests/allocation.test.ts` | 固定随机键不重抽、重复试算结果一致、需求优先于排名、替代组最多落实一门、容量竞争不超额、预留名额不被普通申请占用、毕业兜底使用预留、无解进异常清单、冻结后禁止改选、缺配置不开放批次、发布可安全重试、超时不发布部分结果、学生不能读他人记录 |
| `tests/waitlist.test.ts` | 顺位计算与展示、暂挂后重新检查并提升、课程取消后关闭并说明原因、有合格候补时不能绕过队列、候补修改与退出 |
| `tests/materials.test.ts` | CSV / XLSX / DOCX 解析、不支持格式提示、导入只生成批次、校验失败不能发布、发布生成版本、教学班连带写入时段、资料变化后需重新确认、预分配余量校验与落实、撤销预分配 |
| 补充用例（在 `rules.test.ts` 内） | 没有批次时资格查询给出可读原因、管理员改配置立即生效、授予替换授权后按授权自动替换原课 |

---

## 9. 已知边界与不做的事情

如实说明，避免误解：

- **第一版不做**：满员互换、多课捆绑交换、全局数学最优的录取总人数、跨学期自动排课。
  正式选课只支持单课新增、退课、同课换班和一对一替换。
- **分配不是全局最优**：按优先级逐项尝试，不承诺普通申请录取总人数达到数学最优。
- **文件导入**：支持文字型 PDF、DOCX、XLSX、CSV 与 JSON；扫描件、图片型 PDF 或复杂排版需要先转换或人工录入。
- **在线模型**：默认关闭且不随项目附带任何模型服务；启用需要你自己提供兼容接口与密钥。
- **运行形态**：单机、单后端实例、单 SQLite 文件，面向本机演示，不是多节点高可用部署。
- **并发安全**：依赖同步驱动 + 事务 + 数据库唯一约束。若将来改成多进程部署，需要把“占用名额”改成
  带条件的 `UPDATE ... WHERE` 或引入外部锁，这一层目前没有实现。
- **学分上限、开放时间、必需课程**等都由管理员配置，示例数据里的数值只是演示值，不是任何学校的真实规则。

---

## 10. 常见问题

**端口被占用？** 后端用 `PORT=3002 npm run dev:server` 换端口（同时改 `web/vite.config.ts` 里的代理目标），
前端用 `npm run dev:web -- --port 5174`。

**登录跳回登录页？** 会话是 httpOnly Cookie，前端必须在同一来源访问 API。
开发时请用 Vite 地址（`http://127.0.0.1:5173`），不要直接双击打开 HTML 文件。

**想清空演示数据重新开始？** `npm run db:reset`（会重建结构、写入演示数据并重建那个演示批次）。
想留一份当前数据库，先复制 `server/data/course-selection.db`。

**测试会不会污染演示数据？** 不会。测试用各自的临时数据库文件，跑完即删。

**忘记密码？** 管理员在 **账号管理** 里可以重置任意账号口令；管理员自己的口令可以改数据库或用
`npm run db:reset` 恢复默认值。

**要把它推送到自己的 GitHub 仓库？** 仓库已经初始化好（分支 `main`，remote 指向
`Course-Selection-System`）。如果本机还没登录 GitHub：

```bash
gh auth login -h github.com     # 浏览器登录；或改用下面的 PAT / SSH 方式
git push -u origin main
```

也可以用 `gh auth setup-git` 把已登录的凭据交给 git，或改用
`git@github.com:<用户名>/<仓库>.git` 形式的 SSH 地址。
`server/data/`、`node_modules/`、`web/dist/` 已在 `.gitignore` 中，推送时不会带上演示数据库与构建产物。
