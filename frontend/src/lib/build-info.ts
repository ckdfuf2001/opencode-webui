declare const __BUILD_SHA__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export const BUILD_SHA: string =
  typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev';
export const BUILD_TIME: string =
  typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';

export function logBuildInfo(): void {
  try {
    // eslint-disable-next-line no-console
    console.info(`[opencode-webui] build ${BUILD_SHA} @ ${BUILD_TIME}`);
  } catch {}
}
