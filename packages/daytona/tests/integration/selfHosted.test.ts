/**
 * A self-hosted Daytona is the same SDK against another API root, so the one
 * thing worth proving without a deployment of your own is that the configured
 * endpoint is the one the SDK actually talks to — an ignored `apiUrl` would
 * silently provision against the managed cloud instead.
 *
 * The test stands up a tiny HTTP server that answers like the Daytona API,
 * points the client at it, and asserts both halves: the call succeeded, and the
 * request arrived at *that* host, authenticated. It needs `@daytonaio/sdk`
 * (nothing else, and no key) and otherwise reports as skipped.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as http from "node:http";

import {
  DAYTONA_SDK_PACKAGE,
  loadDaytonaClient,
} from "../../src/execution/daytona/DaytonaBackend.js";

async function sdkAvailable(): Promise<boolean> {
  try {
    await import(DAYTONA_SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

const enabled = await sdkAvailable();
const skip = enabled ? false : `${DAYTONA_SDK_PACKAGE} is not installed`;

test("the configured API root is the one the SDK calls", { skip }, async () => {
  const seen: Array<{ method: string; url: string; authorized: boolean }> = [];
  const server = http.createServer((request, response) => {
    seen.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorized: Boolean(request.headers.authorization),
    });
    // The SDK lists sandboxes with `GET <apiUrl>/sandbox`.
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ items: [], total: 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;

  try {
    const client = await loadDaytonaClient({
      apiKey: "self-hosted-key",
      apiUrl: `http://127.0.0.1:${port}/api`,
      target: "eu",
    });
    const sandboxes = [];
    for await (const sandbox of client.list()) sandboxes.push(sandbox);
    assert.deepEqual(sandboxes, [], "the fake deployment answered with an empty list");

    const listed = seen.filter((request) => request.url.includes("/sandbox"));
    assert.ok(listed.length > 0, "the list call went to the configured host");
    assert.ok(
      listed.every((request) => request.authorized),
      "the API key travels with the request",
    );
    assert.ok(
      seen.every((request) => !request.url.includes("app.daytona.io")),
      "nothing was sent to the managed cloud",
    );
  } finally {
    server.close();
  }
});
