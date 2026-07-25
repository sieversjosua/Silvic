import { useCallback, useEffect, useState } from "react";

import type { AppearancePreference } from "@silvic/contracts";

export type Appearance = "light" | "dark";

const darkQuery = "(prefers-color-scheme: dark)";

/**
 * React Flow paints the substrate and lineage on a canvas, so those few colours
 * have to exist as JavaScript values instead of custom properties.
 */
export const substrate = {
  light: {
    hairline: "rgba(30, 40, 32, 0.07)",
    tick: "rgba(30, 40, 32, 0.2)",
    lineage: "#2f7d59",
    lineageFaint: "rgba(47, 125, 89, 0.45)",
  },
  dark: {
    hairline: "rgba(226, 235, 224, 0.05)",
    tick: "rgba(226, 235, 224, 0.16)",
    lineage: "#58b184",
    lineageFaint: "rgba(88, 177, 132, 0.42)",
  },
} as const;

export function useAppearance(): {
  appearance: Appearance;
  preference: AppearancePreference;
  setPreference(next: AppearancePreference): void;
} {
  const [preference, setStoredPreference] =
    useState<AppearancePreference>("system");
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia(darkQuery).matches,
  );

  useEffect(() => {
    void window.silvic.getAppearance().then(setStoredPreference);
  }, []);

  // `nativeTheme.themeSource` also drives this query, so a forced preference and
  // a genuine system change arrive through the same channel.
  useEffect(() => {
    const media = window.matchMedia(darkQuery);
    const onChange = (event: MediaQueryListEvent) =>
      setSystemPrefersDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const appearance: Appearance =
    preference === "system"
      ? systemPrefersDark
        ? "dark"
        : "light"
      : preference;

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance;
    document.documentElement.style.colorScheme = appearance;
  }, [appearance]);

  const setPreference = useCallback((next: AppearancePreference) => {
    setStoredPreference(next);
    void window.silvic.setAppearance(next);
  }, []);

  return { appearance, preference, setPreference };
}
