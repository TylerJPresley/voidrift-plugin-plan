/**
 * Plan plugin — the optional per-step system map and its core-expectation
 * prediction (plan-blueprint §2.1, §3, §6, §7; core-blueprint §9.5.1).
 *
 * The system map rides the existing propose/accept path (no new model tool); its
 * `touches` is registered as a core expectation for the ACTIVE step's scope id —
 * the SAME id the plan-scope grant uses — when the step becomes active, and
 * cleared when it leaves active. `touches` NEVER feeds the scope grant. A surprise
 * reported by the core (WARNING_EMITTED {category:"surprise",source:"expectation"})
 * is rendered against the step it closed.
 */
import { describe, it, expect } from "vitest";
import type { ScopedCoreApi, ContextProvider, EventEnvelope } from "@voidrift/core";
import {
  register,
  digest,
  SYSTEM_MAP_LIMITS,
  type Plan,
  type ScopeSeam,
  type ExpectationSeam,
  type StepScope,
  type SystemMap,
} from "./index.js";

type Cmd = (args: unknown) => Promise<unknown>;

/** An in-memory scoped-CoreAPI stub with injectable scope + expectation seams
 * and an event bus, mirroring the real surface the plugin uses. */
function makeStub() {
  const commands = new Map<string, Cmd>();
  const store = new Map<string, unknown>();
  const panels = new Map<string, unknown>();
  const contextProviders: { layer: string; provider: ContextProvider }[] = [];
  const liveScope = new Map<string, StepScope>();
  const liveExp = new Map<string, string[]>();
  const subs: ((e: EventEnvelope) => void)[] = [];
  const scopeSeam: ScopeSeam = {
    register: (id, s) => void liveScope.set(id, s),
    clear: (id) => void liveScope.delete(id),
  };
  const expectationSeam: ExpectationSeam = {
    register: (scope, predicted) => void liveExp.set(scope, predicted),
    clear: (scope) => void liveExp.delete(scope),
  };
  const core = {
    pluginId: "@voidrift/plugin-plan",
    register: {
      command: (name: string, handler: Cmd) => void commands.set(name, handler),
      contextProvider: (layer: string, provider: ContextProvider) =>
        void contextProviders.push({ layer, provider }),
      panel: (name: string, def: unknown) => void panels.set(name, def),
      dataset: () => {},
    },
    registry: {
      set: (k: string, v: unknown) => void store.set(k, v),
      get: (k: string) => (store.has(k) ? store.get(k) : null),
      query: () => [],
      remove: (k: string) => void store.delete(k),
    },
    events: {
      register: () => {},
      subscribe: (_type: string, handler: (e: EventEnvelope) => void) => {
        subs.push(handler);
        return () => {};
      },
      emit: () => {},
    },
  } as unknown as ScopedCoreApi;
  const emitSurprise = (pattern: string, count: number) => {
    const env = { type: "WARNING_EMITTED", payload: { category: "surprise", source: "expectation", pattern, count } };
    for (const h of subs) h(env as unknown as EventEnvelope);
  };
  return { core, commands, store, panels, contextProviders, liveScope, liveExp, scopeSeam, expectationSeam, emitSurprise };
}

const MAP: SystemMap = {
  purpose: "ship the parser",
  boundary: "only src/parser",
  touches: ["src/parser/**", "src/index.ts"],
};

async function authorWithMap(cmd: Cmd, map: SystemMap = MAP): Promise<void> {
  await cmd({ op: "create", id: "p", goal: "g" });
  await cmd({ op: "add-step", id: "p", step: { title: "t", scope: { writeGlobs: ["src/**"] }, systemMap: map }, author: "model" });
  await cmd({ op: "activate", id: "p" });
}

describe("plan plugin — system map authoring and persistence (§2.1, §3)", () => {
  it("round-trips a systemMap on a proposed step via the propose path; provenance model", async () => {
    const { core, commands, store } = makeStub();
    register(core);
    const cmd = commands.get("plan") as Cmd;
    await cmd({ op: "create", id: "p", goal: "g" });
    await cmd({ op: "add-step", id: "p", step: { title: "t", systemMap: MAP }, author: "model" });
    const step = (store.get("plan:p") as Plan).steps[0]!;
    expect(step.systemMap).toEqual(MAP);
    expect(step.provenance.author).toBe("model");
  });

  it("truncates an over-cap text field and rejects an over-count touches", async () => {
    const { core, commands, store } = makeStub();
    register(core);
    const cmd = commands.get("plan") as Cmd;
    await cmd({ op: "create", id: "p", goal: "g" });
    const longField = "x".repeat(SYSTEM_MAP_LIMITS.maxFieldLength + 50);
    await cmd({ op: "add-step", id: "p", step: { title: "t", systemMap: { purpose: longField, touches: ["a"] } } });
    const step = (store.get("plan:p") as Plan).steps[0]!;
    expect(step.systemMap!.purpose!.length).toBe(SYSTEM_MAP_LIMITS.maxFieldLength);

    const tooMany = Array.from({ length: SYSTEM_MAP_LIMITS.maxTouches + 1 }, (_, i) => `t${i}`);
    await expect(
      cmd({ op: "add-step", id: "p", step: { title: "u", systemMap: { touches: tooMany } } }),
    ).rejects.toThrow(/touches/);
  });

  it("truncates an over-length touches entry", async () => {
    const { core, commands, store } = makeStub();
    register(core);
    const cmd = commands.get("plan") as Cmd;
    await cmd({ op: "create", id: "p", goal: "g" });
    const longEntry = "p".repeat(SYSTEM_MAP_LIMITS.maxEntryLength + 20);
    await cmd({ op: "add-step", id: "p", step: { title: "t", systemMap: { touches: [longEntry] } } });
    const step = (store.get("plan:p") as Plan).steps[0]!;
    expect(step.systemMap!.touches[0]!.length).toBe(SYSTEM_MAP_LIMITS.maxEntryLength);
  });
});

