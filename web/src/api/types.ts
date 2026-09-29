/**
 * 前端使用的接口数据类型。
 *
 * 说明：这里只描述后端 `server/src/routes/index.ts` 实际返回的字段；
 * 所有业务规则（名额、冲突、资格、学分）都由后端判定，前端不做任何推断。
 */

export type Role = 'student' | 'admin';

export interface StudentInfo {
  studentNo: string;
  name: string;
  grade: string | null;
  major: string | null;
  programId: number | null;
}

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  student?: StudentInfo;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/* ------------------------------ 批次 ------------------------------ */

export type BatchStatus = 'preparing' | 'preview' | 'open' | 'frozen' | 'published' | 'waitlist' | 'closed';

export interface BatchSubmissions {
  submitted: number;
  withdrawn: number;
  students: number;
}

export interface BatchDto {
  id: number;
  term: string;
  name: string;
  status: BatchStatus;
  creditLimit: number;
  openAt: string | null;
  closeAt: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  note: string | null;
  createdAt: string;
  submissions: BatchSubmissions;
  snapshotHash: string | null;
  configReady: boolean;
  configIssues: string[];
}

/* --------------------------- 课程 / 教学班 --------------------------- */

export interface SessionDto {
  id: number;
  dayOfWeek: number;
  periodStart: number;
  periodEnd: number;
  weekStart: number;
  weekEnd: number;
  weekParity: 'all' | 'odd' | 'even';
  room: string | null;
  text: string;
}

export interface TeacherDto {
  id: number;
  name: string;
  department: string | null;
  title: string | null;
  /** 教师信息为演示模拟配置 */
  isDemo?: boolean;
}

export interface ClassDto {
  id: number;
  classCode: string;
  term: string;
  courseId: number;
  courseCode: string;
  courseName: string;
  credits: number;
  courseType: string;
  department: string | null;
  teacher: TeacherDto | null;
  status: 'open' | 'closed' | 'cancelled';
  campus: string | null;
  note: string | null;
  /** 教学班时间 / 容量 / 教师是否为演示模拟配置 */
  isDemo?: boolean;
  sessions: SessionDto[];
  capacity: number;
  reservedSeats: number;
  enrolled: number;
  usedReserved: number;
  generalAvailable: number;
  totalAvailable: number;
}

export interface CourseDto {
  id: number;
  code: string;
  name: string;
  credits: number;
  department: string | null;
  courseType: string;
  description: string | null;
  classCount: number;
  totalCapacity: number;
  totalAvailable: number;
}

export interface CourseDetail extends CourseDto {
  classes: ClassDto[];
}

export interface ScheduleConflict {
  leftClassId: number;
  leftCourseName: string;
  rightClassId: number;
  rightCourseName: string;
  leftText: string;
  rightText: string;
  weeks: number[];
}

export interface ScheduleEvaluation {
  credits: number;
  creditLimit: number;
  conflicts: ScheduleConflict[];
  duplicateCourseIds: number[];
  ok: boolean;
  messages: string[];
}

export interface DemandAssessment {
  courseId: number;
  demandLevel: 'D2' | 'D1' | 'D0';
  reasons: string[];
  requirementId: number | null;
  requirementName: string | null;
  graduationNecessary: boolean;
}

export interface PublicSupplement {
  allowed: boolean;
  reason: string;
  qualifiedWaitlist: number;
  protectedSeats: number;
}

export interface Eligibility {
  class: ClassDto;
  evaluation: ScheduleEvaluation;
  demand: DemandAssessment | null;
  supplement: PublicSupplement;
  canEnroll: boolean;
}

export interface EnrollmentOperationResult {
  ok: boolean;
  opType: string;
  idempotentReplay: boolean;
  enrollmentId?: number;
  enrolledClass?: ClassDto | null;
  releasedClass?: ClassDto | null;
  messages?: string[];
}

export interface TimetableClassEntry {
  classId: number;
  courseName: string;
  classCode: string;
  credits: number;
  source: string;
  usesReserved: boolean;
  sessions: string[];
}

