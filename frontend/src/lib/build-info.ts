declare const __BUILD_SHA__: string | undefined;
declare const __BUILD_TIME__: string | undefined;
declare const __BUILD_TAG__: string | undefined;

export const BUILD_SHA: string =
  typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev';
export const BUILD_TIME: string =
  typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
export const BUILD_TAG: string =
  typeof __BUILD_TAG__ !== 'undefined' ? __BUILD_TAG__ : '';

export const BUILD_LABEL: string = BUILD_TAG ? `${BUILD_TAG} ${BUILD_SHA}` : BUILD_SHA;

export function logBuildInfo(): void {
  try {
    // eslint-disable-next-line no-console
    console.info(`[opencode-webui] build ${BUILD_LABEL} @ ${BUILD_TIME}`);
  } catch {}
}
