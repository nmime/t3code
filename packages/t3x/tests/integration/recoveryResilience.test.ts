/**
 * A sandbox provider that is down must not take the control plane with it.
 *
 * Measured on the deployment (2026-10-15): rebuilding the sandbox image left
 * four paused sandboxes pointing at an image id that no longer existed, the
 * provider's `GET /v1/sandboxes` began answering 500, the sweep's rejection
 * was unhandled, Node exited, systemd restarted the process, the boot
 * reconcile hit the same 500, and the loop created a sandbox per attempt.
 *
 * The control plane is the only thing that knows the task's state; it must
 * survive an outage of the thing it drives.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask, startTestServer, tempStateDir } from "../helpers.js";

test("a failing reconcile is reported, not thrown, and the sweep recovers", async () => {
  const stateDir = tempStateDir();
  const server = await startTestServer({ stateDir });
  try {
    await createTask(server);
    const real = server.controlPlane.reconcile.bind(server.controlPlane);

    server.controlPlane.reconcile = async () => {
      throw new Error("OpenSandbox GET /v1/sandboxes?page=1&pageSize=200 failed (500)");
    };

    // Boot recovery must come up anyway: the API and the event log are still
    // useful while the provider is broken.
    const recovered = await server.recovery.recover();
    assert.match(recovered.notes.join(" "), /reconcile failed: .*500/);
    assert.equal(recovered.checked, 0);

    // And the periodic sweep must not reject — that rejection is what killed
    // the process in the deployment.
    const swept = await server.recovery.sweep();
    assert.match(swept.report.notes.join(" "), /reconcile failed: .*500/);
    assert.equal(swept.report.checked, 0);

    // Nothing is wedged: once the provider answers again the sweep reconciles.
    server.controlPlane.reconcile = real;
    const after = await server.recovery.sweep();
    assert.deepEqual(after.report.notes, []);
    assert.ok(after.report.checked >= 0);
  } finally {
    await server.stop();
  }
});
