import {verifyToken} from '@clerk/backend';

function transientTransport(error:unknown):boolean {
  if(!(error instanceof Error))return false;
  const code=(error as Error & {code?:string;cause?:{code?:string}}).cause?.code ?? (error as Error & {code?:string}).code;
  return error.name==='TimeoutError'||['ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENETUNREACH','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT'].includes(code??'');
}

/** Fetch the current session; only temporary read failures can be retried. */
async function currentSession(sessionId:string,secretKey:string):Promise<{status?:string;user_id?:string}> {
  if(!/^[a-zA-Z0-9_]+$/.test(sessionId))throw new Error('INVALID_SESSION');
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const response=await fetch('https://api.clerk.com/v1/sessions/'+encodeURIComponent(sessionId),{
        headers:{Authorization:'Bearer '+secretKey},redirect:'error',signal:AbortSignal.timeout(8000),cache:'no-store',
      });
      if([429,502,503,504].includes(response.status)&&attempt<2) {
        await new Promise(resolve=>setTimeout(resolve,250));continue;
      }
      if(!response.ok)throw new Error('SESSION_LOOKUP_DENIED');
      return await response.json();
    } catch(error) {
      if(attempt<2&&transientTransport(error)){await new Promise(resolve=>setTimeout(resolve,250));continue;}
      throw error;
    }
  }
  throw new Error('SESSION_LOOKUP_UNAVAILABLE');
}

/** Node runtime validation for explicitly enabled synthetic pilot API routes. */
export async function authenticatePilotBearer(authorization:string):Promise<string> {
  if(process.env.NASI_PROVIDER_MODE!=='synthetic-pilot')throw new Error('UNAUTHENTICATED');
  const match=/^Bearer ([^\s]+)$/i.exec(authorization);
  const secretKey=process.env.CLERK_SECRET_KEY;
  if(!match||!secretKey?.startsWith('sk_test_'))throw new Error('UNAUTHENTICATED');
  let stage='TOKEN_VERIFICATION';
  try {
    // Resolve the signing JWK by this token's kid. Browser sessions created
    // from Clerk sign-in tickets may rotate to a different active key than the
    // single build-time PEM; the secret key lets Clerk select the matching JWK.
    const claims=await verifyToken(match[1],{secretKey});
    stage='CLAIM_VALIDATION';
    if(typeof claims.sub!=='string'||typeof claims.sid!=='string'||!claims.sub||!claims.sid)throw new Error('INVALID_IDENTITY');
    stage='CURRENT_SESSION_LOOKUP';
    const session=await currentSession(claims.sid,secretKey);
    stage='CURRENT_SESSION_VALIDATION';
    if(session.status!=='active'||session.user_id!==claims.sub)throw new Error('STALE_OR_WRONG_IDENTITY');
    return claims.sub;
  } catch(error) {
    const candidate=error instanceof Error?error.message:'';
    const normalized=candidate.toLowerCase();
    const safeCode=/^[A-Z][A-Z0-9_]{2,60}$/.test(candidate)?candidate:
      /signing key|kid/.test(normalized)?'JWT_SIGNING_KEY_MISMATCH':
      /signature/.test(normalized)?'JWT_SIGNATURE_REJECTED':
      /expired/.test(normalized)?'JWT_EXPIRED':
      /not before|not active yet/.test(normalized)?'JWT_NOT_ACTIVE':
      /issued at|future/.test(normalized)?'JWT_IAT_FUTURE':
      /audience|authorized party/.test(normalized)?'JWT_PARTY_REJECTED':
      /fetch|network|timeout/.test(normalized)?'JWT_KEY_FETCH_FAILED':'UNCLASSIFIED';
    console.error('PILOT_BEARER_REJECTED',JSON.stringify({stage,error_type:error instanceof Error?error.name:'UnknownError',safe_code:safeCode}));
    throw new Error('UNAUTHENTICATED');
  }
}
