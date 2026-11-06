/** Prefix a `public/` path with Vite's `base`, so GitHub Pages project sites resolve assets. */
export const publicUrl = (path: string): string => {
  const base = import.meta.env.BASE_URL || "/";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${path.replace(/^\/+/, "")}`;
};
