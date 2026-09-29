/**
 * 正式选课服务 —— 唯一可以占用/释放名额的模块。
 *
 * 其他模块（预分配校验、统一分配、候补提升、授权升级、管理员手工调整）
 * 都必须通过这里执行，保证规则只有一套。
 *
 * 关键约定：
 *   1) 一次操作 = 一个数据库事务，失败整体回滚（不会出现“退了原课却没选上目标课”）；
 *   2) 先检查替换后的完整课表，再在同一事务内落实目标课并释放原课；
 *   3) 反复提交同一个 idempotencyKey 不会重复执行；
 *   4) 名额在事务内用数据库的实际计数复核，不信任调用方传来的数字。
 */
import type { SqliteDb } from '../../db/index.js';
import { AppError, ERROR_CODES, noCapacity, notFound } from '../../core/errors.js';
import { contentHash, nowIso } from '../../core/utils.js';
import { writeAudit } from '../../core/audit.js';
import type { AuthUser } from '../../core/context.js';
import { evaluateSchedule, getCreditLimit } from '../rules/service.js';
import { getSeatUsage, getClassDto, type ClassDto } from '../catalog/service.js';

export type EnrollmentSource = 'preallocation' | 'allocation' | 'guarantee' | 'waitlist' | 'upgrade' | 'manual';

export interface OperationResult {
  ok: boolean;
  opType: 'enroll' | 'drop' | 'swap' | 'replace' | 'upgrade' | 'allocate' | 'promote' | 'preallocate';
  idempotentReplay: boolean;
  enrolledClass?: ClassDto | null;
  releasedClass?: ClassDto | null;
  enrollmentId?: number;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  messages?: string[];
}

interface OperationOptions {
  source?: EnrollmentSource;
  /** 幂等键：同一次用户意图重复提交时复用 */
  idempotencyKey?: string;
  batchId?: number | null;
  allocationRunId?: number | null;
  /** 允许使用毕业预留名额（分配/兜底/候补提升/管理员操作） */
  allowReserved?: boolean;
  actor?: AuthUser | null;
  reason?: string;
  /** 授权升级时关联的授权记录 */
  authorizationId?: number | null;
  /** 跳过幂等记录（内部调用时使用，例如候补提升已由外层记录） */
  skipOperationLog?: boolean;
  /** 允许突破“批次冻结”等状态限制（管理员显式操作时使用） */
  allowFrozen?: boolean;
}

interface EnrollmentRow {
  id: number;
  student_id: number;
  class_id: number;
  course_id: number;
  status: string;
  source: string;
  uses_reserved: number;
}

const ALLOWED_OP_TYPES = ['enroll', 'drop', 'swap', 'replace', 'upgrade', 'allocate', 'promote', 'preallocate'] as const;

function findOperationByKey(
  db: SqliteDb,
  studentId: number,
  opType: string,
  idempotencyKey: string,
): {
  id: number;
  status: string;
  message: string | null;
  error_code: string | null;
  detail: string | null;
  request_hash: string | null;
} | undefined {
  return db
    .prepare(
      `SELECT id, status, message, error_code, detail, request_hash FROM enrollment_operations
       WHERE student_id = ? AND idempotency_key = ? AND op_type = ?`,
    )
    .get(studentId, idempotencyKey, opType) as
    | {
        id: number;
        status: string;
        message: string | null;
        error_code: string | null;
        detail: string | null;
        request_hash: string | null;
      }
    | undefined;
}

