import { ContractError } from './screens.ts';

/** Native deploy can resolve after storing a schema while withholding its policy. */
export function validateJazzDeployment(value: unknown): void {
  const result=value as {schema?:{hash?:unknown};migration?:{status?:unknown};permissions?:{schemaHash?:unknown;head?:{schemaHash?:unknown;bundleObjectId?:unknown;version?:unknown}|null};warnings?:unknown};
  const head=result?.permissions?.head;
  if(typeof result?.schema?.hash!=='string'||!result.schema.hash||result.migration?.status==='missing'||result.permissions?.schemaHash!==result.schema.hash||head?.schemaHash!==result.schema.hash||typeof head?.bundleObjectId!=='string'||!head.bundleObjectId||!Number.isSafeInteger(head.version)||Number(head.version)<1||!Array.isArray(result.warnings)||result.warnings.length) {
    const error=new ContractError('Jazz schema and permissions deployment is incomplete');
    error.evidence={deployment:JSON.parse(JSON.stringify(value??null))};throw error;
  }
}
