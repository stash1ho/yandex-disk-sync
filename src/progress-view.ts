import type { ProgressStyle, SyncProgress } from "./types";

export function normalizeProgressStyle(value: unknown): ProgressStyle {
  return value === "text" || value === "circle" ? value : "bar";
}

export function progressSummary(progress: SyncProgress): {
  phase: string;
  percent: number | undefined;
  detail: string;
} {
  const phase = {
    "local-scan": "Проверка локальных файлов",
    "remote-scan": "Проверка облака",
    sync: "Синхронизация",
    done: "Готово"
  }[progress.phase];
  const measurable = progress.phase === "sync" || progress.phase === "done";
  const percent = !measurable ? undefined : progress.total > 0
    ? Math.max(0, Math.min(100, Math.round(progress.completed / progress.total * 100)))
    : progress.phase === "done" ? 100 : undefined;
  const detail = measurable
    ? `${progress.completed} из ${progress.total} файлов`
    : "Подсчёт файлов...";
  return { phase, percent, detail };
}

export function createProgressView(
  progress: SyncProgress,
  style: ProgressStyle
): DocumentFragment {
  const { phase, percent, detail } = progressSummary(progress);
  const fragment = document.createDocumentFragment();
  const root = document.createElement("div");
  root.className = `yandex-sync-notice yandex-sync-notice--${style}`;
  fragment.append(root);

  const title = document.createElement("div");
  title.className = "yandex-sync-title";
  title.textContent = `Yandex Sync: ${phase}`;
  root.append(title);

  const body = document.createElement("div");
  body.className = "yandex-sync-body";
  root.append(body);

  if (style === "bar") {
    const bar = document.createElement("progress");
    bar.className = "yandex-sync-progress";
    bar.max = 100;
    if (percent !== undefined) bar.value = percent;
    bar.setAttribute("aria-label", phase);
    body.append(bar);
  } else if (style === "circle") {
    const ring = document.createElement("div");
    ring.className = "yandex-sync-ring";
    ring.setAttribute("role", "progressbar");
    ring.setAttribute("aria-label", phase);
    ring.setAttribute("aria-valuemin", "0");
    ring.setAttribute("aria-valuemax", "100");
    if (percent !== undefined) ring.setAttribute("aria-valuenow", String(percent));
    else ring.classList.add("is-indeterminate");

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 48 48");
    svg.setAttribute("aria-hidden", "true");
    for (const className of ["yandex-sync-ring-track", "yandex-sync-ring-fill"]) {
      const circle = document.createElementNS(svg.namespaceURI, "circle");
      for (const [name, value] of Object.entries({ cx: "24", cy: "24", r: "20", pathLength: "100" })) {
        circle.setAttribute(name, value);
      }
      circle.setAttribute("class", className);
      if (className.endsWith("fill")) {
        circle.setAttribute("stroke-dasharray", "100");
        circle.setAttribute("stroke-dashoffset", String(100 - (percent ?? 25)));
      }
      svg.append(circle);
    }
    ring.append(svg);
    body.append(ring);
  }

  const counter = document.createElement("div");
  counter.className = "yandex-sync-counter";
  if (percent !== undefined) {
    const percentage = document.createElement("div");
    percentage.className = "yandex-sync-percent";
    percentage.textContent = `${percent}%`;
    counter.append(percentage);
  }
  const details = document.createElement("div");
  details.className = "yandex-sync-detail";
  details.textContent = detail;
  counter.append(details);
  body.append(counter);

  if (progress.currentPath) {
    const path = document.createElement("div");
    path.className = "yandex-sync-path";
    path.textContent = progress.currentPath;
    path.title = progress.currentPath;
    root.append(path);
  }
  return fragment;
}
