/**
 * VoidRift Plan — a first-party plugin (plan-blueprint.md).
 *
 * The Plan is a persistent, collaboratively authored mini-blueprint: a goal,
 * ordered steps, and per-step acceptance criteria and scope, built up by a human
 * and the model together and carried out by the orchestration loop. This plugin
 * owns the plan record (in its namespaced registry, core §12.5), renders it into
 * the Void/head context layer (core §4.2.1), drives the active step's plan-scope
 * grant (core §9.5), and exposes a `plan` command and `plan` panel to view,
 * author, and advance it (core §12.4, plan-blueprint §6).
 *
 * It reaches the SDK only through the scoped CoreAPI (`ScopedCoreApi`); it owns
 * no engine internals and adds no new system (plan-blueprint §1).
 *
 * ── CoreAPI binding (plan-blueprint §4, core §9.5) ──────────────────────────
 * The §9.5 plan-scope seam is exposed on the scoped CoreAPI as
 * `core.register.planScope(id, scope)` / `core.register.clearPlanScope(id)`,
 * which map one-for-one onto `Guardian.registerScope(id, scope)` /
 * `clearScope(id)` under a plugin-qualified identifier (so one plugin cannot
 * touch another's scope). The scope lifecycle here is pure logic
 * (`PlanScopeController`) over a `ScopeSeam { register, clear }` contract; the
 * plugin binds that contract to the real CoreAPI methods by default. A host may
 * inject a seam for testing; the no-op binder remains only as a last resort when
 * neither a real nor an injected seam is present. Force-ask/hard-deny immunity
 * stays in Guardian (§9.3) — the plugin only ever hands over the active step's
 * declared globs/patterns.
 */

import type { ScopedCoreApi, ContextProvider } from "@voidrift/core";

/**
 * A minimal local sanitizer (plan-blueprint §2.1, core §8.2). The plugin may not
 * import core internals (`entities/untrusted-text.ts`), so it keeps its own copy
 * of the same character class: strip C0/C1 controls (BEL, ESC → ANSI/terminal
 * injection), DEL, bidi overrides/isolates (U+202E and friends spoof text
 * direction), and the BOM/zero-width-no-break-space — before any model-authored
 * `touches`/system-map field or the (already core-masked) surprise targets are
 * rendered into the digest, the context, or a note. Mirrors core's
 * `stripUnsafeChars`; keep the two sets in step.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
function stripUnsafe(s: string): string {
  return s.replace(UNSAFE_CHARS, "");
}

// ── §2 the plan data model ───────────────────────────────────────────────────

export interface StepScope {
  /** Write paths this step auto-approves (core §9.2 glob matcher). */
  writeGlobs: string[];
  /** Command patterns this step auto-approves. */
  executePatterns: string[];
}

export interface Provenance {
  author: "human" | "model";
  at: string; // ISO 8601
}

export type StepStatus = "pending" | "active" | "passed" | "failed";

/**
 * §2.1 — the optional per-step system map: the model's model of the situation.
 * Every field is a bounded free-text line except `touches`, the one
 * machine-checked field — a list of paths/targets the step predicts it will
 * change. `touches` is a PREDICTION (core §9.5.1), distinct from
 * `scope.writeGlobs` (§4); the two never share a value and a map never widens a
 * grant. An absent map, or an empty `touches`, registers no expectation.
 */
export interface SystemMap {
  purpose?: string;
  boundary?: string;
  connections?: string;
  loops?: string;
  secondOrder?: string;
  leverage?: string;
  touches: string[];
}

/**
 * §2.1 — caps for a system map. The defaults here are the SAFE FALLBACK used
 * when the core exposes no `core.limits` accessor (an older core); when it does,
 * the effective values come from the registry keys `plan.maxFieldLength`,
 * `plan.maxTouches`, `plan.maxEntryLength` (core §13.11), read at `register`.
 * They keep a verbose map from bloating the head: each text field is clipped to
 * `maxFieldLength`, each `touches` entry to `maxEntryLength`, and more than
 * `maxTouches` entries is rejected at the boundary.
 */
