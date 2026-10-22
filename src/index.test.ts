import { describe, it, expect } from "vitest";
import type { ScopedCoreApi, ContextProvider } from "@voidrift/core";
import {
  register,
  inlineStatus,
  digest,
  PlanScopeController,
  type Plan,
  type ScopeSeam,
  type StepScope,
} from "./index.js";

/** A minimal in-memory stub of the scoped CoreAPI surface the plugin uses. */
function makeStub() {
  const commands = new Map<string, (args: unknown) => unknown | Promise<unknown>>();
  const store = new Map<string, unknown>();
  const panels = new Map<string, unknown>();
  const datasets = new Map<string, { rows: () => unknown }>();
  const contextProviders: { layer: string; provider: ContextProvider }[] = [];
  const core = {
    pluginId: "@voidrift/plugin-plan",
    register: {
      command: (name: string, handler: (args: unknown) => unknown | Promise<unknown>) => {
        commands.set(name, handler);
      },
      contextProvider: (layer: string, provider: ContextProvider) => {
        contextProviders.push({ layer, provider });
      },
      panel: (name: string, definition: unknown) => {
        panels.set(name, definition);
      },
      dataset: (name: string, declaration: unknown) => {
        datasets.set(name, declaration as { rows: () => unknown });
      },
    },
    registry: {
      set: (key: string, value: unknown) => store.set(key, value),
      get: (key: string) => (store.has(key) ? store.get(key) : null),
      query: () => [],
      remove: (key: string) => void store.delete(key),
    },
  } as unknown as ScopedCoreApi;
  return { core, commands, store, panels, datasets, contextProviders };
}

/** A fake §9.5 scope seam that records live grants, like the Guardian map. */
function makeScopeSeam() {
  const live = new Map<string, StepScope>();
  const seam: ScopeSeam = {
    register: (id, scope) => void live.set(id, scope),
    clear: (id) => void live.delete(id),
  };
  return { seam, live };
}

type Cmd = (args: unknown) => Promise<unknown>;

async function authorAndActivate(cmd: Cmd): Promise<void> {
  await cmd({ op: "create", id: "ship-it", goal: "ship the feature" });
  await cmd({
    op: "add-step",
    id: "ship-it",
    step: { title: "write code", acceptanceCriteria: ["tsc passes"], scope: { writeGlobs: ["src/**"] } },
  });
  await cmd({
    op: "add-step",
    id: "ship-it",
    step: { title: "run tests", acceptanceCriteria: ["vitest green"], scope: { executePatterns: ["vitest *"] } },
  });
  await cmd({ op: "activate", id: "ship-it" });
}

describe("plan plugin — registration (§1)", () => {
  it("register() wires the `plan` command, a void context provider, and a panel", () => {
    // Given a stub scoped CoreAPI
    const { core, commands, contextProviders, panels } = makeStub();
    // When the plugin registers
    register(core);
    // Then the command, provider, and panel are wired
    expect(commands.has("plan")).toBe(true);
    expect(contextProviders).toHaveLength(1);
    expect(contextProviders[0]!.layer).toBe("void");
    expect(panels.has("plan")).toBe(true);
    // And the plan panel is pure data: it round-trips through JSON unchanged and
    // names its `plan` source op (§12.6, panels §4).
    const planPanel = panels.get("plan") as { source?: unknown };
    expect(JSON.parse(JSON.stringify(planPanel))).toEqual(planPanel);
    expect(planPanel.source).toBe("plan");
  });

  it("register() wires a `plan` dataset whose rows() reflect the active plan (§12.7)", async () => {
    const { core, commands, datasets } = makeStub();
    register(core);
    // The dataset is registered and takes zero arguments (read-only seam).
    const ds = datasets.get("plan");
    expect(ds).toBeDefined();
    expect(ds!.rows.length).toBe(0);
    // No active plan → no rows.
    expect(ds!.rows()).toEqual([]);
    // After authoring and activating, one row per step with the declared keys.
    const cmd = commands.get("plan") as Cmd;
    await authorAndActivate(cmd);
    const rows = ds!.rows() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ n: 1, title: "write code", status: "active" });
    expect(Object.keys(rows[0]!).sort()).toEqual(["criteria", "n", "status", "title"]);
  });
});

