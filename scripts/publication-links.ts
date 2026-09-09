import assert from 'node:assert/strict';
import { posix } from 'node:path';
export function publicationLinkMap(index:any):Map<string,string> {
 assert.equal(index.format,'benchmark-publication-archive-v1');assert(Array.isArray(index.files));
 const map=new Map<string,string>();
 const safe=(p:string)=>typeof p==='string'&&p!=='.'&&posix.normalize(p)===p&&!p.startsWith('/')&&!p.startsWith('../')&&!p.includes('\\');
 for(const file of index.files){
  assert(safe(file.path)&&safe(file.archive));assert(!map.has(file.path),'Duplicate archive file');
  map.set(file.path,/\.(json|log)$/.test(file.path)?file.archive:file.path);
 }
 return map;
}
export function rebasePublishedLinks(markdown:string,root:string,map:Map<string,string>):string {
 assert(root&&posix.normalize(root)===root&&!root.startsWith('/')&&!root.startsWith('../')&&!root.includes('\\'));
 return markdown.replace(/(\]\()(?!(?:[a-z]+:|#|\/))([^\s)]+)(\))/gi,(_,a,target,z)=>{
  const split=target.indexOf('#');const path=split<0?target:target.slice(0,split);const fragment=split<0?'':target.slice(split);
  const normalized=posix.normalize(path);const mapped=map.get(normalized);assert(mapped,`Missing packaged evidence: ${target}`);
  return `${a}${posix.join(root,mapped)}${fragment}${z}`;
 });
}