export const SYSTEM_MAP_LIMITS = {
  /** Each free-text field (purpose, boundary, …) is clipped to this length. */
  maxFieldLength: 500,
  /** More than this many `touches` entries is rejected. */
  maxTouches: 50,
  /** Each `touches` entry is clipped to this length. */
  maxEntryLength: 256,
} as const;

/** The resolved system-map caps a `register` pass derives from `core.limits`
 * (with `SYSTEM_MAP_LIMITS` as the safe fallback). */
export interface SystemMapLimits {
  maxFieldLength: number;
  maxTouches: number;
  maxEntryLength: number;
}

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  acceptanceCriteria: string[];
  scope: StepScope;
  /** §2.1 — optional; its `touches` is checked against reality (core §9.5.1). */
  systemMap?: SystemMap;
  status: StepStatus;
  provenance: Provenance;
}

export type PlanStatus = "draft" | "active" | "complete" | "abandoned";

export interface Plan {
  id: string; // slug
  goal: string;
  steps: PlanStep[];
  currentStep: number; // equals steps.length only when complete
  status: PlanStatus;
  provenance: Provenance;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// ── §4 the plan-scope seam contract (core §9.5) ──────────────────────────────

/**
 * The one-for-one mirror of the Guardian's §9.5 seam
 * (`registerScope(id, scope)` / `clearScope(id)`). The plugin derives the active
 * step's scope and drives it through this; the core supplies the real binding
 * once CoreAPI exposes it (see the module header gap note).
 */
export interface ScopeSeam {
  register(id: string, scope: StepScope): void;
  clear(id: string): void;
}

/** A no-op seam: the plugin is inert on permissions until a real seam binds. */
const NO_OP_SCOPE_SEAM: ScopeSeam = { register: () => {}, clear: () => {} };

/**
 * §2.1 (core §9.5.1) — the one-for-one mirror of the core's expectation seam
 * (`core.expectations.register({ scope, predicted })` / `clear(scope)`). The
 * plugin registers the ACTIVE step's `systemMap.touches` as a prediction under
 * the SAME scope id the plan-scope grant uses, and clears it when the step
 * leaves active. A prediction grants nothing (core invariant 27); the core alone
 * compares it against the journal and emits any surprise — the plugin never
 * reads the journal.
 */
export interface ExpectationSeam {
  register(scope: string, predicted: string[]): void;
  clear(scope: string): void;
}

/** A no-op expectation seam: no prediction is registered until a real seam binds. */
const NO_OP_EXPECTATION_SEAM: ExpectationSeam = { register: () => {}, clear: () => {} };

/**
 * Drives the active-step plan-scope grant over the §9.5 seam (plan-blueprint §4).
 * Registers only the ACTIVE step's scope under a single stable identifier,
 * advances by clearing the old and registering the next, and clears entirely on
 * complete/abandon. It never persists a grant across sessions — a resume
 * re-derives it from the plan record via `syncTo`.
 */
export class PlanScopeController {
  constructor(
    private readonly seam: ScopeSeam,
    private readonly expectations: ExpectationSeam = NO_OP_EXPECTATION_SEAM,
  ) {}

  private scopeId(planId: string): string {
    return `plan:${planId}`;
  }

  /**
   * Make the live grant match the plan's current state (plan-blueprint §4, §8).
   * Registers the active step's scope when the plan is `active` and the current
   * step is a real step; clears otherwise (draft/complete/abandoned/out-of-range).
   * In lockstep it drives the §2.1 expectation: the active step's non-empty
   * `systemMap.touches` is registered as a prediction under the SAME scope id
   * (NEVER into the grant), and cleared otherwise. Idempotent: safe to call on
   * every authoring act, step advance, and resume.
   */
  syncTo(plan: Plan): void {
    const id = this.scopeId(plan.id);
    const step = plan.steps[plan.currentStep];
    if (plan.status === "active" && step !== undefined) {
      // The grant is the step's declared scope ONLY — `touches` never feeds it.
      this.seam.register(id, step.scope);
      const predicted = step.systemMap?.touches ?? [];
      // Absent map or empty touches → register nothing; re-register replaces a
      // prior prediction for the same scope (so a step advance rolls it forward).
      if (predicted.length > 0) this.expectations.register(id, predicted);
      else this.expectations.clear(id);
    } else {
      this.seam.clear(id);
      this.expectations.clear(id);
    }
  }

