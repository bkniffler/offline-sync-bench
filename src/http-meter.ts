interface BodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpMeterSnapshot {
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
}

function hasArrayBuffer(value: object): value is BodyLike {
  return 'arrayBuffer' in value && typeof value.arrayBuffer === 'function';
}

export function createHttpMeter(baseFetch: typeof fetch = fetch): {
  fetch: typeof fetch;
  snapshot: () => HttpMeterSnapshot;
} {
  let requestCount = 0;
  let requestBytes = 0;
  let responseBytes = 0;

  const meteredFetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1;

      const request =
        input instanceof Request ? input : new Request(input, init);

      if (request.body) {
        const requestClone = request.clone();
        requestBytes += (await requestClone.arrayBuffer()).byteLength;
      } else if (typeof init?.body === 'string') {
        requestBytes += new TextEncoder().encode(init.body).byteLength;
      } else if (
        init?.body &&
        typeof init.body === 'object' &&
        hasArrayBuffer(init.body)
      ) {
        requestBytes += (await init.body.arrayBuffer()).byteLength;
      }

      const response = await baseFetch(request);
      responseBytes += (await response.clone().arrayBuffer()).byteLength;
      return response;
    };

  const meteredFetch = Object.assign(
    meteredFetchImpl,
    typeof baseFetch.preconnect === 'function'
      ? {
          preconnect: baseFetch.preconnect.bind(baseFetch),
        }
      : {}
  ) as typeof fetch;

  return {
    fetch: meteredFetch,
    snapshot: () => ({
      requestCount,
      requestBytes,
      responseBytes,
    }),
  };
}
