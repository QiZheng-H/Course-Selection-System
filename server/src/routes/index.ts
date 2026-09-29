/**
 * HTTP 路由层：只负责参数解析、权限判断与调用服务层，不写业务规则。
 */
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, ERROR_CODES, forbidden, notFound, unauthenticated } from '../core/errors.js';
import { num, str, bool, intList, handle, ok } from '../core/http.js';
import { pagination, idParam } from '../core/validate.js';
import { asyncHandler, createRequestContext, requireAdmin, requireAuth, resolveStudentScope } from '../middleware/index.js';
import { errorHandler, notFoundHandler } from '../middleware/error.js';
import { getDatabase, type SqliteDb } from '../db/index.js';
import { config } from '../config.js';
import type { AppRequest, AuthUser } from '../core/context.js';

import * as authService from '../modules/auth/service.js';
import * as usersService from '../modules/users/service.js';
import * as catalogService from '../modules/catalog/service.js';
import * as curriculumService from '../modules/curriculum/service.js';
import * as rulesService from '../modules/rules/service.js';
import * as batchService from '../modules/batch/service.js';
import * as batchStageService from '../modules/batch/stage.js';
import * as batchActionsService from '../modules/batch/actions.js';
import * as preferenceService from '../modules/preference/service.js';
import * as enrollmentServiceModule from '../modules/enrollment/service.js';
import * as allocationService from '../modules/allocation/service.js';
import * as waitlistService from '../modules/waitlist/service.js';
import * as materialsService from '../modules/materials/service.js';
import * as preallocationService from '../modules/preallocation/service.js';
import * as agentService from '../modules/agent/service.js';
import * as tasksService from '../modules/tasks/service.js';
import { listAudit } from '../core/audit.js';

const { EnrollmentService, registerWaitlistPromotion, registerStudentChangeRecheck } = enrollmentServiceModule;

/** 候补模块在名额释放后的提升逻辑注册进正式选课服务 */
registerWaitlistPromotion((db, classId) => waitlistService.promoteWaitlistForClass(db, classId));
/** 选退课/授权/资料确认后重新评估候补 */
registerStudentChangeRecheck((db, studentId, batchId) => waitlistService.onStudentScheduleChanged(db, studentId, batchId));
/**
 * “结束提交并检查”必须同时生成冻结快照，快照逻辑在分配模块。
 * 用注册回调注入，避免 batch 模块与 allocation 模块循环依赖。
 */
batchService.registerFreezeHandler((db, batchId, actor, options) => allocationService.freezeBatch(db, batchId, actor, options));

/** 授权或资料变化后重新评估候补（不影响主流程） */
function safeRecheckWaitlist(db: SqliteDb, studentId: number, batchId: number | null | undefined, actor?: AuthUser): void {
  if (!batchId) return;
  try {
    waitlistService.onStudentScheduleChanged(db, studentId, batchId, actor);
  } catch {
    // 记录已成功，候补重排失败不应让请求失败
  }
}

/**
 * 组装应用。
 * 默认使用全局单例数据库；测试可以传入自定义数据库连接，从而复用完全相同的路由与中间件。
 */
export function createApp(options: { db?: SqliteDb } = {}): Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(createRequestContext(options.db ? () => options.db! : undefined));

  app.get('/api/health', (_req, res) => {
    ok(res, { status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
  });

  mountAuth(app);
  mountStudent(app);
  mountPreferences(app);
  mountEnrollment(app);
  mountWaitlist(app);
  mountPlanning(app);
  mountAdmin(app);

  // API 未命中与统一错误处理（放在前端静态资源之前，保证 /api/* 始终返回 JSON）
  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  // 生产模式：直接托管前端构建产物
  const webDist = path.resolve(config.serverRoot, '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  return app;
}

// ---------------------------------------------------------------------------
// 登录与账号
// ---------------------------------------------------------------------------
function mountAuth(app: Express): void {
  const router = express.Router();

  handle(router, 'post', '/login', async (req, res) => {
    const db = req.ctx.db;
    const username = str(req.body?.username).trim();
    const password = str(req.body?.password);
    if (!username || !password) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, '请输入用户名与密码', 422);
    }
    const result = authService.login(db, username, password, req.get('user-agent') ?? undefined);
    res.cookie('session', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: config.sessionTtlHours * 3600 * 1000,
    });
    return { user: result.user, expiresAt: result.expiresAt };
  });

  handle(router, 'post', '/logout', async (req) => {
    if (req.ctx.sessionToken) authService.logout(req.ctx.db, req.ctx.sessionToken);
    return { ok: true };
  });

  handle(router, 'get', '/me', async (req) => {
    if (!req.ctx.user) throw unauthenticated();
    return { user: req.ctx.user };
  });

  handle(router, 'post', '/password', requireAuth, async (req: AppRequest) => {
    const user = req.ctx.user!;
    const oldPassword = str(req.body?.oldPassword);
    const newPassword = str(req.body?.newPassword);
    if (newPassword.length < 6) throw new AppError(ERROR_CODES.VALIDATION_FAILED, '新密码至少 6 位', 422);
    authService.changePassword(req.ctx.db, user.id, oldPassword, newPassword);
    return { ok: true, message: '密码已修改，请重新登录' };
  });

  app.use('/api/auth', router);
}

