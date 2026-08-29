export interface BrowserWorkerDependencies<TWorker> {
  fetchScript(url: string, init: RequestInit): Promise<Response>;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  createWorker(url: string, options: WorkerOptions): TWorker;
  terminateWorker(worker: TWorker): void;
}

export interface ManagedBrowserWorker<TWorker> {
  readonly worker: TWorker;
  dispose(): void;
}

export const defaultBrowserWorkerDependencies:
BrowserWorkerDependencies<Worker> = {
  fetchScript: (url, init) => fetch(url, init),
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  createWorker: (url, options) => new Worker(url, options),
  terminateWorker: (worker) => worker.terminate()
};

export async function createBrowserWorker<TWorker>(
  scriptUrl: string,
  name: string,
  logger: (message: string) => void,
  dependencies: BrowserWorkerDependencies<TWorker>
): Promise<ManagedBrowserWorker<TWorker>> {
  logger(`Fetching browser worker script from ${scriptUrl}.`);
  const response = await dependencies.fetchScript(scriptUrl, {
    mode: "cors"
  });
  logger(
    `Browser worker script request returned HTTP `
    + `${describeHttpResponse(response)}.`
  );
  if (!response.ok) {
    throw new Error(
      `Browser worker script request failed with HTTP `
      + `${describeHttpResponse(response)}.`
    );
  }

  const source = await response.text();
  if (source.length === 0) {
    throw new Error("The browser worker script is empty.");
  }

  const objectUrl = dependencies.createObjectUrl(
    new Blob([source], { type: "text/javascript" })
  );
  let worker: TWorker;
  try {
    worker = dependencies.createWorker(objectUrl, { name });
  } catch (error) {
    dependencies.revokeObjectUrl(objectUrl);
    throw error;
  }
  logger("Created the browser language server from a local blob URL.");

  let disposed = false;
  return {
    worker,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      dependencies.terminateWorker(worker);
      dependencies.revokeObjectUrl(objectUrl);
    }
  };
}

function describeHttpResponse(response: Response): string {
  return response.statusText === ""
    ? String(response.status)
    : `${response.status} ${response.statusText}`;
}
