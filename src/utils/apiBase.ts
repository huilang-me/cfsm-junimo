function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizeResourcePath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

export function getConfiguredApiBases(): string[] {
  const metaApiBase = document.querySelector<HTMLMetaElement>('meta[name="apiBase"]')?.content;
  return (
    metaApiBase
      ?.split(",")
      .map((item) => stripTrailingSlash(item.trim()))
      .filter(Boolean) ?? []
  );
}

export function getApiBases(): string[] {
  const bases = getConfiguredApiBases();
  return bases.length > 0 ? bases : [stripTrailingSlash(window.location.origin)];
}

export function getApiStaticAssetUrl(path: string): string {
  const baseUrl = getConfiguredApiBases()[0];
  return baseUrl ? `${baseUrl}${normalizeResourcePath(path)}` : path;
}