// ---------------------------------------------------------------------------
// 学生端：资料、修读记录、培养进度、方案、时间轴、批次
// ---------------------------------------------------------------------------
function mountStudent(app: Express): void {
  const router = express.Router();

  handle(router, 'get', '/profile', requireAuth, async (req) => {
    const db = req.ctx.db;
    const scope = resolveStudentScope(req);
    const user = req.ctx.user!;
    if (user.role === 'student' && scope !== user.id) throw forbidden('学生只能查看自己的资料');
    const student = db
      .prepare(
        `SELECT s.user_id AS userId, s.student_no AS studentNo, s.name, s.grade, s.major, s.program_id AS programId,
                s.admitted_year AS admittedYear, s.expected_graduate_at AS expectedGraduateAt, s.is_demo AS isDemo,
                u.username, u.last_login_at AS lastLoginAt, p.name AS programName, p.code AS programCode,
                p.total_credits AS totalCredits, p.version AS programVersion, p.source_file AS programSourceFile,
                p.source_url AS programSourceUrl, p.source_pages AS programSourcePages, p.source_note AS programSourceNote
         FROM students s JOIN users u ON u.id = s.user_id
         LEFT JOIN programs p ON p.id = s.program_id
         WHERE s.user_id = ?`,
      )
      .get(scope);
    if (!student) throw notFound('学生资料不存在');
    return { profile: student, confirmation: materialsService.getConfirmationStatus(db, scope) };
  });

  handle(router, 'get', '/records', requireAuth, async (req) => {
    const db = req.ctx.db;
    const scope = resolveStudentScope(req);
    const status = str(req.query.status) || null;
    const rows = db
      .prepare(
        `SELECT r.id, r.course_id AS courseId, c.code AS courseCode, c.name AS courseName, c.credits,
                r.status, r.term, r.source, r.verified, r.updated_at AS updatedAt, r.is_demo AS isDemo
         FROM student_course_records r JOIN courses c ON c.id = r.course_id
         WHERE r.student_id = ? ${status ? 'AND r.status = ?' : ''}
         ORDER BY r.term DESC, c.code`,
      )
      .all(...(status ? [scope, status] : [scope]));
    const enrolled = db
      .prepare(
        `SELECT e.id, e.class_id AS classId, e.course_id AS courseId, c.code AS courseCode, c.name AS courseName,
                c.credits, e.source, e.uses_reserved AS usesReserved, e.created_at AS createdAt
         FROM enrollments e JOIN courses c ON c.id = e.course_id
         WHERE e.student_id = ? AND e.status = 'enrolled' ORDER BY c.code`,
      )
      .all(scope);
    return {
      records: rows,
      enrolled,
      confirmation: materialsService.getConfirmationStatus(db, scope),
      demoNotice: curriculumService.readDemoNotice(db),
    };
  });

  handle(router, 'post', '/records/confirm', requireAuth, async (req) => {
    const db = req.ctx.db;
    const scope = resolveStudentScope(req);
    const result = materialsService.confirmMaterials(db, scope, req.ctx.user!);
    // 修读记录确认后，候补资格与顺位需要重新评估
    const batch = batchService.getCurrentBatch(db);
    if (batch) safeRecheckWaitlist(db, scope, batch.id, req.ctx.user!);
    return result;
  });

  handle(router, 'get', '/progress', requireAuth, async (req) => {
    const db = req.ctx.db;
    const scope = resolveStudentScope(req);
    const planned = intList(req.query.plannedCourseIds);
    const snapshot = rulesService.computeProgress(db, scope, { plannedCourseIds: planned });
    const demand = rulesService.assessDemand(db, scope, planned);
    return {
      progress: snapshot,
      demandHints: Array.from(demand.values()),
      creditLimit: allocationService.readCreditLimit(db),
    };
  });

  handle(router, 'get', '/profile/plan', requireAuth, async (req) => {
    const db = req.ctx.db;
    const scope = resolveStudentScope(req);
    return {
      progress: rulesService.computeProgress(db, scope),
      creditLimit: allocationService.readCreditLimit(db),
      model: agentService.getModelConfig(db),
      plan: curriculumService.studentProgramPlan(db, scope),
    };
  });

  // 官方培养方案（含原文件、来源网址与页码），学生与 Agent 规划均以此为依据
  handle(router, 'get', '/program-plan', requireAuth, async (req) => {
    const db = req.ctx.db;
    const scope = resolveStudentScope(req);
    return curriculumService.studentProgramPlan(db, scope);
  });

  handle(router, 'get', '/timeline', requireAuth, async (req) => {
    const db = req.ctx.db;
    const scope = resolveStudentScope(req);
    const batches = batchService.listBatches(db);
    const events: Array<Record<string, unknown>> = [];
    for (const batch of batches) {
      const view = preferenceService.getPreferences(db, scope, batch.id);
      const waitlist = waitlistService.listWaitlistForStudent(db, scope, batch.id);
      events.push({
        batchId: batch.id,
        batchName: batch.name,
        term: batch.term,
        status: batch.status,
        openAt: batch.openAt,
        closeAt: batch.closeAt,
        publishedAt: batch.publishedAt,
        preferenceStatus: view.status,
        preferenceVersion: view.versionNo,
        submittedAt: view.submittedAt,
        waitlist: waitlist.map((w) => ({ courseName: w.courseName, status: w.status, position: w.position })),
      });
    }
    return { timeline: events, current: batchService.getCurrentBatch(db) };
  });

  handle(router, 'get', '/batches', requireAuth, async (req) => {
    const db = req.ctx.db;
    return { batches: batchService.listBatches(db), current: batchService.getCurrentBatch(db) };
  });

  /**
   * 学生端当前阶段（含“能否提交志愿 / 能否选退课 / 退改选是否开放”）。
   * 学生页面用同一个结果判断按钮状态，因此管理员切换阶段后不会出现“按钮还亮着但请求被拒”。
   */
  handle(router, 'get', '/active-stage', requireAuth, async (req) => {
    const db = req.ctx.db;
    return { stage: batchStageService.buildStudentStage(db) };
  });

  app.use('/api/student', router);
}

// ---------------------------------------------------------------------------
// 志愿
// ---------------------------------------------------------------------------
function mountPreferences(app: Express): void {
  const router = express.Router();

  handle(router, 'get', '/draft', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const batchId = idParam(req.query.batchId, 'batchId');
    return { draft: preferenceService.getDraft(db, studentId, batchId) };
  });

  handle(router, 'put', '/draft', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const batchId = idParam(req.body?.batchId, 'batchId');
    const payload = {
      preferences: Array.isArray(req.body?.preferences) ? req.body.preferences : [],
      groups: Array.isArray(req.body?.groups) ? req.body.groups : [],
    };
    const saved = preferenceService.saveDraft(db, studentId, batchId, payload);
    return saved;
  });

  handle(router, 'post', '/validate', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const batchId = idParam(req.body?.batchId, 'batchId');
    const payload = {
      preferences: Array.isArray(req.body?.preferences) ? req.body.preferences : [],
      groups: Array.isArray(req.body?.groups) ? req.body.groups : [],
    };
    return preferenceService.validateDraft(db, studentId, batchId, payload);
  });

  // 志愿预演：只读。回答“按当前名额，这些志愿排出来的课表是什么样、哪一门排不进、被谁挡住”。
  // 不预测中签概率——统一分配还要经过需求等级、志愿排名与固定随机键的竞争。
  handle(router, 'post', '/preview', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const batchId = idParam(req.body?.batchId, 'batchId');
    const payload = {
      preferences: Array.isArray(req.body?.preferences) ? req.body.preferences : [],
      groups: Array.isArray(req.body?.groups) ? req.body.groups : [],
    };
    return preferenceService.previewDraft(db, studentId, batchId, payload);
  });

  handle(router, 'get', '/', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const batchId = idParam(req.query.batchId, 'batchId');
    const batch = batchService.getBatchDto(db, batchId);
    return {
      batch,
      view: preferenceService.getPreferences(db, studentId, batchId),
      draft: preferenceService.getDraft(db, studentId, batchId),
    };
  });

  handle(router, 'post', '/submit', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const batchId = idParam(req.body?.batchId, 'batchId');
    const payload = {
      preferences: Array.isArray(req.body?.preferences)
        ? req.body.preferences
        : preferenceService.getDraft(db, studentId, batchId).preferences,
      groups: Array.isArray(req.body?.groups) ? req.body.groups : preferenceService.getDraft(db, studentId, batchId).groups,
    };
    return preferenceService.submitPreferences(db, studentId, batchId, payload, req.ctx.user!);
  });

  handle(router, 'post', '/withdraw', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const batchId = idParam(req.body?.batchId, 'batchId');
    return preferenceService.withdrawPreferences(db, studentId, batchId, req.ctx.user!);
  });

  handle(router, 'get', '/random-keys', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const batchId = idParam(req.query.batchId, 'batchId');
    const batch = batchService.getBatchDto(db, batchId);
    const view = preferenceService.getPreferences(db, studentId, batchId);
    return {
      term: batch.term,
      keys: view.items.map((item) => ({
        courseId: item.courseId,
        courseName: item.courseName,
        randomKey: preferenceService.getRandomKey(db, studentId, item.courseId, batch.term),
      })),
    };
  });

  app.use('/api/preferences', router);
}

