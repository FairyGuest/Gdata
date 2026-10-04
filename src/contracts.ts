
import { inputError } from "./errors.ts";

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export type TokenRequest =
  | {
      grantType: "authorization_code";
      code: string;
      redirectUri: string;
      clientId: string;
      codeVerifier: string;
    }
  | { grantType: "refresh_token"; refreshToken: string };

type Params = Record<string, unknown>;

function reqString(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw inputError("missing or invalid parameter: " + key);
  }
  return v;
}

export function parseAuthorizeRequest(p: Params): AuthorizeRequest {
  if (p["response_type"] !== "code") {
    throw inputError("response_type must be 'code'");
  }
  const method = reqString(p, "code_challenge_method");
  if (method !== "S256") {
    throw inputError("code_challenge_method must be 'S256'");
  }
  return {
    clientId: reqString(p, "client_id"),
    redirectUri: reqString(p, "redirect_uri"),
    codeChallenge: reqString(p, "code_challenge"),
    codeChallengeMethod: "S256",
  };
}

export function parseTokenRequest(p: Params): TokenRequest {
  const grantType = p["grant_type"];
  if (grantType === "authorization_code") {
    return {
      grantType,
      code: reqString(p, "code"),
      redirectUri: reqString(p, "redirect_uri"),
      clientId: reqString(p, "client_id"),
      codeVerifier: reqString(p, "code_verifier"),
    };
  }
  if (grantType === "refresh_token") {
    return { grantType, refreshToken: reqString(p, "refresh_token") };
  }
  throw inputError("grant_type must be 'authorization_code' or 'refresh_token'");
}