describe("plan plugin — system map registers a prediction (§2.1, core §9.5.1)", () => {
  it("activating a step with non-empty touches registers an expectation under the step's scope id", async () => {
    const { core, commands, scopeSeam, expectationSeam, liveExp, liveScope } = makeStub();
    register(core, { scopeSeam, expectationSeam });
    const cmd = commands.get("plan") as Cmd;
    await authorWithMap(cmd);
    expect(liveExp.get("plan:p")).toEqual(["src/parser/**", "src/index.ts"]);
    // the scope grant is the writeGlobs ONLY — touches never feeds it
    expect(liveScope.get("plan:p")).toEqual({ writeGlobs: ["src/**"], executePatterns: [] });
  });

  it("touches NEVER widens the scope grant", async () => {
    const { core, commands, scopeSeam, expectationSeam, liveScope } = makeStub();
    register(core, { scopeSeam, expectationSeam });
    const cmd = commands.get("plan") as Cmd;
    await authorWithMap(cmd, { touches: ["secrets/**", "/etc/passwd"] });
    const grant = liveScope.get("plan:p")!;
    expect(grant.writeGlobs).toEqual(["src/**"]);
    expect([...grant.writeGlobs, ...grant.executePatterns]).not.toContain("secrets/**");
    expect([...grant.writeGlobs, ...grant.executePatterns]).not.toContain("/etc/passwd");
  });

  it("an absent map or empty touches registers nothing", async () => {
    const { core, commands, scopeSeam, expectationSeam, liveExp } = makeStub();
    register(core, { scopeSeam, expectationSeam });
    const cmd = commands.get("plan") as Cmd;
    await cmd({ op: "create", id: "p", goal: "g" });
    await cmd({ op: "add-step", id: "p", step: { title: "no map", scope: { writeGlobs: ["a/**"] } } });
    await cmd({ op: "add-step", id: "p", step: { title: "empty", systemMap: { touches: [] }, scope: { writeGlobs: ["b/**"] } } });
    await cmd({ op: "activate", id: "p" });
    expect(liveExp.has("plan:p")).toBe(false);
  });

  it("leaving active clears the expectation; advancing rolls it to the next step", async () => {
    const { core, commands, scopeSeam, expectationSeam, liveExp } = makeStub();
    register(core, { scopeSeam, expectationSeam });
    const cmd = commands.get("plan") as Cmd;
    await cmd({ op: "create", id: "p", goal: "g" });
    await cmd({ op: "add-step", id: "p", step: { title: "one", systemMap: { touches: ["a/**"] } } });
    await cmd({ op: "add-step", id: "p", step: { title: "two", systemMap: { touches: ["b/**"] } } });
    await cmd({ op: "activate", id: "p" });
    expect(liveExp.get("plan:p")).toEqual(["a/**"]);
    await cmd({ op: "advance", id: "p", outcome: "passed" });
    expect(liveExp.get("plan:p")).toEqual(["b/**"]);
    await cmd({ op: "advance", id: "p", outcome: "passed" });
    expect(liveExp.has("plan:p")).toBe(false);
  });

  it("a resume re-registers the active step's expectation from the stored record", async () => {
    const { core, commands, store, scopeSeam, expectationSeam } = makeStub();
    register(core, { scopeSeam, expectationSeam });
    const cmd = commands.get("plan") as Cmd;
    await authorWithMap(cmd);
    // fresh instance over the same registry with empty seams
    const resumed = makeStub();
    (resumed.core.registry as unknown as { get: (k: string) => unknown }).get = (k: string) => (store.has(k) ? store.get(k) : null);
    (resumed.core.registry as unknown as { set: (k: string, v: unknown) => void }).set = (k: string, v: unknown) => void store.set(k, v);
    expect(resumed.liveExp.size).toBe(0);
    register(resumed.core, { scopeSeam: resumed.scopeSeam, expectationSeam: resumed.expectationSeam });
    expect(resumed.liveExp.get("plan:p")).toEqual(["src/parser/**", "src/index.ts"]);
  });
});

