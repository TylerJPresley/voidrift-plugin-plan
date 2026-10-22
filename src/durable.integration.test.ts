/**
 * Plan durable-registry process-survival test (plan-blueprint §8, core §12.5).
 *
 * Two SEPARATE `createCore` instances over the SAME workspace and hermetic
 * global config dir stand in for two processes. Process 1 authors and activates
 * a plan; process 2 — a fresh core sharing no in-memory state — restores the
 * active plan and its current step from the durable registry on load (§8), so a
 * `plan view` with no id returns the active plan at the right step. The §9.5
 * scope grant is NEVER stored; the plugin re-derives and re-registers the active
 * step's scope on load (asserted indirectly: the restored plan is `active` with
 * the correct `currentStep`, which is what drives the re-register).
 *
 * Deterministic and offline: `fakeModel()`, in-memory session/config stores, a
 * per-test temp workspace; the registry uses the real NodeFS durable backend
 * under the hermetic global dir.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { createCore, InMemorySessionRepository, InMemoryConfigStore, type CoreReady } from "@voidrift/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const selfPath = path.resolve(__dirname, "..");

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
};

describe("@voidrift/plugin-plan — durable registry survives a process", () => {
  let ws: string;
  const cores: CoreReady["api"][] = [];

  const boot = async (): Promise<CoreReady> => {
    const ready = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore({
        ...seed,
        plugins: { "@voidrift/plugin-plan": { enabled: true, path: selfPath } },
      }),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    cores.push(ready.api);
    return ready;
  };

  beforeEach(async () => {
    ws = hermeticTmp("plan-durable");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    cores.length = 0;
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("an active plan authored in process 1 is restored at the right step by process 2", async () => {
    // Given — process 1 authors, activates, and advances a plan, then shuts down.
    const p1 = await boot();
    await p1.api.session.command("plan", { op: "create", id: "ship-it", goal: "ship the feature" });
    await p1.api.session.command("plan", {
      op: "add-step",
      id: "ship-it",
      step: { title: "write code", acceptanceCriteria: ["tsc passes"], scope: { writeGlobs: ["src/**"] } },
    });
    await p1.api.session.command("plan", {
      op: "add-step",
      id: "ship-it",
      step: { title: "run tests", acceptanceCriteria: ["vitest green"], scope: { executePatterns: ["vitest *"] } },
    });
    await p1.api.session.command("plan", { op: "activate", id: "ship-it" });
    await p1.api.session.command("plan", { op: "advance", id: "ship-it", outcome: "passed" });
    await p1.api.session.shutdown();

    // When — process 2 boots fresh over the same dirs and views the active plan.
    const p2 = await boot();
    const view = await p2.api.session.command("plan", { op: "view" });

    // Then — the active plan is restored at step 2 (currentStep 1), still active.
    expect(view.ok).toBe(true);
    if (view.ok) {
      const v = view.value as { plan: { id: string; status: string; currentStep: number; steps: { title: string }[] } | null };
      expect(v.plan).not.toBeNull();
      expect(v.plan!.id).toBe("ship-it");
      expect(v.plan!.status).toBe("active");
      expect(v.plan!.currentStep).toBe(1);
      expect(v.plan!.steps[1]!.title).toBe("run tests");
    }
  });
});