describe("plan plugin — authoring and storage (§2, §3)", () => {
  it("stores a plan as a slug-keyed registry record that round-trips", async () => {
    // Given a registered plugin
    const { core, commands, store } = makeStub();
    register(core);
    const cmd = commands.get("plan") as Cmd;
    // When a plan is created and a step added
    await cmd({ op: "create", id: "my-plan", goal: "do the thing" });
    await cmd({ op: "add-step", id: "my-plan", step: { title: "step one", acceptanceCriteria: ["done"] } });
    // Then it lives in the namespaced registry with every field
    const plan = store.get("plan:my-plan") as Plan;
    expect(plan.goal).toBe("do the thing");
    expect(plan.status).toBe("draft");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.acceptanceCriteria).toEqual(["done"]);
    expect(plan.currentStep).toBe(0);
  });

  it("marks provenance by author: human edits vs accepted model proposals (§3)", async () => {
    const { core, commands, store } = makeStub();
    register(core);
    const cmd = commands.get("plan") as Cmd;
    await cmd({ op: "create", id: "p", goal: "g", author: "human" });
    await cmd({ op: "add-step", id: "p", step: { title: "model drafted" }, author: "model" });
    await cmd({ op: "add-step", id: "p", step: { title: "human wrote" }, author: "human" });
    const plan = store.get("plan:p") as Plan;
    expect(plan.steps[0]!.provenance.author).toBe("model");
    expect(plan.steps[1]!.provenance.author).toBe("human");
  });

  it("rejects a non-slug id and a duplicate plan", async () => {
    const { core, commands } = makeStub();
    register(core);
    const cmd = commands.get("plan") as Cmd;
    await expect(cmd({ op: "create", id: "Bad Id", goal: "g" })).rejects.toThrow(/slug/);
    await cmd({ op: "create", id: "dup", goal: "g" });
    await expect(cmd({ op: "create", id: "dup", goal: "g" })).rejects.toThrow(/already exists/);
  });
});

