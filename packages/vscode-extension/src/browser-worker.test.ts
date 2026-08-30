import { describe, expect, it, vi } from "vitest";
import {
  createBrowserWorker,
  type BrowserWorkerDependencies
} from "./browser-worker.js";

interface FakeWorker {
  readonly url: string;
  readonly name: string | undefined;
}

describe("createBrowserWorker", () => {
  it("fetches a cross-origin script and launches it from a managed blob URL", async () => {
    const fetchScript = vi.fn(async () => new Response("worker code", {
      status: 200,
      statusText: "OK"
    }));
    const revokeObjectUrl = vi.fn();
    const terminateWorker = vi.fn();
    const dependencies: BrowserWorkerDependencies<FakeWorker> = {
      fetchScript,
      createObjectUrl: (blob) => {
        expect(blob.type).toBe("text/javascript");
        return "blob:https://vscode.dev/server";
      },
      revokeObjectUrl,
      createWorker: (url, options) => ({ url, name: options.name }),
      terminateWorker
    };
    const logs: string[] = [];

    const managed = await createBrowserWorker(
      "https://localhost:5000/dist/web/server.js",
      "Codewise Language Server",
      (message) => logs.push(message),
      dependencies
    );

    expect(fetchScript).toHaveBeenCalledWith(
      "https://localhost:5000/dist/web/server.js",
      { mode: "cors" }
    );
    expect(managed.worker).toEqual({
      url: "blob:https://vscode.dev/server",
      name: "Codewise Language Server"
    });
    expect(logs).toContain(
      "Created the browser language server from a local blob URL."
    );
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    managed.dispose();
    managed.dispose();

    expect(terminateWorker).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith(
      "blob:https://vscode.dev/server"
    );
  });

  it("reports an HTTP failure without creating a worker", async () => {
    const createWorker = vi.fn();
    const dependencies: BrowserWorkerDependencies<FakeWorker> = {
      fetchScript: async () => new Response(undefined, {
        status: 404,
        statusText: "Not Found"
      }),
      createObjectUrl: () => "blob:unused",
      revokeObjectUrl: () => undefined,
      createWorker,
      terminateWorker: () => undefined
    };

    await expect(createBrowserWorker(
      "https://localhost:5000/dist/web/server.js",
      "Codewise Language Server",
      () => undefined,
      dependencies
    )).rejects.toThrow(
      "Browser worker script request failed with HTTP 404 Not Found."
    );
    expect(createWorker).not.toHaveBeenCalled();
  });
});
