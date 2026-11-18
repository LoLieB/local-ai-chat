const backgroundModules = import.meta.glob("./assets/backgrounds/*.{png,jpg,jpeg,webp,avif}", {
  eager: true,
  import: "default"
}) as Record<string, string>;

const SESSION_BACKGROUND_KEY = "local-ai-chat:session-background";
const ACTIVE_BACKGROUND_KEY = "local-ai-chat:background-image";
const BACKGROUND_DISPLAY_COLLAPSED_KEY = "local-ai-chat:background-display-collapsed";
export const BACKGROUND_DISPLAY_INTERVAL_MS = 25_000;

export type BackgroundOrientation = "portrait" | "landscape" | "square";

export function getBackgroundOrientation(width: number, height: number): BackgroundOrientation {
  if (!width || !height) {
    return "square";
  }

  const aspectRatio = width / height;
  if (aspectRatio < 0.82) {
    return "portrait";
  }

  if (aspectRatio > 1.18) {
    return "landscape";
  }

  return "square";
}

export function loadBackgroundDisplayCollapsed() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const stored = window.localStorage.getItem(BACKGROUND_DISPLAY_COLLAPSED_KEY);
    if (stored === "true" || stored === "false") {
      return stored === "true";
    }
  } catch {
    // Fall back to viewport defaults when local storage is unavailable.
  }

  return window.matchMedia("(max-width: 720px)").matches;
}

export function saveBackgroundDisplayCollapsed(isCollapsed: boolean) {
  try {
    window.localStorage.setItem(BACKGROUND_DISPLAY_COLLAPSED_KEY, String(isCollapsed));
  } catch {
    // Collapsing remains available for the current page session.
  }
}

export type BackgroundArtwork = {
  id: string;
  label: string;
  src: string;
};

export function getBackgroundArtworks(): BackgroundArtwork[] {
  return Object.entries(backgroundModules)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([id, src], index) => ({
      id,
      label: `Фон ${index + 1}`,
      src
    }));
}

export function getAvailableBackgrounds() {
  return getBackgroundArtworks().map(({ src }) => src);
}

function readStoredBackground(storage: Storage, key: string, available: string[]) {
  try {
    const stored = storage.getItem(key);
    if (stored && available.includes(stored)) {
      return stored;
    }

    if (stored) {
      storage.removeItem(key);
    }
  } catch {
    return null;
  }

  return null;
}

export function saveBackgroundSelection(background: string) {
  if (typeof window === "undefined" || !getAvailableBackgrounds().includes(background)) {
    return;
  }

  try {
    window.localStorage.setItem(ACTIVE_BACKGROUND_KEY, background);
  } catch {
    // The active background still applies for the current page session.
  }

  try {
    window.sessionStorage.setItem(SESSION_BACKGROUND_KEY, background);
  } catch {
    // Session storage can be unavailable in privacy-restricted environments.
  }
}

export function pickSessionBackground() {
  if (typeof window === "undefined") {
    return null;
  }

  const available = getAvailableBackgrounds();
  if (!available.length) {
    try {
      window.sessionStorage.removeItem(SESSION_BACKGROUND_KEY);
    } catch {
      // Nothing to clean up when session storage is unavailable.
    }
    return null;
  }

  let selected: string | null = null;
  try {
    selected = readStoredBackground(window.localStorage, ACTIVE_BACKGROUND_KEY, available);
  } catch {
    // Continue with session-only selection when local storage is unavailable.
  }
  if (selected) {
    return selected;
  }

  let sessionBackground: string | null = null;
  try {
    sessionBackground = readStoredBackground(window.sessionStorage, SESSION_BACKGROUND_KEY, available);
  } catch {
    // Fall back to a random background when session storage is unavailable.
  }
  if (sessionBackground) {
    return sessionBackground;
  }

  const next = available[Math.floor(Math.random() * available.length)] || available[0];
  try {
    window.sessionStorage.setItem(SESSION_BACKGROUND_KEY, next);
  } catch {
    // The randomly selected background still works without persistence.
  }
  return next;
}