  /** Clear the plan's grant and prediction unconditionally (teardown/disable). */
  clear(planId: string): void {
    const id = this.scopeId(planId);
    this.seam.clear(id);
    this.expectations.clear(id);
  }
}

// ── storage keys (§8) ─────────────────────────────────────────────────────────

const ACTIVE_PLAN_KEY = "active-plan"; // the active plan's id, so a resume restores it
const planKey = (id: string): string => `plan:${id}`;

const SLUG_RE = /^[a-z0-9-]+$/;

function isSlug(s: unknown): s is string {
  return typeof s === "string" && SLUG_RE.test(s);
}

// ── §3 collaborative authoring — command argument shapes ──────────────────────

type PlanCommand =
  | { op: "view"; id?: string }
  | { op: "create"; id: string; goal: string; author?: "human" | "model" }
  | { op: "add-step"; id: string; step: ProposedStep; author?: "human" | "model" }
  | { op: "activate"; id: string }
  | { op: "advance"; id: string; outcome?: "passed" | "failed" }
  | { op: "abandon"; id: string };

export interface ProposedStep {
  title: string;
  detail?: string;
  acceptanceCriteria?: string[];
  scope?: Partial<StepScope>;
  /** §2.1 — an optional system map proposed alongside the step (no new tool). */
  systemMap?: Partial<SystemMap> & { touches?: string[] };
}

// ── the plugin store (§8) over the scoped namespaced registry ─────────────────

/** Thin, typed accessor over the plugin's namespaced registry (core §12.5). */
class PlanStore {
  constructor(private readonly registry: ScopedCoreApi["registry"]) {}

  get(id: string): Plan | undefined {
    const v = this.registry.get(planKey(id));
    return v ? (v as Plan) : undefined;
  }

  put(plan: Plan): void {
    this.registry.set(planKey(plan.id), plan);
  }

  activeId(): string | undefined {
    const v = this.registry.get(ACTIVE_PLAN_KEY);
    return typeof v === "string" ? v : undefined;
  }

  setActiveId(id: string | undefined): void {
    if (id === undefined) this.registry.remove(ACTIVE_PLAN_KEY);
    else this.registry.set(ACTIVE_PLAN_KEY, id);
  }