export interface TimetablePayload {
  classes: TimetableClassEntry[];
  conflicts: ScheduleConflict[];
  totalCredits: number;
  creditLimit: number;
}

export interface OperationRow {
  id: number;
  opType: string;
  status: string;
  errorCode: string | null;
  message: string | null;
  createdAt: string;
}

export interface AuthorizationRow {
  id: number;
  /** 管理端只读列表会带上学生信息 */
  studentId?: number;
  studentNo?: string;
  studentName?: string;
  status: string;
  grantedAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  note: string | null;
  sourceCourseName: string;
  targetCourseName: string;
  sourceClassCode: string | null;
  targetClassCode: string | null;
}

/* --------------------------- 修读记录 / 进度 --------------------------- */

export interface RecordRow {
  id: number;
  courseId: number;
  courseCode: string;
  courseName: string;
  credits: number;
  status: 'passed' | 'failed' | 'in_progress' | 'selected' | string;
  term: string | null;
  source: string;
  verified: number;
  updatedAt: string;
}

export interface EnrolledRow {
  id: number;
  classId: number;
  courseId: number;
  courseCode: string;
  courseName: string;
  credits: number;
  source: string;
  usesReserved: number;
  createdAt: string;
}

export interface ConfirmationStatus {
  confirmed: boolean;
  confirmedAt: string | null;
  activeVersionId: number | null;
  needsReconfirm: boolean;
}

export interface RecordsPayload {
  records: RecordRow[];
  enrolled: EnrolledRow[];
  confirmation: ConfirmationStatus;
}

export interface RequirementProgress {
  requirementId: number;
  code: string;
  name: string;
  category: string | null;
  requiredCredits: number;
  minCourses: number;
  priority: number;
  passedCredits: number;
  passedCourses: number;
  inProgressCredits: number;
  selectedCredits: number;
  countedCredits: number;
  remainingCredits: number;
  remainingCourses: number;
  candidateCourseIds: number[];
  satisfied: boolean;
}

export interface ProgressSnapshot {
  programId: number | null;
  requirements: RequirementProgress[];
  passedCredits: number;
  selectedCredits: number;
}

export interface ProgressPayload {
  progress: ProgressSnapshot;
  demandHints: DemandAssessment[];
  creditLimit: number;
}

/* ------------------------------ 志愿 ------------------------------ */

export interface DraftPreference {
  courseId: number;
  globalRank: number;
  classIds: number[];
  note?: string | null;
  groupCode?: string | null;
}

export interface DraftGroup {
  code: string;
  name: string;
  note?: string | null;
}

export interface DraftPayload {
  preferences: DraftPreference[];
  groups: DraftGroup[];
  updatedAt?: string | null;
}

export interface PreferenceClassChoice {
  classId: number;
  classCode: string;
  classRank: number;
  capacity: number;
  reservedSeats: number;
  enrolled: number;
  generalAvailable: number;
}

export interface PreferenceItem {
  preferenceId: number;
  courseId: number;
  courseCode: string;
  courseName: string;
  credits: number;
  globalRank: number;
  groupCode: string | null;
  groupName: string | null;
  classChoices: PreferenceClassChoice[];
  state: 'pending' | 'allocated' | 'superseded';
  note: string | null;
}

export interface PreferenceView {
  submissionId: number | null;
  batchId: number;
  studentId: number;
  versionNo: number | null;
  status: 'none' | 'submitted' | 'withdrawn';
  submittedAt: string | null;
  items: PreferenceItem[];
  groups: Array<{ code: string; name: string; courseIds: number[]; rankHint: number }>;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  courseId?: number;
  groupCode?: string | null;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  normalized: DraftPreference[];
  groups: Array<{ groupId: number; code: string; name: string; rankHint: number; courseIds: number[] }>;
  availability: Array<{ courseId: number; courseName: string; openClasses: number; totalAvailable: number }>;
  demandHints: Array<{ courseId: number; courseName: string; demandLevel: string; reasons: string[] }>;
  creditPlan: { selectedCourses: number; plannedCredits: number; creditLimit: number };
}