// ---------------------------------------------------------------------------
// 课程检索与正式选课
// ---------------------------------------------------------------------------
function mountEnrollment(app: Express): void {
  const router = express.Router();

  handle(router, 'get', '/courses', requireAuth, async (req) => {
    const db = req.ctx.db;
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>);
    const result = catalogService.listCourses(db, {
      keyword: str(req.query.keyword) || undefined,
      department: str(req.query.department) || undefined,
      courseType: str(req.query.courseType) || undefined,
      term: str(req.query.term) || undefined,
      limit: pageSize,
      offset,
    });
    return { ...result, page, pageSize };
  });

  handle(router, 'get', '/courses/:courseId', requireAuth, async (req) => {
    const db = req.ctx.db;
    return { course: catalogService.getCourseDetail(db, idParam(req.params.courseId, 'courseId')) };
  });

  handle(router, 'get', '/classes', requireAuth, async (req) => {
    const db = req.ctx.db;
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>);
    const result = catalogService.listClasses(db, {
      term: str(req.query.term) || undefined,
      courseId: num(req.query.courseId) ?? undefined,
      keyword: str(req.query.keyword) || undefined,
      department: str(req.query.department) || undefined,
      courseType: str(req.query.courseType) || undefined,
      onlyAvailable: bool(req.query.onlyAvailable, false),
      limit: pageSize,
      offset,
    });
    return { ...result, page, pageSize };
  });

  handle(router, 'get', '/classes/:classId', requireAuth, async (req) => {
    const db = req.ctx.db;
    const cls = catalogService.getClassDto(db, idParam(req.params.classId, 'classId'));
    const scope = resolveStudentScope(req);
    return { class: cls, conflict: rulesService.findScheduleConflicts([...rulesService.loadStudentSchedule(db, scope), ...rulesService.loadClassSchedule(db, [cls.id])]) };
  });

  handle(router, 'get', '/terms', requireAuth, async (req) => {
    const db = req.ctx.db;
    return { terms: catalogService.listTerms(db), departments: catalogService.listDepartments(db) };
  });

  handle(router, 'get', '/timetable', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    return { timetable: agentService.previewTimetable(db, studentId) };
  });

  handle(router, 'get', '/eligibility/:classId', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const classId = idParam(req.params.classId, 'classId');
    const cls = catalogService.getClassDto(db, classId);
    const evaluation = rulesService.evaluateSchedule(db, studentId, [classId], {
      creditLimit: allocationService.readCreditLimit(db),
    });
    const demand = rulesService.assessDemand(db, studentId, [cls.courseId]).get(cls.courseId);
    const currentBatch = batchService.getCurrentBatch(db);
    const supplement = currentBatch
      ? waitlistService.canPublicSupplement(db, currentBatch.id, cls.courseId)
      : { allowed: false, reason: '当前没有进行中的选课批次', qualifiedWaitlist: 0, protectedSeats: 0 };
    // 没有进行中的批次时，选课本身也会被服务层拒绝；这里如实说明原因，而不是报一个看不懂的 404
    // 只有管理员开放退改选（waitlist）后才能正式选退课；结果发布后、开放前只能查看
    const batchOpen = Boolean(currentBatch && batchService.canStudentEnroll(currentBatch.status));
    const stageHint: Record<string, string> = {
      preparing: '管理员还没有开放预选',
      preview: '请先提交志愿；正式选退课在管理员开放退改选之后',
      open: '请先提交志愿；正式选退课在管理员开放退改选之后',
      frozen: '已结束志愿提交，管理员正在生成并发布分配方案',
      published: '首轮结果已公布，但管理员尚未开放退改选，现在只能查看结果',
      waitlist: '可以选课、退课、换班与查看候补',
      closed: '本次选课已结束',
    };
    const reasons: string[] = [];
    if (!currentBatch) reasons.push('当前没有进行中的选课活动，请等待管理员开放');
    else if (!batchOpen) reasons.push(`当前选课活动处于「${batchService.batchStateLabel(currentBatch.status)}」：${stageHint[currentBatch.status] ?? '管理员尚未开放正式选退课'}`);
    if (cls.status !== 'open') reasons.push('该教学班当前未开放');
    if (cls.generalAvailable <= 0) {
      reasons.push(
        cls.totalAvailable > 0 ? '只剩毕业保障预留名额，普通申请不能占用' : '名额已满',
      );
    }
    if (!evaluation.ok) reasons.push(...evaluation.messages);
    return {
      class: cls,
      evaluation,
      demand: demand ?? null,
      supplement,
      canEnroll: evaluation.ok && batchOpen && cls.status === 'open' && cls.generalAvailable > 0,
      reasons,
    };
  });

  handle(router, 'post', '/enroll', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const classId = idParam(req.body?.classId, 'classId');
    const service = new EnrollmentService(db);
    const batch = batchService.getCurrentBatch(db);
    const result = service.enroll(studentId, classId, {
      idempotencyKey: str(req.body?.idempotencyKey) || undefined,
      batchId: batch?.id ?? null,
      actor: req.ctx.user!,
      source: 'manual',
    });
    if (!result.ok) throw toAppError(result.error, '选课失败');
    return result;
  });

  handle(router, 'post', '/drop', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const classId = idParam(req.body?.classId, 'classId');
    const service = new EnrollmentService(db);
    const batch = batchService.getCurrentBatch(db);
    const result = service.drop(studentId, classId, {
      idempotencyKey: str(req.body?.idempotencyKey) || undefined,
      batchId: batch?.id ?? null,
      actor: req.ctx.user!,
      source: 'manual',
      reason: str(req.body?.reason) || undefined,
    });
    if (!result.ok) throw toAppError(result.error, '退课失败');
    return result;
  });

  handle(router, 'post', '/swap', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const service = new EnrollmentService(db);
    const fromClassId = idParam(req.body?.fromClassId, 'fromClassId');
    const toClassId = idParam(req.body?.toClassId, 'toClassId');
    const batch = batchService.getCurrentBatch(db);
    const sameCourse =
      (db.prepare('SELECT course_id FROM teaching_classes WHERE id = ?').get(fromClassId) as { course_id: number } | undefined)
        ?.course_id ===
      (db.prepare('SELECT course_id FROM teaching_classes WHERE id = ?').get(toClassId) as { course_id: number } | undefined)?.course_id;
    const options = {
      idempotencyKey: str(req.body?.idempotencyKey) || undefined,
      batchId: batch?.id ?? null,
      actor: req.ctx.user!,
      source: 'manual' as const,
      reason: str(req.body?.reason) || undefined,
    };
    const result = sameCourse
      ? service.swap(studentId, fromClassId, toClassId, options)
      : service.replace(studentId, fromClassId, toClassId, options);
    if (!result.ok) throw toAppError(result.error, '操作失败');
    return result;
  });

  handle(router, 'get', '/operations', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const rows = db
      .prepare(
        `SELECT id, op_type AS opType, status, error_code AS errorCode, message, created_at AS createdAt
         FROM enrollment_operations WHERE student_id = ? ORDER BY id DESC LIMIT 100`,
      )
      .all(studentId);
    return { operations: rows };
  });

  // 授权升级：按授权记录自动替换（目标课程与原课程由授权明确指定）
  handle(router, 'post', '/upgrade', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const authorizationId = idParam(req.body?.authorizationId, 'authorizationId');
    const service = new EnrollmentService(db);
    const batch = batchService.getCurrentBatch(db);
    const result = service.upgrade(studentId, authorizationId, {
      idempotencyKey: str(req.body?.idempotencyKey) || undefined,
      batchId: batch?.id ?? null,
      actor: req.ctx.user!,
      source: 'upgrade',
    });
    if (!result.ok) throw toAppError(result.error, '自动替换失败');
    return result;
  });

  handle(router, 'get', '/authorizations', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const rows = db
      .prepare(
        `SELECT ua.id, ua.status, ua.granted_at AS grantedAt, ua.expires_at AS expiresAt, ua.used_at AS usedAt,
                ua.note, sc.name AS sourceCourseName, tc.name AS targetCourseName,
                scl.class_code AS sourceClassCode, tcl.class_code AS targetClassCode
         FROM upgrade_authorizations ua
         JOIN courses sc ON sc.id = ua.source_course_id
         JOIN courses tc ON tc.id = ua.target_course_id
         LEFT JOIN teaching_classes scl ON scl.id = ua.source_class_id
         LEFT JOIN teaching_classes tcl ON tcl.id = ua.target_class_id
         WHERE ua.student_id = ? ORDER BY ua.id DESC`,
      )
      .all(studentId);
    return { authorizations: rows };
  });

  // 学生本人建立“课程替换授权”。管理员确认毕业资格不能代替学生同意退换课程，
  // 因此该授权只允许学生自己创建。
  handle(router, 'post', '/authorizations', requireAuth, async (req) => {
    const db = req.ctx.db;
    const user = req.ctx.user!;
    if (user.role !== 'student') throw forbidden('替换授权必须由学生本人确认');
    const studentId = resolveStudentScope(req);
    if (studentId !== user.id) throw forbidden('只能为自己创建授权');
    const batchId = idParam(req.body?.batchId, 'batchId');
    const result = curriculumService.grantUpgradeAuthorization(
      db,
      {
        studentId,
        batchId,
        sourceClassId: idParam(req.body?.sourceClassId, 'sourceClassId'),
        targetCourseId: idParam(req.body?.targetCourseId, 'targetCourseId'),
        targetClassId: num(req.body?.targetClassId),
        expiresAt: req.body?.expiresAt ?? null,
      },
      user,
    );
    safeRecheckWaitlist(db, studentId, batchId, user);
    return result;
  });

  handle(router, 'delete', '/authorizations/:id', requireAuth, async (req) => {
    const db = req.ctx.db;
    const id = idParam(req.params.id, 'id');
    const row = db.prepare('SELECT student_id, batch_id FROM upgrade_authorizations WHERE id = ?').get(id) as
      | { student_id: number; batch_id: number }
      | undefined;
    curriculumService.revokeUpgradeAuthorization(db, id, req.ctx.user!);
    if (row) safeRecheckWaitlist(db, row.student_id, row.batch_id, req.ctx.user!);
    return { ok: true };
  });

  // 学生毕业兜底授权：明确接受哪些教学班
  handle(router, 'get', '/guarantee-authorizations', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    return {
      authorizations: curriculumService.listGuaranteeAuthorizations(db, {
        studentId,
        batchId: num(req.query.batchId) ?? undefined,
      }),
    };
  });

  handle(router, 'post', '/guarantee-authorizations', requireAuth, async (req) => {
    const db = req.ctx.db;
    const user = req.ctx.user!;
    if (user.role !== 'student') throw forbidden('毕业兜底授权必须由学生本人确认');
    const studentId = resolveStudentScope(req);
    if (studentId !== user.id) throw forbidden('只能为自己创建授权');
    const batchId = idParam(req.body?.batchId, 'batchId');
    const result = curriculumService.grantGuaranteeAuthorization(
      db,
      {
        studentId,
        batchId,
        courseId: idParam(req.body?.courseId, 'courseId'),
        classIds: intList(req.body?.classIds),
        expiresAt: req.body?.expiresAt ?? null,
        note: str(req.body?.note) || null,
      },
      user,
    );
    safeRecheckWaitlist(db, studentId, batchId, user);
    return result;
  });

  handle(router, 'delete', '/guarantee-authorizations/:id', requireAuth, async (req) => {
    const db = req.ctx.db;
    const id = idParam(req.params.id, 'id');
    const row = db.prepare('SELECT student_id, batch_id FROM guarantee_authorizations WHERE id = ?').get(id) as
      | { student_id: number; batch_id: number }
      | undefined;
    curriculumService.revokeGuaranteeAuthorization(db, id, req.ctx.user!);
    if (row) safeRecheckWaitlist(db, row.student_id, row.batch_id, req.ctx.user!);
    return { ok: true };
  });

  app.use('/api', router);
}

