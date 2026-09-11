/**
 * `expo/fetch` answered by the test. `http.answer` decides what a request
 * gets (a status and a body, or a status below zero for no answer at all),
 * and every request made is in `http.calls`, oldest first, with its body
 * already parsed.
 */
export interface HttpCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpAnswer {
  status: number;
  body?: unknown;
  /** The headers arrive and the body never does: a socket that dies mid-answer. */
  bodyFails?: boolean;
}

export const http = {
  calls: [] as HttpCall[],
  answer: ((): HttpAnswer => ({ status: 200, body: {} })) as (url: string, call: HttpCall) => HttpAnswer,
  reset(): void {
    this.calls = [];
    this.answer = () => ({ status: 200, body: {} });
  },
};

export async function fetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const call: HttpCall = {
    url,
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  };
  http.calls.push(call);
  const answer = http.answer(url, call);
  if (answer.status < 0) throw new TypeError('Network request failed');
  const text =
    answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    text: async () => {
      if (answer.bodyFails) throw new TypeError('Network request failed');
      return text;
    },
    json: async () => JSON.parse(text) as unknown,
  } as unknown as Response;
}
