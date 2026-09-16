export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function joinRemotePath(root: string, child: string): string {
  return `${root.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

export function validateRemotePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  const match = trimmed.match(/^([a-zA-Z]+):\/(.*)$/);
  if (!match) {
    throw new Error(`Некорректный путь Яндекс.Диска: ${path}`);
  }
  const scheme = match[1].toLowerCase();
  if (scheme !== "app" && scheme !== "disk") {
    throw new Error("Допустимы только пути app:/ и disk:/");
  }
  const segments = match[2].split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Путь Яндекс.Диска не должен содержать . или ..");
  }
  return `${scheme}:/${segments.join("/")}`;
}

export async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(limit), values.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= values.length) return;
        results[index] = await worker(values[index], index);
      }
    })
  );

  return results;
}

export function makeDeviceId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
