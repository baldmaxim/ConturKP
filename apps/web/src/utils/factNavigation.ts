/** Only a facts tab can be a citation's return destination. Survives reloads and copied links. */
export const factReturnPath = (value: string | null): string | null => {
  if (!value || /[\\\u0000-\u0020]/u.test(value)) return null;
  try {
    const url = new URL(value, 'https://portal.invalid');
    if (url.origin !== 'https://portal.invalid' || !/^\/(?:contracts|tenders)\/[\da-f-]{36}$/iu.test(url.pathname) || url.searchParams.get('tab') !== 'facts') return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
};
