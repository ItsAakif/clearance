// The landing page is hosted separately from the app, so every destination that
// leaves the marketing page goes through this helper. In development / the
// monorepo deploy `VITE_APP_URL` is unset and the app lives at the same origin;
// a standalone landing sets it to the app origin (for example
// `https://app.clearance.example`) at build time.
const configuredBase = import.meta.env.VITE_APP_URL || "/";

/** The app origin without a trailing slash; empty means "same origin". */
export const APP_URL = configuredBase.replace(/\/+$/, "");

/** Join an app path onto `APP_URL` without ever producing a double slash. */
export function appHref(path: string): string {
  const cleanPath = `/${path.replace(/^\/+/, "")}`;
  return `${APP_URL}${cleanPath}`;
}
