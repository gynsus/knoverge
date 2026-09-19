import type {
  AuthStatusResponse,
  BootstrapRequest,
  BootstrapResponse,
  LoginRequest,
  MeResponse,
  OkResponse,
} from '@knoverge/contracts';

import { apiGet, apiPost } from './client.ts';

export const authApi = {
  status: (signal?: AbortSignal) => apiGet<AuthStatusResponse>('/v1/auth/status', signal),
  me: (signal?: AbortSignal) => apiGet<MeResponse>('/v1/auth/me', signal),
  login: (body: LoginRequest) => apiPost<MeResponse>('/v1/auth/login', body),
  logout: () => apiPost<OkResponse>('/v1/auth/logout', {}),
  bootstrap: (body: BootstrapRequest) => apiPost<BootstrapResponse>('/v1/bootstrap', body),
};
