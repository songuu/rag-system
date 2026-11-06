import { NextResponse } from 'next/server';
import { RagSecurityError } from '../security/request-context';
import { RequestValidationError } from '../security/request-validation';
export function simulationApiError(error:unknown, fallback:string):NextResponse {
  if(error instanceof RagSecurityError){const body=error.toResponseBody();return NextResponse.json({success:false,error:body.error.message,code:body.error.code,requestId:body.error.requestId},{status:error.status});}
  if(error instanceof RequestValidationError)return NextResponse.json({success:false,error:error.message,code:error.code},{status:error.status});
  const code=error instanceof Error && /^(SIMULATION|PREPARE)_[A-Z_]+$/.test(error.message)?error.message:'SIMULATION_REQUEST_FAILED';
  return NextResponse.json({success:false,error:fallback,code},{status:code.includes('NOT_FOUND')?404:code==='SIMULATION_REQUEST_FAILED'?500:409});
}
