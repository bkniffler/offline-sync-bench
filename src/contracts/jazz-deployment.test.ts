import { expect,test } from 'bun:test';
import { validateJazzDeployment } from './jazz-deployment.ts';

test('Jazz requires a published policy for its exact schema before accepting setup',()=>{
  const valid={schema:{hash:'new-schema'},migration:{status:'published'},permissions:{schemaHash:'new-schema',head:{schemaHash:'new-schema',bundleObjectId:'policy-bundle',version:2}},warnings:[]};
  expect(()=>validateJazzDeployment(valid)).not.toThrow();
  expect(()=>validateJazzDeployment({...valid,migration:undefined})).not.toThrow();
  for(const invalid of [
    {schema:{hash:'new-schema'},migration:{status:'missing'},warnings:[]},
    {...valid,migration:{status:'missing'}},
    {...valid,permissions:{...valid.permissions,head:null}},
    {...valid,permissions:{...valid.permissions,schemaHash:'old-schema'}},
    {...valid,permissions:{...valid.permissions,head:{...valid.permissions.head,schemaHash:'old-schema'}}},
    {...valid,warnings:['missing grants']},
  ])expect(()=>validateJazzDeployment(invalid)).toThrow('deployment is incomplete');
  try{validateJazzDeployment({schema:{hash:'stored-only'}});}catch(error){expect((error as {evidence:unknown}).evidence).toEqual({deployment:{schema:{hash:'stored-only'}}});}
});