// ---------------------------------------------------------------------------
// 候补
// ---------------------------------------------------------------------------
function mountWaitlist(app: Express): void {
  const router = express.Router();

  handle(router, 'get', '/', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const batchId = idParam(req.query.batchId, 'batchId');
    const batch = batchService.getBatchDto(db, batchId);
    const entries = waitlistService.listWaitlistForStudent(db, studentId, batchId);
    return {
      batch,
      entries: entries.map((entry) => ({
        ...entry,
        suspendHint: waitlistService.describeSuspendReason(entry.suspendCode),
      })),
      canEdit: batchService.canWaitlistOperate(batch.status),
      stageHint: batch.status === 'published'
        ? '首轮结果已公布，管理员尚未开放退改选：现在只能查看结果与候补顺位，候补不会递补'
        : undefined,
    };
  });

  handle(router, 'post', '/', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const batchId = idParam(req.body?.batchId, 'batchId');
    const courseId = idParam(req.body?.courseId, 'courseId');
    return waitlistService.upsertWaitlistEntry(
      db,
      studentId,
      batchId,
      { courseId, classIds: intList(req.body?.classIds), globalRank: num(req.body?.globalRank) },
      req.ctx.user!,
    );
  });

  handle(router, 'delete', '/:entryId', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    waitlistService.withdrawWaitlist(db, studentId, idParam(req.params.entryId, 'entryId'), req.ctx.user!);
    return { ok: true };
  });

  handle(router, 'post', '/recheck', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const batchId = idParam(req.body?.batchId, 'batchId');
    return waitlistService.recheckStudentWaitlist(db, studentId, batchId, req.ctx.user!);
  });

  handle(router, 'get', '/queue', requireAuth, async (req) => {
    const db = req.ctx.db;
    const batchId = idParam(req.query.batchId, 'batchId');
    const courseId = idParam(req.query.courseId, 'courseId');
    const queue = waitlistService.computeQueue(db, batchId, courseId);
    const studentId = resolveStudentScope(req);
    return {
      courseId,
      length: queue.length,
      myPosition: queue.findIndex((q) => q.studentId === studentId) + 1 || null,
      // 只展示顺位，不展示他人身份
      ahead: queue.filter((q) => q.studentId !== studentId).map((q, index) => ({ position: index + 1, demandLevel: q.demandLevel })),
    };
  });

  app.use('/api/waitlist', router);
}

