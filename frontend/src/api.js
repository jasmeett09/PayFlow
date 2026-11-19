import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

export const tokenKey = 'payflow-access-token';
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api/v1',
  timeout: 20000,
});

api.interceptors.request.use(config => {
  const token = sessionStorage.getItem(tokenKey);
  if (token) config.headers.Authorization = 'Bearer ' + token;
  return config;
});

api.interceptors.response.use(response => response, error => {
  if (error.response?.status === 401 && !['/auth/login', '/auth/register'].includes(error.config?.url)) {
    window.dispatchEvent(new Event('payflow-session-expired'));
  }
  return Promise.reject(error);
});

export function messageFor(error) {
  const errorBody = error.response?.data?.error;
  const fields = errorBody?.details?.map(item => item.field).filter(Boolean);
  if (fields?.length) return 'Check these fields: ' + [...new Set(fields)].join(', ') + '.';
  if (errorBody?.message) return errorBody.message;
  if (!error.response || error.response.status >= 500) {
    return import.meta.env.DEV
      ? 'Could not reach the PayFlow API. Check that the backend is running and connected to PostgreSQL and Redis.'
      : 'The PayFlow API is unavailable. Try again in a moment.';
  }
  return 'The request could not be completed.';
}

export async function send(method, url, data, config) {
  const response = await api.request({ method, url, data, ...config });
  return response.data.data;
}

export function useResource(url, params, refreshMs = 0) {
  const query = JSON.stringify(params ?? {});
  const lastQuery = useRef(null);
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(current => current + 1), []);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await send('get', url, undefined, { params: JSON.parse(query), signal: controller.signal });
        if (!controller.signal.aborted) setState({ data, loading: false, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setState({ data: null, loading: false, error: messageFor(error) });
      } finally {
        inFlight = false;
      }
    }
    const resourceKey = url + query;
    if (resourceKey !== lastQuery.current) {
      setState({ data: null, loading: true, error: null });
      lastQuery.current = resourceKey;
    }
    void load();
    const timer = refreshMs ? window.setInterval(load, refreshMs) : undefined;
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [url, query, revision, refreshMs]);
  return { ...state, reload };
}

export function useAction() {
  const [state, setState] = useState({ busy: false, error: null, success: null });
  async function run(callback, success = null) {
    setState({ busy: true, error: null, success: null });
    try {
      const data = await callback();
      setState({ busy: false, error: null, success });
      return data;
    } catch (error) {
      setState({ busy: false, error: error.userMessage || messageFor(error), success: null });
      return undefined;
    }
  }
  return { ...state, run };
}

export function invalid(message) {
  throw Object.assign(new Error(message), { userMessage: message });
}