export interface RandomKeyRow {
  courseId: number;
  courseName: string;
  randomKey: string | null;
}

export interface PreferencesPayload {
  batch: BatchDto;
  view: PreferenceView;
  draft: DraftPayload;
}

/* ------------------------------ 候补 ------------------------------ */

export type WaitlistStatus = 'queued' | 'suspended' | 'promoted' | 'closed' | 'withdrawn';

export interface WaitlistEntry {
  id: number;
  studentId: number;
  batchId: number;
  courseId: number;
  courseCode: string;
  courseName: string;
  credits: number;
  status: WaitlistStatus;
  demandLevel: 'D2' | 'D1' | 'D0';
  globalRank: number | null;
  randomKey: string | null;
  classChoices: number[];
  position: number | null;
  queuedAhead: number | null;
  suspendCode: string | null;
  suspendReason: string | null;
  suspendHint?: string;
  /** 顺位变化原因（例如“更高偏好已落实”“等待授权”） */
  positionReason: string | null;
  source: string | null;
  closeCode: string | null;
  closeReason: string | null;
  createdAt: string;
  updatedAt: string;
  capacity: { openClasses: number; generalAvailable: number; queued: number };
}

export interface WaitlistPayload {
  batch: BatchDto;
  entries: WaitlistEntry[];
  canEdit: boolean;
}

export interface WaitlistQueuePayload {
  courseId: number;
  length: number;
  myPosition: number | null;
  ahead: Array<{ position: number; demandLevel: string }>;
}

export interface WaitlistRecheckResult {
  checked: number;
  promoted: number;
  suspended: number;
  closed: number;
}

/* ---------------------------- 时间轴 ---------------------------- */

export interface TimelineEvent {
  batchId: number;
  batchName: string;
  term: string;
  status: BatchStatus;
  openAt: string | null;
  closeAt: string | null;
  publishedAt: string | null;
  preferenceStatus: 'none' | 'submitted' | 'withdrawn';
  preferenceVersion: number | null;
  submittedAt: string | null;
  waitlist: Array<{ courseName: string; status: string; position: number | null }>;
}

export interface TimelinePayload {
  timeline: TimelineEvent[];
  current: BatchDto | null;
}

/* ---------------------------- Agent 规划 ---------------------------- */

export interface PlanItem {
  courseId: number;
  courseCode: string;
  courseName: string;
  credits: number;
  demandLevel: 'D2' | 'D1' | 'D0';
  classId: number;
  classCode: string;
  sessions: string[];
  reasons: string[];
  weeklyText: string[];
  /** 官方培养方案：建议修读学年学期 */
  suggestedTerm: string | null;
  /** 官方培养方案：必修 / 选修 */
  nature: string | null;
  /** 官方培养方案：所属模块 */
  moduleName: string | null;
  /** 相对当前阶段的修读建议（本学期 / 补修 / 提前修读） */
  termAdvice: string | null;
}

export interface Plan {
  label: string;
  description: string;
  items: PlanItem[];
  totalCredits: number;
  creditLimit: number;
  unmet: Array<{ courseId: number; courseName: string; reasons: string[] }>;
  warnings: string[];
  source: string;
}

export interface ProgramSource {
  code: string;
  name: string;
  grade: string | null;
  major: string | null;
  totalCredits: number;
  version: string;
  sourceFile: string | null;
  sourceUrl: string | null;
  sourcePages: string | null;
  sourceNote: string | null;
}

export interface PlanningResult {
  generatedAt: string;
  mode: 'offline' | 'offline-fallback' | 'online';
  notice: string;
  model: { configured: boolean; provider: string | null; degraded: boolean; degradedReason: string | null };
  plans: Plan[];
  requirements: RequirementProgress[];
  conflicts: ScheduleConflict[];
  pendingConfirmations: string[];
  /** 规划依据的官方培养方案（含来源网址与页码） */
  program: ProgramSource | null;
  /** 当前教学阶段，例如 三/1 */
  stage: string | null;
  term: string;
}