describe("plan plugin — plan-scope lifecycle via the §9.5 seam (§4)", () => {
  it("activation registers the active step's scope; a matching write would auto-approve, not a force-ask", async () => {
    // Given a registered plugin bound to a fake §9.5 seam
    const { core, commands } = makeStub();
    const { seam, live } = makeScopeSeam();
    register(core, { scopeSeam: seam });
    const cmd = commands.get("plan") as Cmd;
    // When a plan is authored and activated
    await authorAndActivate(cmd);
    // Then only the active step's scope is live under the plan identifier
    expect(live.has("plan:ship-it")).toBe(true);
    expect(live.get("plan:ship-it")).toEqual({ writeGlobs: ["src/**"], executePatterns: [] });
    // The scope grants src/** writes; it carries NO force-ask pattern — force-ask
    // immunity lives above the seam in Guardian (§4), so the grant cannot widen
    // into danger. The grant is strictly the step's declared globs.
    const scope = live.get("plan:ship-it")!;
    expect(scope.writeGlobs).toContain("src/**");
    expect([...scope.writeGlobs, ...scope.executePatterns]).not.toContain("git push --force");
  });

  it("advancing clears the old step's scope and registers the next (§4, §5)", async () => {
    const { core, commands } = makeStub();
    const { seam, live } = makeScopeSeam();
    register(core, { scopeSeam: seam });
    const cmd = commands.get("plan") as Cmd;
    await authorAndActivate(cmd);
    expect(live.get("plan:ship-it")).toEqual({ writeGlobs: ["src/**"], executePatterns: [] });
    // When the first step passes
    await cmd({ op: "advance", id: "ship-it", outcome: "passed" });
    // Then the scope rolls forward to the second step
    expect(live.get("plan:ship-it")).toEqual({ writeGlobs: [], executePatterns: ["vitest *"] });
  });

  it("a failed step keeps the same scope live and does not advance (§5)", async () => {
    const { core, commands, store } = makeStub();
    const { seam, live } = makeScopeSeam();
    register(core, { scopeSeam: seam });
    const cmd = commands.get("plan") as Cmd;
    await authorAndActivate(cmd);
    await cmd({ op: "advance", id: "ship-it", outcome: "failed" });
    const plan = store.get("plan:ship-it") as Plan;
    expect(plan.currentStep).toBe(0);
    expect(plan.steps[0]!.status).toBe("failed");
    expect(live.get("plan:ship-it")).toEqual({ writeGlobs: ["src/**"], executePatterns: [] });
  });

  it("the last pass completes the plan and clears the scope entirely (§4, §5)", async () => {
    const { core, commands, store } = makeStub();
    const { seam, live } = makeScopeSeam();
    register(core, { scopeSeam: seam });
    const cmd = commands.get("plan") as Cmd;
    await authorAndActivate(cmd);
    await cmd({ op: "advance", id: "ship-it", outcome: "passed" });
    await cmd({ op: "advance", id: "ship-it", outcome: "passed" });
    const plan = store.get("plan:ship-it") as Plan;
    expect(plan.status).toBe("complete");
    expect(plan.currentStep).toBe(plan.steps.length);
    expect(live.has("plan:ship-it")).toBe(false);
  });

  it("a resume re-registers the active step's scope from the stored record, not a carried live grant (§4, §8)", async () => {
    // Given a plan authored and activated in one "session"
    const { core, commands, store } = makeStub();
    const first = makeScopeSeam();
    register(core, { scopeSeam: first.seam });
    const cmd = commands.get("plan") as Cmd;
    await authorAndActivate(cmd);

    // When a fresh plugin instance loads over the SAME registry (process resume)
    // with a brand-new seam that starts empty — no live grant is inherited.
    const resumed = makeStub();
    // share the same backing store
    (resumed.core.registry as unknown as { get: (k: string) => unknown }).get = (k: string) =>
      store.has(k) ? store.get(k) : null;
    (resumed.core.registry as unknown as { set: (k: string, v: unknown) => void }).set = (k: string, v: unknown) =>
      void store.set(k, v);
    const second = makeScopeSeam();
    expect(second.live.size).toBe(0);
    register(resumed.core, { scopeSeam: second.seam });
    // Then the active step's scope is re-derived from the record on load
    expect(second.live.get("plan:ship-it")).toEqual({ writeGlobs: ["src/**"], executePatterns: [] });
  });

  it("abandoning clears the scope and the active-plan pointer", async () => {
    const { core, commands, store } = makeStub();
    const { seam, live } = makeScopeSeam();
    register(core, { scopeSeam: seam });
    const cmd = commands.get("plan") as Cmd;
    await authorAndActivate(cmd);
    await cmd({ op: "abandon", id: "ship-it" });
    expect(live.has("plan:ship-it")).toBe(false);
    expect(store.get("active-plan")).toBeFalsy();
    expect((store.get("plan:ship-it") as Plan).status).toBe("abandoned");
  });
});