  active(): Plan | undefined {
    const id = this.activeId();
    return id ? this.get(id) : undefined;
  }
}

// ── §7 context rendering ──────────────────────────────────────────────────────

/** The tier-1 inline status line: `plan "<goal>" — step N/M: <title>` (§7). */
export function inlineStatus(plan: Plan): string {
  const total = plan.steps.length;
  if (plan.status === "complete") return `plan "${plan.goal}" — complete (${total}/${total})`;
  if (plan.status === "draft") return `plan "${plan.goal}" — draft (${total} step${total === 1 ? "" : "s"})`;
  if (plan.status === "abandoned") return `plan "${plan.goal}" — abandoned`;
  const n = plan.currentStep + 1;
  const step = plan.steps[plan.currentStep];
  return `plan "${plan.goal}" — step ${n}/${total}: ${step ? step.title : "(none)"}`;
}

/** The ordered free-text fields of a system map, for one-line-per-field render. */
const SYSTEM_MAP_FIELDS: readonly (keyof Omit<SystemMap, "touches">)[] = [
  "purpose",
  "boundary",
  "connections",
  "loops",
  "secondOrder",
  "leverage",
];

/**
 * §2.1/§7 — the tier-2 digest lines for a present system map: one short line per
 * present field and one for the predicted `touches`. Empty when the step has no
 * map, so an absent map costs the head nothing. Indented under the step.
 */
function systemMapLines(map: SystemMap | undefined): string[] {
  if (!map) return [];
  const lines: string[] = [];
  for (const f of SYSTEM_MAP_FIELDS) {
    const v = map[f];
    // §8.2 — strip terminal-/spoof-dangerous chars from model-authored text
    // before it is rendered into the head/context.
    if (typeof v === "string" && v !== "") lines.push(`      ${f}: ${stripUnsafe(v)}`);
  }
  if (map.touches.length > 0) lines.push(`      touches: ${map.touches.map(stripUnsafe).join(", ")}`);
  return lines;
}

/** The tier-2 digest-plus-pointer body (§7): goal, step list, and a cache pointer.
 * A present step's system map rides this same tier as one short line per field
 * (§2.1, §7) and adds nothing to the head when absent. */
export function digest(plan: Plan): string {
  const lines = [
    `Plan: ${plan.goal} [${plan.status}]`,
    ...plan.steps.flatMap((s, i) => {
      const marker = i === plan.currentStep ? "→" : s.status === "passed" ? "✓" : s.status === "failed" ? "✗" : " ";
      return [`  ${marker} ${i + 1}. ${s.title} (${s.status})`, ...systemMapLines(s.systemMap)];
    }),
    `(full plan at .voidrift/cache/session/<id>/plan-${plan.id}.md — read on demand)`,
  ];
  return lines.join("\n");
}

// ── authoring helpers (§3) ────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function normScope(scope?: Partial<StepScope>): StepScope {
  return {
    writeGlobs: scope?.writeGlobs ?? [],
    executePatterns: scope?.executePatterns ?? [],
  };
}

/**
 * §2.1 — validate and bound a proposed system map at the authoring boundary.
 * Each present free-text field is TRUNCATED to `maxFieldLength`; each `touches`
 * entry is truncated to `maxEntryLength`; more than `maxTouches` entries is
 * REJECTED (plan-blueprint §2.1). Returns undefined when no map is proposed, so
 * an absent map persists nothing and registers no expectation.
 */
function normSystemMap(map: ProposedStep["systemMap"], limits: SystemMapLimits): SystemMap | undefined {
  if (map === undefined || map === null) return undefined;
  const clip = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v.slice(0, limits.maxFieldLength) : undefined;

  const rawTouches = Array.isArray(map.touches) ? map.touches.filter((t): t is string => typeof t === "string") : [];
  if (rawTouches.length > limits.maxTouches)
    throw new Error(`systemMap.touches has ${rawTouches.length} entries; the cap is ${limits.maxTouches}`);
  const touches = rawTouches.map((t) => t.slice(0, limits.maxEntryLength));

  const out: SystemMap = { touches };
  for (const f of SYSTEM_MAP_FIELDS) {
    const v = clip(map[f]);
    if (v !== undefined) out[f] = v;
  }
  return out;
}

// ── the plugin entry point (§1) ───────────────────────────────────────────────

/**
 * Options for binding the plan-scope and expectation seams. Supplied by a host
 * that has wired the core §9.5 / §9.5.1 seams; absent, the plugin binds to the
 * real `core.register.planScope` / `core.expectations.*`, and only falls back to
 * a no-op when neither a real nor an injected seam is present.
 */
export interface PlanPluginOptions {
  scopeSeam?: ScopeSeam;
  /** §2.1 — the core-expectation seam (prediction vs journal). */
  expectationSeam?: ExpectationSeam;
}

/** A runtime, re-derivable surprise note for a step (§2.1, §6). NOT persisted —
 * a surprise is a learning signal, re-emitted by the core at the next close. */