/* ------------------------ 官方培养方案（学生视角） ------------------------ */

export interface ProgramPlanCourse {
  requirementId: number;
  courseId: number;
  code: string;
  name: string;
  credits: number;
  nature: string | null;
  suggestedTerm: string | null;
  relation: string;
  priority: number;
}

export interface ProgramPlanModule {
  id: number;
  code: string;
  name: string;
  category: string | null;
  nature: string | null;
  requiredCredits: number;
  minCourses: number;
  priority: number;
  note: string | null;
  sourcePages: string | null;
  courses: ProgramPlanCourse[];
}

export interface StudentProgramPlan {
  program: (ProgramSource & { id: number; status: string; publishedAt: string | null; sourceSha256: string | null }) | null;
  modules: ProgramPlanModule[];
  demoNotice: string | null;
}

export interface ParsedPreference {
  mustHaveCourseIds: number[];
  avoidCourseIds: number[];
  preferCourseIds: number[];
  avoidDays: number[];
  maxCredits: number | null;
  unmatched: string[];
}

export interface AgentStatus {
  model: {
    provider: string | null;
    endpoint: string | null;
    apiKey: string | null;
    model: string | null;
    configured: boolean;
  };
  fallbackAvailable: boolean;
  notice: string;
}

export interface ExplainPayload {
  course: { id: number; code: string; name: string; credits: number } | null;
  demand: { level: string; reasons: string[] } | null;
  requirement: RequirementProgress | null;
  allocation: {
    decision: string;
    reason: string;
    classCode: string | null;
    demandLevel: string;
    globalRank: number;
    randomKey: string | null;
  } | null;
  sources: Array<{ kind: string; description: string; value: string }>;
  text: string;
}

/* ---------------------------- 管理端 ---------------------------- */

export interface AdminStats {
  students: number;
  courses: number;
  classes: number;
  enrollments: number;
  waiting: number;
  suspended: number;
  openExceptions: number;
}