describe("plan plugin — binds to the real §9.5 CoreAPI seam by default (§4)", () => {
  /**
   * A stub whose scoped `register` exposes `planScope`/`clearPlanScope` exactly
   * as the real scoped CoreAPI now does (mapping onto a Guardian-like scope map).
   * The plugin is registered WITHOUT an injected `scopeSeam`, so it must bind to
   * these real methods — proving the end-to-end wiring, not a fake seam.
   */
  function makeSeamStub() {
    const commands = new Map<string, (args: unknown) => unknown | Promise<unknown>>();
    const store = new Map<string, unknown>();
    const live = new Map<string, StepScope>();
    const core = {
      pluginId: "@voidrift/plugin-plan",
      register: {
        command: (name: string, handler: (args: unknown) => unknown | Promise<unknown>) => {
          commands.set(name, handler);
        },
        contextProvider: () => {},
        panel: () => {},
        dataset: () => {},
        planScope: (id: string, scope: StepScope) => void live.set(id, scope),
        clearPlanScope: (id: string) => void live.delete(id),
      },
      registry: {
        set: (key: string, value: unknown) => store.set(key, value),
        get: (key: string) => (store.has(key) ? store.get(key) : null),
        query: () => [],
        remove: (key: string) => void store.delete(key),
      },
    } as unknown as ScopedCoreApi;
    return { core, commands, live };
  }

  it("activating a step auto-approves a matching write via the plan-scope; advancing clears/rolls it", async () => {
    // Given the plugin registered with NO injected seam (uses core.register.planScope)
    const { core, commands, live } = makeSeamStub();
    register(core);
    const cmd = commands.get("plan") as Cmd;
    // When a plan is authored and activated
    await authorAndActivate(cmd);
    // Then the active step's scope is live through the real seam
    expect(live.get("plan:ship-it")).toEqual({ writeGlobs: ["src/**"], executePatterns: [] });
    // When the step passes, the scope rolls forward to the next step
    await cmd({ op: "advance", id: "ship-it", outcome: "passed" });
    expect(live.get("plan:ship-it")).toEqual({ writeGlobs: [], executePatterns: ["vitest *"] });
    // When the last step passes, the plan completes and the scope is cleared
    await cmd({ op: "advance", id: "ship-it", outcome: "passed" });
    expect(live.has("plan:ship-it")).toBe(false);
  });
});

describe("plan plugin — context rendering (§7)", () => {
  it("the provider emits a tier-1 inline `step N/M` status and a tier-2 digest with a cache pointer", async () => {
    const { core, commands, contextProviders } = makeStub();
    register(core);
    const cmd = commands.get("plan") as Cmd;
    await authorAndActivate(cmd);
    const blocks = contextProviders[0]!.provider() as string[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("step 1/2");
    expect(blocks[1]).toContain("Plan: ship the feature");
    expect(blocks[1]).toContain(".voidrift/cache/session/");
  });

  it("the provider is empty when no plan is active", () => {
    const { core, contextProviders } = makeStub();
    register(core);
    expect(contextProviders[0]!.provider()).toEqual([]);
  });
});

describe("plan plugin — pure render + controller units", () => {
  const base: Plan = {
    id: "x",
    goal: "do it",
    steps: [
      { id: "s1", title: "a", acceptanceCriteria: [], scope: { writeGlobs: [], executePatterns: [] }, status: "active", provenance: { author: "human", at: "t" } },
      { id: "s2", title: "b", acceptanceCriteria: [], scope: { writeGlobs: [], executePatterns: [] }, status: "pending", provenance: { author: "human", at: "t" } },
    ],
    currentStep: 0,
    status: "active",
    provenance: { author: "human", at: "t" },
    createdAt: "t",
    updatedAt: "t",
  };

  it("inlineStatus reflects status and position", () => {
    expect(inlineStatus(base)).toContain("step 1/2: a");
    expect(inlineStatus({ ...base, status: "complete", currentStep: 2 })).toContain("complete (2/2)");
    expect(inlineStatus({ ...base, status: "draft" })).toContain("draft");
  });

  it("digest marks the current step and includes a pointer", () => {
    const d = digest(base);
    expect(d).toContain("→ 1. a");
    expect(d).toContain("plan-x.md");
  });

  it("PlanScopeController.syncTo registers only an active step and clears otherwise", () => {
    const live = new Map<string, StepScope>();
    const controller = new PlanScopeController({
      register: (id, s) => void live.set(id, s),
      clear: (id) => void live.delete(id),
    });
    controller.syncTo({ ...base, steps: [{ ...base.steps[0]!, scope: { writeGlobs: ["a/**"], executePatterns: [] } }, base.steps[1]!] });
    expect(live.get("plan:x")).toEqual({ writeGlobs: ["a/**"], executePatterns: [] });
    controller.syncTo({ ...base, status: "draft" });
    expect(live.has("plan:x")).toBe(false);
  });
});