export interface SurpriseNote {
  /** The masked unpredicted targets the core reported (its event `pattern`). */
  targets: string;
  /** The number of unpredicted targets (the event `count`). */
  count: number;
}

/**
 * The plugin's `register`. The scoped CoreAPI tags every registration with this
 * plugin's id and namespaces its registry (core §12.4). A host that has exposed
 * the §9.5 seam passes it via `options.scopeSeam`; otherwise scope grants no-op.
 */
export function register(core: ScopedCoreApi, options: PlanPluginOptions = {}): void {
  const store = new PlanStore(core.registry);
  // §13.11 — resolve the system-map caps from the core's read-only limits
  // accessor (`plan.*` registry keys). A plugin READS an effective value and can
  // never set one; when the accessor is absent (an older core) or throws for an
  // unknown key, fall back to the shipped `SYSTEM_MAP_LIMITS` defaults so the
  // plugin always has a safe value.
  const readLimit = (key: string, fallback: number): number => {
    try {
      const v = core.limits?.get(key);
      return typeof v === "number" && Number.isFinite(v) ? v : fallback;
    } catch {
      return fallback;
    }
  };
  const systemMapLimits: SystemMapLimits = {
    maxFieldLength: readLimit("plan.maxFieldLength", SYSTEM_MAP_LIMITS.maxFieldLength),
    maxTouches: readLimit("plan.maxTouches", SYSTEM_MAP_LIMITS.maxTouches),
    maxEntryLength: readLimit("plan.maxEntryLength", SYSTEM_MAP_LIMITS.maxEntryLength),
  };
  // Bind to the real §9.5 seam the scoped CoreAPI now exposes
  // (`core.register.planScope` / `clearPlanScope`), which maps one-for-one onto
  // Guardian.registerScope/clearScope under a plugin-qualified identifier. A host
  // may still inject a seam (tests); the no-op is the last resort when neither is
  // present. Force-ask/hard-deny immunity lives in Guardian (§9.3) — the plugin
  // only ever hands over the active step's declared globs/patterns.
  const defaultSeam: ScopeSeam | undefined =
    typeof core.register.planScope === "function"
      ? {
          register: (id, scope) => core.register.planScope(id, scope),
          clear: (id) => core.register.clearPlanScope(id),
        }
      : undefined;

  // §2.1 (core §9.5.1) — bind the expectation seam the same way: prefer an
  // injected seam (tests), else the real `core.expectations.*`, else no-op. The
  // plugin registers the active step's `touches` as a PREDICTION and never reads
  // the journal; the core alone compares and emits any surprise.
  const defaultExpectationSeam: ExpectationSeam | undefined =
    core.expectations && typeof core.expectations.register === "function"
      ? {
          register: (scope, predicted) => core.expectations.register({ scope, predicted }),
          clear: (scope) => core.expectations.clear(scope),
        }
      : undefined;
  const expectationSeam = options.expectationSeam ?? defaultExpectationSeam ?? NO_OP_EXPECTATION_SEAM;
  const scope = new PlanScopeController(options.scopeSeam ?? defaultSeam ?? NO_OP_SCOPE_SEAM, expectationSeam);

  // §6/§2.1 — runtime surprise notes, keyed by the scope id the core closed.
  // A surprise is reported by the core as a session-scoped `WARNING_EMITTED`
  // {category:"surprise",source:"expectation",pattern,count} AFTER the plugin
  // clears the active step's scope (close drives the comparison). The payload
  // carries no scope id, so the plugin attributes it to the scope it most
  // recently closed — only the active step's scope is ever live, so that is the
  // step whose prediction just closed. Notes are runtime-only (re-derived on the
  // next close), never persisted into the plan record.
  const surprises = new Map<string, SurpriseNote>();
  let lastClosedScope: string | undefined;
  if (core.events && typeof core.events.subscribe === "function") {
    core.events.subscribe("WARNING_EMITTED", (e) => {
      const p = (e?.payload ?? {}) as { category?: string; source?: string; pattern?: unknown; count?: unknown };
      if (p.category !== "surprise" || p.source !== "expectation") return;
      if (lastClosedScope === undefined) return;
      surprises.set(lastClosedScope, {
        targets: typeof p.pattern === "string" ? stripUnsafe(p.pattern) : "",
        count: typeof p.count === "number" ? p.count : 0,
      });
    });
  }
  // The controller clears the active step's scope on advance/complete/abandon;
  // record which scope id that was so a following surprise event attributes to
  // it. We wrap the controller's clears by observing plan transitions below.

  // On load/resume (§8): re-derive the active step's scope from the stored plan.
  const activeOnLoad = store.active();
  if (activeOnLoad) scope.syncTo(activeOnLoad);

  // §6 the `plan` command — views, authors, activates, and advances the plan.
  core.register.command("plan", async (args: unknown) => {
    const cmd = (args ?? { op: "view" }) as PlanCommand;
    switch (cmd.op) {
      case "view": {
        const plan = cmd.id ? store.get(cmd.id) : store.active();
        if (!plan) return { plan: null };
        // §6/§2.1 — a surprise note for a step of this plan (runtime, by scope id).
        const note = surprises.get(`plan:${plan.id}`);
        return {
          plan,
          status: inlineStatus(plan),
          digest: digest(plan),
          ...(note ? { surprises: { [`plan:${plan.id}`]: note } } : {}),
        };
      }
      case "create": {
        if (!isSlug(cmd.id)) throw new Error("plan id must be a slug (lowercase alphanumerics and hyphens)");
        if (typeof cmd.goal !== "string" || cmd.goal.trim() === "") throw new Error("plan requires a goal");
        if (store.get(cmd.id)) throw new Error(`plan "${cmd.id}" already exists`);
        const ts = now();
        const plan: Plan = {
          id: cmd.id,
          goal: cmd.goal,
          steps: [],
          currentStep: 0,
          status: "draft",
          provenance: { author: cmd.author ?? "human", at: ts },
          createdAt: ts,
          updatedAt: ts,
        };
        store.put(plan);
        return { created: plan.id };
      }
      case "add-step": {
        // §3 — a proposed step is written only through this authoring act; its
        // provenance records who authored it (human edit vs accepted model proposal).
        const plan = requirePlan(store, cmd.id);
        if (plan.status !== "draft") throw new Error("steps are added while the plan is a draft");
        if (!cmd.step || typeof cmd.step.title !== "string" || cmd.step.title.trim() === "")
          throw new Error("a step requires a title");
        const systemMap = normSystemMap(cmd.step.systemMap, systemMapLimits);
        const step: PlanStep = {
          id: `s${plan.steps.length + 1}`,
          title: cmd.step.title,
          ...(cmd.step.detail !== undefined ? { detail: cmd.step.detail } : {}),
          acceptanceCriteria: cmd.step.acceptanceCriteria ?? [],
          scope: normScope(cmd.step.scope),
          ...(systemMap !== undefined ? { systemMap } : {}),
          status: "pending",
          provenance: { author: cmd.author ?? "human", at: now() },
        };
        plan.steps.push(step);
        plan.updatedAt = now();
        store.put(plan);
        return { added: step.id, author: step.provenance.author };
      }
      case "activate": {
        // §3, §4 — activation registers the first step's scope through the seam.
        const plan = requirePlan(store, cmd.id);
        if (plan.steps.length === 0) throw new Error("cannot activate a plan with no steps");
        plan.status = "active";
        plan.currentStep = 0;
        const first = plan.steps[0]!;
        first.status = "active";
        plan.updatedAt = now();
        store.put(plan);
        store.setActiveId(plan.id);
        scope.syncTo(plan);
        return { activated: plan.id, currentStep: plan.currentStep };
      }
      case "advance": {
        // §5 — the loop's outcome reflects into the plan; a pass advances and
        // rolls the scope forward, a fail keeps the step active.
        const plan = requirePlan(store, cmd.id);
        if (plan.status !== "active") throw new Error("only an active plan advances");
        const step = plan.steps[plan.currentStep];
        if (!step) throw new Error("no active step to advance");
        if (cmd.outcome === "failed") {
          step.status = "failed";
          plan.updatedAt = now();
          store.put(plan);
          scope.syncTo(plan); // unchanged step → same scope stays live
          return { step: step.id, outcome: "failed", currentStep: plan.currentStep };
        }
        step.status = "passed";
        plan.currentStep += 1;
        // The active step's scope (plan:<id>) closes now — record it so a
        // following surprise event (no scope id in its payload) attributes here.
        lastClosedScope = `plan:${plan.id}`;
        const next = plan.steps[plan.currentStep];
        if (next) {
          next.status = "active";
          plan.updatedAt = now();
          store.put(plan);
          scope.syncTo(plan); // clears the old step's scope, registers the next
          return { step: step.id, outcome: "passed", currentStep: plan.currentStep };
        }
        // Last step passed → complete; clear the scope entirely (§4).
        plan.status = "complete";
        plan.updatedAt = now();
        store.put(plan);
        store.setActiveId(undefined);
        scope.syncTo(plan);
        return { step: step.id, outcome: "passed", status: "complete" };
      }
      case "abandon": {
        const plan = requirePlan(store, cmd.id);
        plan.status = "abandoned";
        plan.updatedAt = now();
        store.put(plan);
        if (store.activeId() === plan.id) store.setActiveId(undefined);
        lastClosedScope = `plan:${plan.id}`; // the active scope closes on abandon
        scope.clear(plan.id);
        return { abandoned: plan.id };
      }
      default:
        throw new Error(`unknown plan op "${(cmd as { op: string }).op}"`);
    }
  });

  // §7 the Void-layer context provider: tier-1 inline status + tier-2 digest.
  // The provider contributes content only; the core's pipeline owns placement,
  // the head budget, and degradation (core §4.2.1).
  const provider: ContextProvider = () => {
    const plan = store.active();
    if (!plan) return [];
    return [inlineStatus(plan), digest(plan)];
  };
  core.register.contextProvider("void", provider);

  // §6/§12.7 the `plan` dataset: the read-only rows the `plan` panel binds. The
  // plugin registers its OWN dataset (the core registers only the 16 built-ins),
  // so it is present only while the plugin is enabled and torn down on disable.
  // One row per step of the active plan; `rows()` takes no argument (§12.7).
  core.register.dataset("plan", {
    description: "The active plan's steps — number, title, status, and acceptance criteria.",
    fields: [
      { key: "n", label: "#" },
      { key: "title", label: "Step" },
      { key: "status", label: "Status" },
      { key: "criteria", label: "Criteria" },
    ],
    rows: () => {
      const plan = store.active();
      if (!plan) return [];
      return plan.steps.map((s, i) => ({
        n: i + 1,
        title: stripUnsafe(s.title),
        status: s.status,
        criteria: s.acceptanceCriteria.map(stripUnsafe).join("; "),
      }));
    },
  });

  // §6 the `plan` panel: pure-data declaration the client renders (panels §2,
  // §4). It names the plugin's `plan` DATASET (§12.7) as its `source`; the client
  // reads it via `datasets.rows` on open and re-reads on `RESOURCE_CHANGED` — the
  // declaration holds no rows and no getter.
  core.register.panel("plan", {
    title: "Plan",
    source: "plan",
    columns: [
      { key: "n", label: "#", width: 3 },
      { key: "title", label: "Step", width: 32 },
      { key: "status", label: "Status", width: 8 },
      { key: "criteria", label: "Criteria", width: 24 },
    ],
  });
}

function requirePlan(store: PlanStore, id: string): Plan {
  if (!isSlug(id)) throw new Error("plan id must be a slug");
  const plan = store.get(id);
  if (!plan) throw new Error(`plan "${id}" not found`);
  return plan;
}

export default { register };