function recordOperation(
  db: SqliteDb,
  input: {
    studentId: number;
    actor?: AuthUser | null;
    opType: OperationResult['opType'];
    idempotencyKey?: string;
    requestHash?: string;
    sourceClassId?: number | null;
    targetClassId?: number | null;
    targetCourseId?: number | null;
    authorizationId?: number | null;
    status: 'succeeded' | 'failed';
    errorCode?: string | null;
    message?: string | null;
    detail?: unknown;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO enrollment_operations
       (student_id, actor_id, op_type, idempotency_key, request_hash, source_class_id, target_class_id,
        target_course_id, authorization_id, status, error_code, message, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.studentId,
      input.actor?.id ?? null,
      input.opType,
      input.idempotencyKey ?? null,
      input.requestHash ?? null,
      input.sourceClassId ?? null,
      input.targetClassId ?? null,
      input.targetCourseId ?? null,
      input.authorizationId ?? null,
      input.status,
      input.errorCode ?? null,
      input.message ?? null,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      nowIso(),
    );
  return Number(info.lastInsertRowid);
}

function activeEnrollmentForCourse(db: SqliteDb, studentId: number, courseId: number): EnrollmentRow | undefined {
  return db
    .prepare(
      `SELECT id, student_id, class_id, course_id, status, source, uses_reserved FROM enrollments
       WHERE student_id = ? AND course_id = ? AND status = 'enrolled'`,
    )
    .get(studentId, courseId) as EnrollmentRow | undefined;
}

function activeEnrollmentForClass(db: SqliteDb, studentId: number, classId: number): EnrollmentRow | undefined {
  return db
    .prepare(
      `SELECT id, student_id, class_id, course_id, status, source, uses_reserved FROM enrollments
       WHERE student_id = ? AND class_id = ? AND status = 'enrolled'`,
    )
    .get(studentId, classId) as EnrollmentRow | undefined;
}

export class EnrollmentService {
  constructor(private readonly db: SqliteDb) {}

  /** 学生当前有效课表 */
  listActive(studentId: number): ClassDto[] {
    const rows = this.db
      .prepare(
        `SELECT class_id FROM enrollments WHERE student_id = ? AND status = 'enrolled' ORDER BY id`,
      )
      .all(studentId) as Array<{ class_id: number }>;
    return rows.map((r) => getClassDto(this.db, r.class_id));
  }

  /**
   * 新增选课。
   * 目标教学班满员时，会在同一门课程内按 personal 偏好顺序尝试其它教学班
   * （偏好顺序由调用方通过 fallbackClassIds 传入，统一分配时即“个人教学班偏好”）。
   */
  enroll(studentId: number, classId: number, options: OperationOptions = {}): OperationResult {
    return this.mutate(
      studentId,
      {
        opType: 'enroll',
        targetClassId: classId,
        removeClassIds: [],
        addClassIds: [classId],
      },
      options,
    );
  }

  /**
   * 同一课程内换班：目标班落实与释放原班在同一事务内完成。
   * 跨课程换课请使用 replace。
   */
  swap(studentId: number, fromClassId: number, toClassId: number, options: OperationOptions = {}): OperationResult {
    return this.mutate(
      studentId,
      {
        opType: 'swap',
        targetClassId: toClassId,
        sourceClassId: fromClassId,
        removeClassIds: [fromClassId],
        addClassIds: [toClassId],
      },
      options,
    );
  }

  /**
   * 一对一替换：用目标教学班替换原教学班（可以跨课程）。
   * 先检查“替换后的完整课表”，失败时保留原课。
   */
  replace(studentId: number, fromClassId: number, toClassId: number, options: OperationOptions = {}): OperationResult {
    return this.mutate(
      studentId,
      {
        opType: 'replace',
        targetClassId: toClassId,
        sourceClassId: fromClassId,
        removeClassIds: [fromClassId],
        addClassIds: [toClassId],
      },
      options,
    );
  }

  /** 授权升级：目标课程 + 被替换的原课程由授权记录明确指定 */
  upgrade(studentId: number, authorizationId: number, options: OperationOptions = {}): OperationResult {
    const auth = this.db
      .prepare(
        `SELECT id, student_id, batch_id, source_course_id, source_class_id, target_course_id, target_class_id, status, version_id, expires_at
         FROM upgrade_authorizations WHERE id = ?`,
      )
      .get(authorizationId) as
      | {
          id: number;
          student_id: number;
          batch_id: number | null;
          source_course_id: number;
          source_class_id: number;
          target_course_id: number;
          target_class_id: number | null;
          status: string;
          version_id: number | null;
          expires_at: string | null;
        }
      | undefined;
    if (!auth || auth.student_id !== studentId) throw notFound('授权记录不存在');
    if (auth.status === 'invalidated' || auth.status === 'revoked') {
      throw new AppError(ERROR_CODES.AUTHORIZATION_INVALIDATED, '授权已失效，请重新确认', 409);
    }
    if (auth.status !== 'active' && auth.status !== 'pending') {
      throw new AppError(ERROR_CODES.AUTHORIZATION_SUSPENDED, `授权当前状态为 ${auth.status}，暂不能自动升级`, 409);
    }
    if (auth.expires_at && new Date(auth.expires_at).getTime() <= Date.now()) {
      this.db.prepare("UPDATE upgrade_authorizations SET status = 'invalidated', invalidated_at = ? WHERE id = ?").run(nowIso(), auth.id);
      throw new AppError(ERROR_CODES.AUTHORIZATION_INVALIDATED, '授权已过期，请重新确认', 409);
    }

    const targetClassId =
      auth.target_class_id ??
      this.pickTargetClass(auth.target_course_id, studentId, []);
    if (!targetClassId) {
      throw new AppError(ERROR_CODES.NO_CAPACITY, '目标课程当前没有可用教学班', 409);
    }

    const result = this.mutate(
      studentId,
      {
        opType: 'upgrade',
        targetClassId,
        sourceClassId: auth.source_class_id,
        removeClassIds: [auth.source_class_id],
        addClassIds: [targetClassId],
      },
      { ...options, authorizationId: auth.id, batchId: auth.batch_id ?? options.batchId ?? null },
    );
    if (result.ok) {
      this.db.prepare("UPDATE upgrade_authorizations SET status = 'used', used_at = ? WHERE id = ?").run(nowIso(), auth.id);
    }
    return result;
  }

  /** 退课：只释放名额，不影响其它课程 */
  drop(studentId: number, classId: number, options: OperationOptions = {}): OperationResult {
    const now = nowIso();
    const opType = 'drop' as const;
    const key = options.idempotencyKey;

    if (key) {
      const existing = findOperationByKey(this.db, studentId, opType, key);
      if (existing) {
        return {
          ok: existing.status === 'succeeded',
          opType,
          idempotentReplay: true,
          error:
            existing.status === 'succeeded'
              ? undefined
              : { code: existing.error_code ?? ERROR_CODES.INTERNAL, message: existing.message ?? '上次操作失败' },
        };
      }
    }

    try {
      const result = this.db.transaction((): OperationResult => {
        // 退课同样受批次阶段约束：冻结期与结束后都不能改选
        this.assertBatchWritable(options);
        const row = activeEnrollmentForClass(this.db, studentId, classId);
        if (!row) throw new AppError(ERROR_CODES.NO_ENROLLMENT, '没有找到该教学班的有效选课记录', 404);
        this.db
          .prepare("UPDATE enrollments SET status = 'dropped', dropped_at = ?, updated_at = ?, reason = ? WHERE id = ?")
          .run(now, now, options.reason ?? null, row.id);
        if (options.source === 'manual' || !options.source) {
          this.db.prepare('DELETE FROM waitlist_entries WHERE student_id = ? AND course_id = ? AND status = ?').run(
            studentId,
            row.course_id,
            'queued',
          );
        }
        // 受保护学生主动退课后，毕业保障视为“主动放弃”，再次保护需要管理员重新确认。
        // 同课换班成功、校方取消课程不经过这里，因此不会被误判为主动放弃。
        if (!options.allowFrozen) {
          this.db
            .prepare(
              `UPDATE graduation_reservations SET status = 'revoked', released_at = ?
               WHERE student_id = ? AND course_id = ? AND status IN ('active', 'fulfilled')`,
            )
            .run(now, studentId, row.course_id);
          this.db
            .prepare(
              `UPDATE guarantee_authorizations SET status = 'revoked', revoked_at = ?
               WHERE student_id = ? AND course_id = ? AND status = 'active'`,
            )
            .run(now, studentId, row.course_id);
        }
        const opId = options.skipOperationLog
          ? 0
          : recordOperation(this.db, {
              studentId,
              actor: options.actor ?? null,
              opType,
              idempotencyKey: key,
              sourceClassId: classId,
              targetCourseId: row.course_id,
              status: 'succeeded',
              message: '退课成功',
            });
        writeAudit(this.db, {
          actorId: options.actor?.id ?? studentId,
          action: 'enrollment.drop',
          entityType: 'enrollment',
          entityId: row.id,
          summary: `退课：教学班 ${classId}`,
          detail: { operationId: opId, reason: options.reason ?? null },
        });
        const released = getClassDto(this.db, classId);
        return { ok: true, opType, idempotentReplay: false, releasedClass: released, enrollmentId: row.id };
      })();
      this.promoteForClass(classId);
      notifyStudentChange(this.db, studentId, options.batchId);
      return result;
    } catch (error) {
      return this.failOperation(studentId, opType, key, error, options, { sourceClassId: classId });
    }
  }

  /** 统一分配/候选提升等内部调用：直接落实名额并返回结果，不抛异常 */
  allocateTo(
    studentId: number,
    classId: number,
    options: OperationOptions & { opType?: OperationResult['opType'] } = {},
  ): OperationResult {
    return this.mutate(
      studentId,
      {
        opType: options.opType ?? 'allocate',
        targetClassId: classId,
        removeClassIds: [],
        addClassIds: [classId],
      },
      { allowReserved: true, ...options },
    );
  }

  /**
   * 核心事务：可选地释放原课 + 落实目标课。
   * 所有写名额的入口最终都汇到这里。
   */
  private mutate(
    studentId: number,
    plan: {
      opType: OperationResult['opType'];
      addClassIds: number[];
      removeClassIds: number[];
      sourceClassId?: number;
      targetClassId: number;
    },
    options: OperationOptions,
  ): OperationResult {
    const key = options.idempotencyKey;
    const requestHash = contentHash({ studentId, ...plan });
    if (key) {
      const existing = findOperationByKey(this.db, studentId, plan.opType, key);
      if (existing) {
        if (existing.request_hash && existing.request_hash !== requestHash) {
          return {
            ok: false,
            opType: plan.opType,
            idempotentReplay: true,
            error: {
              code: ERROR_CODES.IDEMPOTENCY_MISMATCH,
              message: '幂等键已被不同的请求使用，请更换幂等键后重试',
            },
          };
        }
        return {
          ok: existing.status === 'succeeded',
          opType: plan.opType,
          idempotentReplay: true,
          error:
            existing.status === 'succeeded'
              ? undefined
              : { code: existing.error_code ?? ERROR_CODES.INTERNAL, message: existing.message ?? '上次操作失败' },
        };
      }
    }

    try {
      const result = this.db.transaction((): OperationResult => {
        this.assertBatchWritable(options);
        const targetClass = getClassDto(this.db, plan.targetClassId);
        if (targetClass.status === 'cancelled') {
          throw new AppError(ERROR_CODES.CLASS_CANCELLED, '该教学班已取消', 409);
        }
        if (targetClass.status === 'closed') {
          throw new AppError(ERROR_CODES.CLASS_CLOSED, '该教学班已关闭选课', 409);
        }

        // 已经选上同一门课：只有换班（同课程）允许，其它情况视为重复选课
        const existingForCourse = activeEnrollmentForCourse(this.db, studentId, targetClass.courseId);
        if (existingForCourse && !plan.removeClassIds.includes(existingForCourse.class_id)) {
          if (existingForCourse.class_id === plan.targetClassId) {
            throw new AppError(ERROR_CODES.DUPLICATE_COURSE, '你已经选中该教学班，无需重复选择', 409);
          }
          throw new AppError(
            ERROR_CODES.DUPLICATE_COURSE,
            '同一门课程只能有一条有效记录：如需换班请使用“同课换班”，如需修读其他课程请先退掉原课程',
            409,
          );
        }

        // 替代组一致性（首轮、候补、手动补选、替换共用同一约束）
        this.assertSubstituteGroup(studentId, options.batchId, targetClass.courseId);

        // 检查替换后的完整课表
        const evaluation = evaluateSchedule(this.db, studentId, plan.addClassIds, {
          removeClassIds: plan.removeClassIds,
          creditLimit: getCreditLimit(this.db, studentId),
        });
        if (evaluation.duplicateCourseIds.length > 0) {
          throw new AppError(ERROR_CODES.DUPLICATE_COURSE, '替换后的课表存在重复课程', 409, {
            courses: evaluation.duplicateCourseIds,
          });
        }
        if (evaluation.conflicts.length > 0) {
          throw new AppError(ERROR_CODES.TIME_CONFLICT, evaluation.messages[0] ?? '时间冲突', 409, {
            conflicts: evaluation.conflicts,
          });
        }
        if (evaluation.credits > evaluation.creditLimit) {
          throw new AppError(
            ERROR_CODES.CREDIT_LIMIT_EXCEEDED,
            `替换后总学分 ${evaluation.credits} 超过上限 ${evaluation.creditLimit}`,
            409,
            { credits: evaluation.credits, limit: evaluation.creditLimit },
          );
        }

        // 在同一事务内：先释放原课，再占用目标课
        let released: ClassDto | null = null;
        if (plan.removeClassIds.length > 0) {
          const now = nowIso();
          for (const removeId of plan.removeClassIds) {
            const row = activeEnrollmentForClass(this.db, studentId, removeId);
            if (!row) {
              throw new AppError(ERROR_CODES.NO_ENROLLMENT, '原课程记录不存在，无法执行替换', 409);
            }
            this.db
              .prepare("UPDATE enrollments SET status = 'dropped', dropped_at = ?, updated_at = ?, reason = ? WHERE id = ?")
              .run(now, now, options.reason ?? '替换释放', row.id);
            released = released ?? getClassDto(this.db, removeId);
          }
        }

        const seat = this.claimSeat(targetClass, options.allowReserved ?? false);
        const now = nowIso();
        const info = this.db
          .prepare(
            `INSERT INTO enrollments
             (student_id, class_id, course_id, status, source, uses_reserved, batch_id, allocation_run_id, granted_credit, reason, created_at, updated_at)
             VALUES (?, ?, ?, 'enrolled', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            studentId,
            targetClass.id,
            targetClass.courseId,
            options.source ?? 'manual',
            seat.usesReserved ? 1 : 0,
            options.batchId ?? null,
            options.allocationRunId ?? null,
            null,
            options.reason ?? null,
            now,
            now,
          );
        const enrollmentId = Number(info.lastInsertRowid);

        const opId = options.skipOperationLog
          ? 0
          : recordOperation(this.db, {
              studentId,
              actor: options.actor ?? null,
              opType: plan.opType,
              idempotencyKey: key,
              requestHash,
              sourceClassId: plan.sourceClassId ?? null,
              targetClassId: targetClass.id,
              targetCourseId: targetClass.courseId,
              authorizationId: options.authorizationId ?? null,
              status: 'succeeded',
              message: `${plan.opType} 成功`,
              detail: { enrollmentId, usesReserved: seat.usesReserved, credit: evaluation.credits },
            });
        writeAudit(this.db, {
          actorId: options.actor?.id ?? studentId,
          action: `enrollment.${plan.opType}`,
          entityType: 'enrollment',
          entityId: enrollmentId,
          summary: `${plan.opType}：${targetClass.courseName} ${targetClass.classCode}`,
          detail: {
            operationId: opId,
            source: options.source ?? 'manual',
            usesReserved: seat.usesReserved,
            credits: evaluation.credits,
            released: released ? { classId: released.id } : null,
          },
        });

        return {
          ok: true,
          opType: plan.opType,
          idempotentReplay: false,
          enrolledClass: targetClass,
          releasedClass: released,
          enrollmentId,
        };
      })();

      if (plan.removeClassIds.length > 0) {
        for (const classId of plan.removeClassIds) {
          this.promoteForClass(classId);
        }
        // 释放了原课：学生自己的候补申请需要按最新课表重新评估
        notifyStudentChange(this.db, studentId, options.batchId);
      }
      return result;
    } catch (error) {
      return this.failOperation(studentId, plan.opType, key, error, options, {
        sourceClassId: plan.sourceClassId ?? null,
        targetClassId: plan.targetClassId,
      });
    }
  }

  /**
   * 在事务内复核名额并占用。
   * 复核的意义：并发/重复请求下，最终判断依据是数据库中的真实计数，
   * 而不是之前读到的缓存值，因此不会超额。
   */
  private claimSeat(targetClass: ClassDto, allowReserved: boolean): { usesReserved: boolean } {
    const usage = getSeatUsage(this.db, targetClass.id);
    if (usage.generalAvailable > 0 && !allowReserved) {
      return { usesReserved: false };
    }
    if (allowReserved) {
      if (usage.totalAvailable > 0) {
        return { usesReserved: usage.generalAvailable <= 0 };
      }
      throw noCapacity(`${targetClass.courseName} ${targetClass.classCode} 名额已满`, {
        capacity: usage.capacity,
        enrolled: usage.enrolled,
      });
    }
    if (usage.totalAvailable <= 0) {
      throw noCapacity(`${targetClass.courseName} ${targetClass.classCode} 名额已满`, {
        capacity: usage.capacity,
        enrolled: usage.enrolled,
      });
    }
    // 还剩名额但只剩预留名额：普通申请不能占用
    throw new AppError(
      ERROR_CODES.RESERVED_CAPACITY_ONLY,
      `${targetClass.courseName} ${targetClass.classCode} 目前只剩毕业保障预留名额，普通申请需等待预留释放`,
      409,
      { reservedSeats: usage.reservedSeats, capacity: usage.capacity, enrolled: usage.enrolled },
    );
  }

  /** 校验批次阶段是否允许当前写入 */
  private assertBatchWritable(options: OperationOptions): void {
    // 内部系统操作（预分配、统一分配发布、候补提升）显式声明 allowFrozen，不受阶段限制
    if (options.allowFrozen) return;
    const row = options.batchId
      ? (this.db.prepare('SELECT id, status FROM selection_batches WHERE id = ?').get(options.batchId) as
          | { id: number; status: string }
          | undefined)
      : (this.db
          .prepare("SELECT id, status FROM selection_batches WHERE status NOT IN ('closed') ORDER BY id DESC LIMIT 1")
          .get() as { id: number; status: string } | undefined);
    // 首轮之前（preparing / preview / open / frozen）与结束后都不允许直接占用或释放名额
    if (!row) {
      throw new AppError(ERROR_CODES.BATCH_STATE_INVALID, '当前没有开放正式选退课的选课活动，请等待管理员开放', 409);
    }
    // 只有管理员主动“开放退改选”（waitlist 阶段）后才允许正式选退换课。
    // 首轮结果刚发布（published）时学生只能查看结果，这是与发布相互独立的动作。
    if (row.status === 'waitlist') return;
    if (row.status === 'published') {
      throw new AppError(
        ERROR_CODES.BATCH_STATE_INVALID,
        '首轮结果已公布，管理员尚未开放退改选：现在只能查看结果，暂时不能选课或退课',
        409,
      );
    }
    if (row.status === 'frozen') {
      throw new AppError(ERROR_CODES.BATCH_FROZEN, '本轮已结束志愿提交，方案生成与发布期间不能改选', 409);
    }
    if (row.status === 'closed') {
      throw new AppError(ERROR_CODES.BATCH_STATE_INVALID, '本次选课已结束，不能再改选', 409);
    }
    throw new AppError(
      ERROR_CODES.BATCH_STATE_INVALID,
      `当前处于「${row.status === 'preparing' ? '资料准备' : '预选进行中'}」阶段：正式选退课在管理员开放退改选之后才可用`,
      409,
    );
  }

  /**
   * 替代组一致性：同一替代组最多落实一门。
   * 首轮、候补、手动补选与替换都走这里，保证约束在所有入口一致。
   */
  private assertSubstituteGroup(studentId: number, batchId: number | null | undefined, targetCourseId: number): void {
    if (!batchId) return;
    const rows = this.db
      .prepare(
        `SELECT pg.code, pgc.course_id
         FROM preference_submissions ps
         JOIN preference_groups pg ON pg.submission_id = ps.id
         JOIN preference_group_courses pgc ON pgc.group_id = pg.id
         WHERE ps.student_id = ? AND ps.batch_id = ? AND ps.status = 'submitted'`,
      )
      .all(studentId, batchId) as Array<{ code: string; course_id: number }>;
    if (rows.length === 0) return;
    const groupOfTarget = rows.find((r) => r.course_id === targetCourseId)?.code;
    if (!groupOfTarget) return;
    const groupCourseIds = rows.filter((r) => r.code === groupOfTarget).map((r) => r.course_id);
    const enrolled = this.db
      .prepare(
        `SELECT DISTINCT course_id FROM enrollments
         WHERE student_id = ? AND status = 'enrolled' AND course_id IN (${groupCourseIds.map(() => '?').join(',')})`,
      )
      .all(studentId, ...groupCourseIds) as Array<{ course_id: number }>;
    const conflict = enrolled.find((e) => e.course_id !== targetCourseId);
    if (conflict) {
      throw new AppError(
        ERROR_CODES.SUBSTITUTE_GROUP_VIOLATION,
        `替代组「${groupOfTarget}」已落实一门课程，组内不再重复落实`,
        409,
        { groupCode: groupOfTarget, fulfilledCourseId: conflict.course_id },
      );
    }
  }

  private failOperation(
    studentId: number,
    opType: OperationResult['opType'],
    key: string | undefined,
    error: unknown,
    options: OperationOptions,
    extra: { sourceClassId?: number | null; targetClassId?: number | null },
  ): OperationResult {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(ERROR_CODES.CONSTRAINT_VIOLATION, error instanceof Error ? error.message : '操作失败', 409);
    if (key && !options.skipOperationLog) {
      const existing = findOperationByKey(this.db, studentId, opType, key);
      if (!existing) {
        recordOperation(this.db, {
          studentId,
          actor: options.actor ?? null,
          opType,
          idempotencyKey: key,
          // 失败记录同样保存请求哈希：重放同一个幂等键时可以识别出是不同请求
          requestHash: contentHash({ studentId, opType, ...extra }),
          sourceClassId: extra.sourceClassId ?? null,
          targetClassId: extra.targetClassId ?? null,
          status: 'failed',
          errorCode: appError.code,
          message: appError.message,
          detail: appError.details ?? null,
        });
      }
    }
    return {
      ok: false,
      opType,
      idempotentReplay: false,
      error: { code: appError.code, message: appError.message, details: appError.details },
    };
  }

  /**
   * 名额释放后尝试提升候补。
   * 规则：名额先处理合格候补；没有合格候补、且名额不受保护时，才允许公开补选。
   */
  private promoteForClass(classId: number): void {
    // 候补提升实现由 waitlist 模块注册（避免循环依赖）
    if (!promoteImpl) return;
    try {
      promoteImpl(this.db, classId);
    } catch (error) {
      // 候补提升失败不能影响已经成功的选退课
      writeAudit(this.db, {
        action: 'waitlist.promote_failed',
        entityType: 'teaching_class',
        entityId: classId,
        summary: '名额释放后候补提升失败',
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /** 在同课程内按给定教学班偏好挑选一个仍可占用的目标班 */
  private pickTargetClass(courseId: number, studentId: number, preferredClassIds: number[]): number | null {
    const classes = this.db
      .prepare("SELECT id FROM teaching_classes WHERE course_id = ? AND status = 'open'")
      .all(courseId) as Array<{ id: number }>;
    const ordered = [
      ...preferredClassIds.filter((id) => classes.some((c) => c.id === id)),
      ...classes.map((c) => c.id).filter((id) => !preferredClassIds.includes(id)),
    ];
    for (const classId of ordered) {
      const usage = getSeatUsage(this.db, classId);
      if (usage.generalAvailable > 0 || usage.totalAvailable > 0) return classId;
    }
    void studentId;
    return null;
  }
}

/** 候补模块通过回调注入，避免循环 import */
type PromoteFn = (db: SqliteDb, classId: number) => void;
let promoteImpl: PromoteFn | null = null;

export function registerWaitlistPromotion(fn: PromoteFn): void {
  promoteImpl = fn;
}

/**
 * 学生课表/授权变化后的重新评估回调（由候补模块注入）。
 * 选退课、换班、替换、授权变化后都要按最新状态重排候补。
 */
type RecheckFn = (db: SqliteDb, studentId: number, batchId: number) => void;
let recheckImpl: RecheckFn | null = null;

export function registerStudentChangeRecheck(fn: RecheckFn): void {
  recheckImpl = fn;
}

function notifyStudentChange(db: SqliteDb, studentId: number, batchId: number | null | undefined): void {
  if (!recheckImpl || !batchId) return;
  try {
    recheckImpl(db, studentId, batchId);
  } catch {
    // 重新评估失败不能影响已经成功的选退课
  }
}

export const ALLOWED_ENROLLMENT_OP_TYPES = ALLOWED_OP_TYPES;
