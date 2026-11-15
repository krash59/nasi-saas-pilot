import {Client} from 'pg';
import {randomBytes} from 'node:crypto';
// @ts-expect-error plain ESM script without types
import {totp} from '../../scripts/operator-mfa.mjs';
/** S02_01: enrol a test operator login (as the DB owner) and open its 10-minute MFA session with a real TOTP code. */
export async function mfaSession(admin:Client,url:string,login:string):Promise<Buffer>{
 const secret=randomBytes(20);await admin.query('SELECT operator_mfa_enroll($1,$2)',[login,secret]);
 const c=new Client({connectionString:url});await c.connect();
 try{const r=(await c.query('SELECT operator_mfa_verify($1) AS j',[totp(secret)])).rows[0].j;if(r.denied)throw new Error(r.denied);}finally{await c.end();}
 return secret;
}