// ---------------------------------------------------------------------------
// Agent 规划与解释
// ---------------------------------------------------------------------------
function mountPlanning(app: Express): void {
  const router = express.Router();

  handle(router, 'get', '/status', requireAuth, async (req) => {
    const db = req.ctx.db;
    const model = agentService.getModelConfig(db);
    return {
      model,
      fallbackAvailable: true,
      notice: model.configured
        ? '在线模型已配置：用于理解偏好与解释；排课与规则检查仍由确定性程序完成。'
        : '在线模型未配置：使用离线规则引擎完成偏好解析与排课，不使用任何网络服务。',
    };
  });

  handle(router, 'post', '/plan', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const input = {
      preferenceText: str(req.body?.preferenceText) || undefined,
      targetCourseIds: intList(req.body?.targetCourseIds),
      avoidDays: intList(req.body?.avoidDays),
      avoidPeriods: intList(req.body?.avoidPeriods),
      maxCredits: num(req.body?.maxCredits) ?? undefined,
      term: str(req.body?.term) || undefined,
    };
    return agentService.generatePlan(db, studentId, input, req.ctx.user!);
  });

  handle(router, 'post', '/parse', requireAuth, async (req) => {
    const db = req.ctx.db;
    const text = str(req.body?.text);
    return { parsed: agentService.parsePreferenceText(db, text) };
  });

  handle(router, 'get', '/explain', requireAuth, async (req) => {
    const db = req.ctx.db;
    const studentId = resolveStudentScope(req);
    const courseId = idParam(req.query.courseId, 'courseId');
    return agentService.explainCourse(db, studentId, courseId);
  });

  app.use('/api/agent', router);
}

