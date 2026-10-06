const KEY = "pi-desktop:hidden-projects";

/** List removal is a view preference; never deletes sessions or workspace files. */
export function readHiddenProjects(): Set<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveHiddenProjects(projects: Set<string>): void {
  window.localStorage.setItem(KEY, JSON.stringify([...projects]));
}