describe("plan plugin — binds to real core.expectations by default", () => {
  it("uses core.expectations.register/clear when no seam is injected", async () => {
    const liveExp = new Map<string, string[]>();
    const commands = new Map<string, Cmd>();
    const store = new Map<string, unknown>();
    const core = {
      pluginId: "@voidrift/plugin-plan",
      register: {
        command: (n: string, h: Cmd) => void commands.set(n, h),
        contextProvider: () => {},
        panel: () => {},
        dataset: () => {},
        planScope: () => {},
        clearPlanScope: () => {},
      },
      expectations: {
        register: (req: { scope: string; predicted: string[] }) => void liveExp.set(req.scope, req.predicted),
        clear: (scope: string) => void liveExp.delete(scope),
      },
      registry: {
        set: (k: string, v: unknown) => void store.set(k, v),
        get: (k: string) => (store.has(k) ? store.get(k) : null),
        query: () => [],
        remove: (k: string) => void store.delete(k),
      },
      events: { register: () => {}, subscribe: () => () => {}, emit: () => {} },
    } as unknown as ScopedCoreApi;
    register(core);
    const cmd = commands.get("plan") as Cmd;
    await authorWithMap(cmd);
    expect(liveExp.get("plan:p")).toEqual(["src/parser/**", "src/index.ts"]);
  });
});

describe("plan plugin — rendering the map and the surprise (§6, §7)", () => {
  it("the tier-2 digest shows one line per present field and the predicted touches; absent map adds nothing", async () => {
    const { core, commands, store } = makeStub();
    register(core);
    const cmd = commands.get("plan") as Cmd;
    await authorWithMap(cmd);
    const plan = store.get("plan:p") as Plan;
    const d = digest(plan);
    expect(d).toContain("purpose: ship the parser");
    expect(d).toContain("boundary: only src/parser");
    expect(d).toContain("touches: src/parser/**, src/index.ts");

    // A plan with no maps costs the digest nothing extra (no map lines).
    const bare: Plan = { ...plan, steps: plan.steps.map((s) => ({ ...s, systemMap: undefined })) };
    const db = digest(bare);
    expect(db).not.toContain("purpose:");
    expect(db).not.toContain("touches:");
  });

  it("a reported surprise renders a one-line note with the unpredicted targets for the closed step", async () => {
    const { core, commands, scopeSeam, expectationSeam, emitSurprise } = makeStub();
    register(core, { scopeSeam, expectationSeam });
    const cmd = commands.get("plan") as Cmd;
    await authorWithMap(cmd);
    // advancing closes the step's scope → the core would compare + emit a surprise
    await cmd({ op: "advance", id: "p", outcome: "passed" });
    emitSurprise("src/unexpected.ts", 1);
    const view = (await cmd({ op: "view", id: "p" })) as { surprises?: Record<string, { targets: string; count: number }> };
    expect(view.surprises).toBeTruthy();
    const note = Object.values(view.surprises!)[0]!;
    expect(note.targets).toContain("src/unexpected.ts");
    expect(note.count).toBe(1);
  });

  it("strips U+202E / ESC-ANSI / BEL from rendered touches and system-map fields (§8.2)", async () => {
    const { core, commands, store } = makeStub();
    register(core);
    const cmd = commands.get("plan") as Cmd;
    await cmd({ op: "create", id: "p", goal: "g" });
    await cmd({
      op: "add-step",
      id: "p",
      step: {
        title: "t",
        systemMap: {
          purpose: "ship\u202e\u001b the parser\u0007",
          touches: ["src/\u202eev\u001bil\u0007.ts"],
        },
      },
    });
    const plan = store.get("plan:p") as Plan;
    const d = digest(plan);
    expect(d).not.toMatch(/[\u202e\u001b\u0007]/);
    expect(d).toContain("src/evil.ts");
    expect(d).toContain("ship the parser");
  });

  it("strips unsafe chars from a reported surprise note before it is rendered (§8.2)", async () => {
    const { core, commands, scopeSeam, expectationSeam, emitSurprise } = makeStub();
    register(core, { scopeSeam, expectationSeam });
    const cmd = commands.get("plan") as Cmd;
    await authorWithMap(cmd);
    await cmd({ op: "advance", id: "p", outcome: "passed" });
    emitSurprise("src/\u202eev\u001bil\u0007.ts", 1);
    const view = (await cmd({ op: "view", id: "p" })) as { surprises?: Record<string, { targets: string; count: number }> };
    const note = Object.values(view.surprises!)[0]!;
    expect(note.targets).not.toMatch(/[\u202e\u001b\u0007]/);
    expect(note.targets).toContain("src/evil.ts");
  });
});
