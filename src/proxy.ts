const proxyEnv = (env: NodeJS.ProcessEnv): string | undefined => {
  const value = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** Bun reads this field. It is omitted on Node, whose fetch ignores it. */
export const isBun = (): boolean => "Bun" in globalThis;

export const proxyUrl = (): string | undefined => proxyEnv(process.env);

export const proxiedFetch = (input: string, init: RequestInit): Promise<Response> => {
  const proxy = proxyUrl();
  if (!isBun() || !proxy) return fetch(input, init);
  return fetch(input, { ...init, proxy } as RequestInit);
};