export interface ExceptionRow {
  id: number;
  batchId: number | null;
  runId: number | null;
  studentId: number | null;
  studentNo: string | null;
  studentName: string | null;
  courseId: number | null;
  courseName: string | null;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  status: string;
  detail: string | null;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ImportIssue {
  row: number;
  level: 'error' | 'warning';
  message: string;
}

export interface ImportPreview {
  batchId: number;
  kind: string;
  fileName: string;
  fileHash: string;
  headers: string[];
  rows: Array<Record<string, string | number | null>>;
  rowCount: number;
  issues: ImportIssue[];
  valid: boolean;
  source: string;
  textPreview?: string;
}

export interface ImportBatchRow {
  id: number;
  kind: string;
  fileName: string;
  fileHash: string;
  status: string;
  rowCount: number;
  errorCount: number;
  report: string | null;
  createdAt: string;
  publishedAt: string | null;
  createdBy: string | null;
}

export interface DataVersionRow {
  id: number;
  scope: string;
  versionNo: number;
  contentHash: string;
  summary: string;
  publishedAt: string;
  active: number;
  publishedBy: string | null;
}

export interface PreallocationRow {
  id: number;
  studentId: number;
  studentNo: string;
  studentName: string;
  classId: number;
  classCode: string;
  courseId: number;
  courseName: string;
  capacity: number;
  reservedSeats: number;
  margin: number;
  status: 'pending' | 'applied' | 'failed' | 'reverted';
  failureCode: string | null;
  reason: string | null;
}

export interface PreallocationValidation {
  total: number;
  applicable: number;
  wouldFail: Array<{ id: number; studentNo: string; classCode: string; courseName: string; reason: string }>;
  byClass: Array<{ classId: number; classCode: string; courseName: string; limit: number; requested: number }>;
}

export interface PreallocationsPayload extends Paged<PreallocationRow> {
  validation: PreallocationValidation;
}

export interface AllocationRun {
  id: number;
  batchId: number;
  attempt: number;
  mode: 'simulate' | 'publish';
  status: string;
  snapshotHash: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  publishedAt?: string | null;
  durationMs: number | null;
  failureCode: string | null;
  failureReason: string | null;
  resultSummary: string | null;
  report: string | null;
}

export interface AllocationItem {
  id: number;
  studentId: number;
  studentNo: string;
  studentName: string;
  courseId: number;
  courseName: string;
  classId: number | null;
  classCode: string | null;
  demandLevel: string;
  globalRank: number;
  randomKey: string | null;
  decision: string;
  reasonCode: string;
  reason: string;
  scoreTrace: string | null;
}

export interface AllocationRunDetail {
  run: AllocationRun;
  items: AllocationItem[];
}

export interface GuaranteeReservation {
  id: number;
  batchId: number;
  courseName: string;
  courseId: number;
  studentNo: string;
  studentName: string;
  status: string;
  reason: string | null;
  confirmedAt: string | null;
}

export interface GuaranteeFeasibility {
  students: Array<{
    studentId: number;
    studentNo: string;
    feasible: boolean;
    courseNames: string[];
    conflicts: Array<{ courseIds: number[]; courseNames: string[]; messages: string[] }>;
  }>;
  releasable: Array<{ courseId: number; courseName: string; releasable: boolean; activeReservations: number; fulfilled: number }>;
}

export interface GuaranteePayload {
  reservations: GuaranteeReservation[];
  feasibility: GuaranteeFeasibility;
}

export interface GuaranteeConfirmResult {
  added: number;
  studentCount: number;
  reservationSuggestion: Array<{ classId: number; classCode: string; suggested: number; capacity: number; currentReserved: number }>;
  feasibility: GuaranteeFeasibility['students'];
}

export interface AuditRow {
  id: number;
  actor_id: number | null;
  actor_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string | null;
  detail: string | null;
  created_at: string;
}

/** 审计日志列表（与其它管理端列表一致，使用 items） */
export type AuditPayload = Paged<AuditRow>;

export interface AdminOperationRow {
  id: number;
  opType: string;
  status: string;
  errorCode: string | null;
  message: string | null;
  createdAt: string;
  studentNo: string | null;
  studentName: string | null;
  targetClassId: number | null;
  sourceClassId: number | null;
}

export interface UserRow {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
  studentNo: string | null;
  grade: string | null;
  major: string | null;
  programId: number | null;
}

export interface UserImportResult {
  created: number;
  updated: number;
  skipped: Array<{ row: number; reason: string }>;
}

/* ------------------------- 周课表组件使用的结构 ------------------------- */

export interface GridSession {
  dayOfWeek: number;
  periodStart: number;
  periodEnd: number;
  weekStart?: number | null;
  weekEnd?: number | null;
  weekParity?: string | null;
  room?: string | null;
  text?: string | null;
}

export interface GridEntry {
  id: number | string;
  title: string;
  subtitle?: string | null;
  source?: string | null;
  credits?: number | null;
  sessions: GridSession[];
}

/* ---------------------- 后台任务与毕业兜底授权 ---------------------- */

export interface BackgroundTask {
  id: number;
  kind: 'allocation' | 'planning';
  batchId: number | null;
  runId: number | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  progress: number;
  total: number;
  result: {
    runId?: number;
    status?: string;
    report?: {
      allocated?: number;
      rejected?: number;
      guaranteeFulfilled?: number;
      releasedReservedSeats?: number;
      exceptions?: unknown[];
    } | null;
    failure?: { code: string; reason: string };
    idempotentReplay?: boolean;
  } | null;
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  percent: number;
  retryable: boolean;
}

export interface GuaranteeAuthorizationRow {
  id: number;
  studentId: number;
  batchId: number;
  courseId: number;
  courseName: string;
  classIds: string;
  status: string;
  note: string | null;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}