// ---------------------------------------------------------------------------
// 管理端
// ---------------------------------------------------------------------------
function mountAdmin(app: Express): void {
  const router = express.Router();
  router.use(requireAuth, requireAdmin);

  // ---- 账号 ----
  handle(router, 'get', '/users', async (req) => {
    const db = req.ctx.db;
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>, 50);
    const result = usersService.listUsers(db, {
      role: (str(req.query.role) || undefined) as 'student' | 'admin' | undefined,
      keyword: str(req.query.keyword) || undefined,
      limit: pageSize,
      offset,
    });
    return { ...result, page, pageSize };
  });

  handle(router, 'post', '/users', async (req) => {
    const db = req.ctx.db;
    return usersService.createUser(
      db,
      {
        username: str(req.body?.username),
        password: str(req.body?.password),
        displayName: str(req.body?.displayName) || str(req.body?.username),
        role: (str(req.body?.role) || 'student') as 'student' | 'admin',
        studentNo: str(req.body?.studentNo) || undefined,
        grade: req.body?.grade ?? null,
        major: req.body?.major ?? null,
        programId: num(req.body?.programId),
      },
      req.ctx.user!,
    );
  });

  handle(router, 'patch', '/users/:userId/status', async (req) => {
    const db = req.ctx.db;
    usersService.setUserStatus(
      db,
      idParam(req.params.userId, 'userId'),
      (str(req.body?.status) || 'active') as 'active' | 'disabled',
      req.ctx.user!,
    );
    return { ok: true };
  });

  handle(router, 'post', '/users/:userId/password', async (req) => {
    const db = req.ctx.db;
    const password = str(req.body?.password);
    if (password.length < 6) throw new AppError(ERROR_CODES.VALIDATION_FAILED, '密码至少 6 位', 422);
    usersService.resetPassword(db, idParam(req.params.userId, 'userId'), password, req.ctx.user!);
    return { ok: true };
  });

  handle(router, 'post', '/users/import', async (req) => {
    const db = req.ctx.db;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    return usersService.importStudents(
      db,
      rows,
      str(req.body?.defaultPassword) || '123456',
      req.ctx.user!,
    );
  });

  // ---- 配置 ----
  handle(router, 'get', '/configs', async (req) => {
    const db = req.ctx.db;
    const rows = db
      .prepare('SELECT key, value, value_type AS valueType, description, updated_at AS updatedAt FROM app_configs ORDER BY key')
      .all();
    return { configs: rows, configReady: batchService.checkConfig(db).length === 0, issues: batchService.checkConfig(db) };
  });

  handle(router, 'put', '/configs', async (req) => {
    const db = req.ctx.db;
    const entries = Array.isArray(req.body?.configs) ? req.body.configs : [];
    const now = new Date().toISOString();
    for (const entry of entries) {
      const key = str(entry?.key);
      if (!key) continue;
      db.prepare(
        `INSERT INTO app_configs (key, value, value_type, description, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).run(key, str(entry.value), str(entry.valueType) || 'string', entry.description ?? null, req.ctx.user!.id, now);
    }
    return { ok: true };
  });

  // ---- 课程与教学班 ----
  handle(router, 'get', '/courses', async (req) => {
    const db = req.ctx.db;
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>, 50);
    const result = catalogService.listCourses(db, {
      keyword: str(req.query.keyword) || undefined,
      department: str(req.query.department) || undefined,
      courseType: str(req.query.courseType) || undefined,
      limit: pageSize,
      offset,
    });
    return { ...result, page, pageSize };
  });

  handle(router, 'get', '/classes', async (req) => {
    const db = req.ctx.db;
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>, 50);
    const result = catalogService.listClasses(db, {
      term: str(req.query.term) || undefined,
      courseId: num(req.query.courseId) ?? undefined,
      keyword: str(req.query.keyword) || undefined,
      onlyAvailable: bool(req.query.onlyAvailable, false),
      limit: pageSize,
      offset,
    });
    return { ...result, page, pageSize };
  });

  handle(router, 'get', '/classes/:classId/roster', async (req) => {
    const db = req.ctx.db;
    const classId = idParam(req.params.classId, 'classId');
    const rows = db
      .prepare(
        `SELECT e.id, s.student_no AS studentNo, s.name, e.source, e.uses_reserved AS usesReserved, e.created_at AS createdAt
         FROM enrollments e JOIN students s ON s.user_id = e.student_id
         WHERE e.class_id = ? AND e.status = 'enrolled' ORDER BY e.created_at`,
      )
      .all(classId);
    return { roster: rows, seat: catalogService.getSeatUsage(db, classId) };
  });

  handle(router, 'post', '/classes', async (req) => {
    const db = req.ctx.db;
    return catalogService.upsertClass(db, req.body, req.ctx.user!);
  });

  handle(router, 'patch', '/classes/:classId', async (req) => {
    const db = req.ctx.db;
    const classId = idParam(req.params.classId, 'classId');
    const existing = catalogService.getClassDto(db, classId);
    return catalogService.upsertClass(
      db,
      {
        courseId: existing.courseId,
        classCode: existing.classCode,
        term: existing.term,
        teacherId: existing.teacher?.id ?? null,
        capacity: num(req.body?.capacity) ?? existing.capacity,
        reservedSeats: num(req.body?.reservedSeats) ?? existing.reservedSeats,
        status: (str(req.body?.status) || existing.status) as 'open' | 'closed' | 'cancelled',
        campus: req.body?.campus ?? existing.campus,
        note: req.body?.note ?? existing.note,
      },
      req.ctx.user!,
      classId,
    );
  });

  handle(router, 'patch', '/classes/:classId/status', async (req) => {
    const db = req.ctx.db;
    catalogService.setClassStatus(
      db,
      idParam(req.params.classId, 'classId'),
      (str(req.body?.status) || 'open') as 'open' | 'closed' | 'cancelled',
      req.ctx.user!,
      str(req.body?.reason) || undefined,
    );
    return { ok: true };
  });

  // ---- 培养方案与必需课程 ----
  handle(router, 'get', '/programs', async (req) => {
    const db = req.ctx.db;
    return { programs: curriculumService.listPrograms(db), demoNotice: curriculumService.readDemoNotice(db) };
  });

  handle(router, 'get', '/programs/:programId', async (req) => {
    const db = req.ctx.db;
    return curriculumService.getProgramDetail(db, idParam(req.params.programId, 'programId'));
  });

  handle(router, 'post', '/term-required', async (req) => {
    const db = req.ctx.db;
    return curriculumService.setTermRequired(
      db,
      {
        studentId: idParam(req.body?.studentId, 'studentId'),
        courseIds: intList(req.body?.courseIds),
        term: str(req.body?.term),
        reason: str(req.body?.reason) || undefined,
      },
      req.ctx.user!,
    );
  });

  // ---- 选课工作台（阶段 / 允许动作 / 阻塞原因 / 待办）----
  handle(router, 'get', '/workbench', async (req) => {
    const db = req.ctx.db;
    return batchStageService.buildWorkbench(db, num(req.query.batchId));
  });

  handle(router, 'get', '/batches/:batchId/not-submitted', async (req) => {
    const db = req.ctx.db;
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>, 50);
    const result = batchStageService.listNotSubmitted(db, idParam(req.params.batchId, 'batchId'), {
      limit: pageSize,
      offset,
    });
    return { ...result, page, pageSize };
  });

  // ---- 批次控制 ----
  handle(router, 'get', '/batches', async (req) => {
    const db = req.ctx.db;
    return { batches: batchService.listBatches(db), current: batchService.getCurrentBatch(db) };
  });

  handle(router, 'post', '/batches', async (req) => {
    const db = req.ctx.db;
    return batchService.createBatch(
      db,
      {
        term: str(req.body?.term),
        name: str(req.body?.name),
        creditLimit: num(req.body?.creditLimit) ?? undefined,
        openAt: req.body?.openAt ?? null,
        closeAt: req.body?.closeAt ?? null,
        note: req.body?.note ?? null,
      },
      req.ctx.user!,
    );
  });

  handle(router, 'patch', '/batches/:batchId', async (req) => {
    const db = req.ctx.db;
    return batchService.updateBatch(
      db,
      idParam(req.params.batchId, 'batchId'),
      {
        name: req.body?.name ?? undefined,
        creditLimit: num(req.body?.creditLimit) ?? undefined,
        openAt: req.body?.openAt,
        closeAt: req.body?.closeAt,
        note: req.body?.note,
      },
      req.ctx.user!,
    );
  });

  handle(router, 'post', '/batches/:batchId/transition', async (req) => {
    const db = req.ctx.db;
    // 通用流转只保留兼容：不再接受 force 绕过校验，
    // 常规管理请使用 /batches/:batchId/actions/:action 下的业务动作。
    return batchService.transitionBatch(
      db,
      idParam(req.params.batchId, 'batchId'),
      str(req.body?.status) as never,
      req.ctx.user!,
      { reason: str(req.body?.reason) || undefined },
    );
  });

  /**
   * 命名业务动作（面向管理员的“下一步按钮”）。
   * 所有校验都在服务端完成，前端隐藏控件之外也无法绕过阶段限制。
   */
  handle(router, 'post', '/batches/:batchId/actions/:action', async (req) => {
    const db = req.ctx.db;
    const batchId = idParam(req.params.batchId, 'batchId');
    const action = str(req.params.action);
    return batchActionsService.runNamedAction(db, batchId, action, req.ctx.user!, (req.body ?? {}) as Record<string, unknown>);
  });

  handle(router, 'get', '/batches/:batchId/submissions', async (req) => {
    const db = req.ctx.db;
    const batchId = idParam(req.params.batchId, 'batchId');
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>, 50);
    const total = (
      db.prepare('SELECT COUNT(*) AS c FROM preference_submissions WHERE batch_id = ?').get(batchId) as { c: number }
    ).c;
    const rows = db
      .prepare(
        `SELECT ps.id, s.student_no AS studentNo, s.name, ps.version_no AS versionNo, ps.status,
                ps.submitted_at AS submittedAt, ps.summary,
                (SELECT COUNT(*) FROM preferences p WHERE p.submission_id = ps.id) AS courseCount
         FROM preference_submissions ps JOIN students s ON s.user_id = ps.student_id
         WHERE ps.batch_id = ? ORDER BY ps.submitted_at DESC LIMIT ? OFFSET ?`,
      )
      .all(batchId, pageSize, offset);
    return { items: rows, total, page, pageSize, pending: preferenceService.pendingConfirmations(db, batchId) };
  });

  handle(router, 'get', '/batches/:batchId/snapshot', async (req) => {
    const db = req.ctx.db;
    const batchId = idParam(req.params.batchId, 'batchId');
    const snapshot = db.prepare('SELECT id, content_hash AS contentHash, frozen_at AS frozenAt FROM batch_snapshots WHERE batch_id = ?').get(batchId);
    if (!snapshot) throw notFound('该批次还没有冻结快照');
    return { snapshot };
  });

  handle(router, 'post', '/batches/:batchId/freeze', async (req) => {
    const db = req.ctx.db;
    // 不再支持 force：需要重新开始时必须走“重新开放志愿提交”，
    // 这样旧快照与旧方案会被统一标记失效。
    return allocationService.freezeBatch(db, idParam(req.params.batchId, 'batchId'), req.ctx.user!);
  });

  handle(router, 'post', '/batches/:batchId/allocate', async (req) => {
    const db = req.ctx.db;
    const batchId = idParam(req.params.batchId, 'batchId');
    const mode = (str(req.body?.mode) || 'simulate') as 'simulate' | 'publish';
    // 耗时计算放进后台任务：接口立即返回任务标识，页面轮询任务状态
    return tasksService.startAllocationTask(db, batchId, req.ctx.user!, {
      mode,
      timeoutMs: num(req.body?.timeoutMs) === null ? config.taskTimeoutMs : Number(req.body?.timeoutMs),
      idempotencyKey: str(req.body?.idempotencyKey) || undefined,
      sourceRunId: num(req.body?.sourceRunId) ?? undefined,
      taskIdempotencyKey: str(req.body?.idempotencyKey) || undefined,
    });
  });

  // 发布指定的、检查通过的试算结果（整体事务，失败回滚）
  handle(router, 'post', '/runs/:runId/publish', async (req) => {
    const db = req.ctx.db;
    const result = allocationService.publishRun(db, idParam(req.params.runId, 'runId'), req.ctx.user!);
    return {
      runId: result.runId,
      status: 'published',
      report: result.report,
      idempotentReplay: result.idempotentReplay,
      alreadyPublished: result.alreadyPublished,
    };
  });

  handle(router, 'get', '/tasks/:taskId', async (req) => {
    const db = req.ctx.db;
    return { task: tasksService.getTask(db, idParam(req.params.taskId, 'taskId')) };
  });

  handle(router, 'get', '/tasks', async (req) => {
    const db = req.ctx.db;
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>, 50);
    const result = tasksService.listTasks(db, {
      batchId: num(req.query.batchId) ?? undefined,
      kind: str(req.query.kind) || undefined,
      limit: pageSize,
      offset,
    });
    return { ...result, page, pageSize };
  });

  handle(router, 'get', '/batches/:batchId/runs', async (req) => {
    const db = req.ctx.db;
    return { runs: allocationService.listRuns(db, idParam(req.params.batchId, 'batchId')) };
  });

  handle(router, 'get', '/runs/:runId', async (req) => {
    const db = req.ctx.db;
    return allocationService.getRun(db, idParam(req.params.runId, 'runId'));
  });

  handle(router, 'post', '/batches/:batchId/enqueue-waitlist', async (req) => {
    const db = req.ctx.db;
    const batchId = idParam(req.params.batchId, 'batchId');
    const runId = num(req.body?.runId);
    const run = runId
      ? ({ id: runId } as { id: number })
      : (db
          .prepare("SELECT id FROM allocation_runs WHERE batch_id = ? AND status = 'published' ORDER BY id DESC LIMIT 1")
          .get(batchId) as { id: number } | undefined);
    if (!run) throw notFound('找不到已发布的分配结果，请先试算并发布');
    const queued = waitlistService.enqueueRejectedFromAllocation(db, batchId, run.id, req.ctx.user!);
    return { queued, runId: run.id };
  });

  // ---- 异常清单 ----
  handle(router, 'get', '/exceptions', async (req) => {
    const db = req.ctx.db;
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>, 50);
    const result = allocationService.listExceptions(db, {
      batchId: num(req.query.batchId) ?? undefined,
      status: str(req.query.status) || undefined,
      limit: pageSize,
      offset,
    });
    return { ...result, page, pageSize };
  });

  handle(router, 'post', '/exceptions/:exceptionId/resolve', async (req) => {
    const db = req.ctx.db;
    allocationService.resolveException(
      db,
      idParam(req.params.exceptionId, 'exceptionId'),
      str(req.body?.resolution) || '管理员已处理',
      (str(req.body?.status) || 'resolved') as 'resolved' | 'ignored',
      req.ctx.user!,
    );
    return { ok: true };
  });

  // ---- 毕业保障 ----
  handle(router, 'get', '/guarantee', async (req) => {
    const db = req.ctx.db;
    const batchId = num(req.query.batchId);
    const conditions = batchId ? 'WHERE gr.batch_id = ?' : '';
    const params = batchId ? [batchId] : [];
    const rows = db
      .prepare(
        `SELECT gr.id, gr.batch_id AS batchId, c.name AS courseName, c.id AS courseId, s.student_no AS studentNo,
                s.name AS studentName, gr.status, gr.reason, gr.confirmed_at AS confirmedAt
         FROM graduation_reservations gr
         JOIN courses c ON c.id = gr.course_id
         JOIN students s ON s.user_id = gr.student_id
         ${conditions} ORDER BY c.name, s.student_no`,
      )
      .all(...params);
    const feasibility = curriculumService.checkGuaranteeForBatch(db, batchId ?? null);
    /**
     * 缺少兜底授权的学生（按“学生 × 课程”逐条判断）。
     * 管理端只能用这个数字做待办提示：兜底授权必须由学生本人确认，
     * 管理员不能代替学生同意退换课，因此这里只返回名单，不提供代建入口。
     */
    const gapRows = batchId
      ? (db
          .prepare(
            `SELECT gr.student_id AS studentId, s.student_no AS studentNo, s.name AS studentName,
                    c.id AS courseId, c.name AS courseName
             FROM graduation_reservations gr
             JOIN courses c ON c.id = gr.course_id
             JOIN students s ON s.user_id = gr.student_id
             WHERE gr.batch_id = ? AND gr.status = 'active'
               AND NOT EXISTS (
                 SELECT 1 FROM guarantee_authorizations ga
                 WHERE ga.student_id = gr.student_id AND ga.batch_id = gr.batch_id
                   AND ga.course_id = gr.course_id AND ga.status = 'active'
               )
             ORDER BY s.student_no, c.name`,
          )
          .all(batchId) as Array<{
          studentId: number;
          studentNo: string;
          studentName: string;
          courseId: number;
          courseName: string;
        }>)
      : [];
    const gapByStudent = new Map<
      number,
      { studentId: number; studentNo: string; studentName: string; courses: string[] }
    >();
    for (const gap of gapRows) {
      const entry =
        gapByStudent.get(gap.studentId) ??
        { studentId: gap.studentId, studentNo: gap.studentNo, studentName: gap.studentName, courses: [] as string[] };
      entry.courses.push(gap.courseName);
      gapByStudent.set(gap.studentId, entry);
    }
    const authorizationGaps = {
      studentCount: gapByStudent.size,
      courseCount: new Set(gapRows.map((gap) => gap.courseId)).size,
      students: Array.from(gapByStudent.values()),
    };
    return { reservations: rows, feasibility, authorizationGaps };
  });

  handle(router, 'post', '/guarantee', async (req) => {
    const db = req.ctx.db;
    return curriculumService.confirmGuarantee(
      db,
      {
        batchId: idParam(req.body?.batchId, 'batchId'),
        courseId: idParam(req.body?.courseId, 'courseId'),
        studentIds: intList(req.body?.studentIds),
        reason: str(req.body?.reason) || undefined,
      },
      req.ctx.user!,
    );
  });

  // 管理员只能查看授权情况，不能代替学生创建替换授权（必须由学生本人同意）
  handle(router, 'get', '/guarantee/authorizations', async (req) => {
    const db = req.ctx.db;
    const batchId = num(req.query.batchId);
    const conditions = batchId ? 'WHERE ua.batch_id = ?' : '';
    const rows = db
      .prepare(
        `SELECT ua.id, ua.student_id AS studentId, s.student_no AS studentNo, s.name AS studentName,
                ua.status, ua.granted_at AS grantedAt, ua.expires_at AS expiresAt, ua.used_at AS usedAt,
                sc.name AS sourceCourseName, tc.name AS targetCourseName
         FROM upgrade_authorizations ua
         JOIN students s ON s.user_id = ua.student_id
         JOIN courses sc ON sc.id = ua.source_course_id
         JOIN courses tc ON tc.id = ua.target_course_id
         ${conditions} ORDER BY ua.id DESC`,
      )
      .all(...(batchId ? [batchId] : []));
    return {
      authorizations: rows,
      guaranteeAuthorizations: curriculumService.listGuaranteeAuthorizations(db, { batchId: batchId ?? undefined }),
      notice: '替换授权与毕业兜底授权都必须由学生本人确认，管理员确认毕业资格不能代替学生同意退换课程。',
    };
  });

  // ---- 资料导入 ----
  const upload = multer({ dest: path.join(config.serverRoot, 'data', 'uploads'), limits: { fileSize: 20 * 1024 * 1024 } });
  router.post(
    '/imports',
    upload.single('file'),
    asyncHandler(async (req, res) => {
      const db = req.ctx.db;
      const file = req.file;
      if (!file) throw new AppError(ERROR_CODES.VALIDATION_FAILED, '请上传文件字段 file', 422);
      const kind = (str(req.body?.kind) || 'courses') as materialsService.ImportKind;
      const preview = materialsService.createImportBatch(db, kind, file.originalname, file.path, req.ctx.user!);
      fs.rmSync(file.path, { force: true });
      ok(res, preview, 201);
    }),
  );

  handle(router, 'get', '/imports', async (req) => {
    const db = req.ctx.db;
    return { batches: materialsService.listImportBatches(db) };
  });

  handle(router, 'post', '/imports/:batchId/publish', async (req) => {
    const db = req.ctx.db;
    return materialsService.publishImportBatch(db, idParam(req.params.batchId, 'batchId'), req.ctx.user!, {
      programCode: str(req.body?.programCode) || undefined,
      term: str(req.body?.term) || undefined,
    });
  });

  handle(router, 'get', '/versions', async (req) => {
    const db = req.ctx.db;
    return { versions: materialsService.listDataVersions(db, str(req.query.scope) || undefined) };
  });

  // ---- 预分配 ----
  handle(router, 'get', '/preallocations', async (req) => {
    const db = req.ctx.db;
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>, 50);
    const result = preallocationService.listPreallocations(db, {
      batchId: num(req.query.batchId) ?? undefined,
      status: str(req.query.status) || undefined,
      limit: pageSize,
      offset,
    });
    const validation = preallocationService.validatePreallocations(db, num(req.query.batchId));
    return { ...result, validation, page, pageSize };
  });

  handle(router, 'post', '/preallocations/apply', async (req) => {
    const db = req.ctx.db;
    return preallocationService.applyPreallocations(db, num(req.body?.batchId), req.ctx.user!, {
      term: str(req.body?.term) || undefined,
    });
  });

  handle(router, 'post', '/preallocations/:id/revert', async (req) => {
    const db = req.ctx.db;
    return preallocationService.revertPreallocation(db, idParam(req.params.id, 'id'), req.ctx.user!);
  });

  // ---- 操作记录 ----
  handle(router, 'get', '/audit', async (req) => {
    const db = req.ctx.db;
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>, 50);
    const result = listAudit(db, { limit: pageSize, offset, action: str(req.query.action) || undefined });
    // 与其它管理端列表保持一致：统一用 items 字段
    return { items: result.rows, total: result.total, page, pageSize };
  });

  handle(router, 'get', '/operations', async (req) => {
    const db = req.ctx.db;
    const { page, pageSize, offset } = pagination(req.query as Record<string, unknown>, 50);
    const total = (db.prepare('SELECT COUNT(*) AS c FROM enrollment_operations').get() as { c: number }).c;
    const rows = db
      .prepare(
        `SELECT eo.id, eo.op_type AS opType, eo.status, eo.error_code AS errorCode, eo.message,
                eo.created_at AS createdAt, s.student_no AS studentNo, s.name AS studentName,
                eo.target_class_id AS targetClassId, eo.source_class_id AS sourceClassId
         FROM enrollment_operations eo LEFT JOIN students s ON s.user_id = eo.student_id
         ORDER BY eo.id DESC LIMIT ? OFFSET ?`,
      )
      .all(pageSize, offset);
    return { items: rows, total, page, pageSize };
  });

  handle(router, 'get', '/stats', async (req) => {
    const db = req.ctx.db;
    const stats = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM students) AS students,
           (SELECT COUNT(*) FROM courses) AS courses,
           (SELECT COUNT(*) FROM teaching_classes) AS classes,
           (SELECT COUNT(*) FROM enrollments WHERE status = 'enrolled') AS enrollments,
           (SELECT COUNT(*) FROM waitlist_entries WHERE status = 'queued') AS waiting,
           (SELECT COUNT(*) FROM waitlist_entries WHERE status = 'suspended') AS suspended,
           (SELECT COUNT(*) FROM exceptions WHERE status = 'open') AS openExceptions`,
      )
      .get();
    return { stats };
  });

  app.use('/api/admin', router);
}

