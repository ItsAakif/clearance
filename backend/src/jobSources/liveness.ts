// Liveness check - verify a posting is still open before spending eval tokens.
// Mirrors career-ops check-liveness.mjs. Zero-token: a HEAD/GET probe.

export async function checkLiveness(url?: string): Promise<boolean> {
  if (!url) return true; // unknown => assume alive
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'ClearanceJobBot/1.0' },
    });
    clearTimeout(timeout);
    if (res.status === 404 || res.status === 410) return false;
    return res.status < 500;
  } catch {
    return true; // network error => don't penalize
  }
}