/**
 * 把服务层返回的失败结果翻译成 HTTP 错误。
 * 并发/状态类失败必须是 409（前端要区分“参数错了”和“当前不允许”）。
 */
const CONFLICT_CODES: string[] = [
  ERROR_CODES.NO_CAPACITY,
  ERROR_CODES.RESERVED_CAPACITY_ONLY,
  ERROR_CODES.TIME_CONFLICT,
  ERROR_CODES.DUPLICATE_COURSE,
  ERROR_CODES.CREDIT_LIMIT_EXCEEDED,
  ERROR_CODES.CLASS_CLOSED,
  ERROR_CODES.CLASS_CANCELLED,
  ERROR_CODES.BATCH_FROZEN,
  ERROR_CODES.BATCH_STATE_INVALID,
  ERROR_CODES.AUTHORIZATION_INVALIDATED,
  ERROR_CODES.AUTHORIZATION_SUSPENDED,
  ERROR_CODES.MATERIAL_NOT_CONFIRMED,
  ERROR_CODES.GRADUATION_INFEASIBLE,
  ERROR_CODES.IDEMPOTENCY_MISMATCH,
  ERROR_CODES.CONSTRAINT_VIOLATION,
  ERROR_CODES.NOT_ELIGIBLE,
];

function toAppError(error: { code?: string; message?: string; details?: Record<string, unknown> } | undefined, fallback: string): AppError {
  const code = (error?.code ?? ERROR_CODES.INTERNAL) as never;
  const status = error?.code === ERROR_CODES.NO_ENROLLMENT ? 404 : CONFLICT_CODES.includes(error?.code ?? '') ? 409 : 400;
  return new AppError(code, error?.message ?? fallback, status, error?.details);
}

/** 供测试直接使用：从请求上下文拿数据库 */
export function requestDb(req: AppRequest) {
  return req.ctx.db ?? getDatabase();
}
