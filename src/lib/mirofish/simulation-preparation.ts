import { randomUUID } from 'node:crypto';
import { getMiroFishRuntimeStore, type MiroFishRuntimeScope, type MiroFishRuntimeStore } from './runtime-store';
import { createPrepareFingerprint, prepareMiroFishSimulation, type MiroFishPrepareInput, type PrepareServiceDependencies } from './prepare-service';
import { planSimulationConfiguration } from './config-planner';
import type { MiroFishProjectStore } from './project-store';
import type { EntityProfile, SimulationPrepareResult } from './types';
import type { NativeSimulationSnapshot } from './simulation-policy';

export interface SimulationPreparationJob {
  id:string; projectId:string; status:'processing'|'completed'|'failed'; stage:'profiles'|'config'|'persisting'|'completed'|'failed';
  current:number; total:number; itemId?:string; profiles:EntityProfile[]; result?:SimulationPrepareResult;
  errorCode?:string; recoverable?:boolean; createdAt:string; updatedAt:string;
  sourceGraphIdentity?:NativeSimulationSnapshot['sourceGraphIdentity'];
}
interface PreparationDependencies {
  scope?:MiroFishRuntimeScope;store?:MiroFishRuntimeStore;projectStore:Pick<MiroFishProjectStore,'update'>;
  serviceDependencies?:PrepareServiceDependencies;autoConfig?:boolean;language?:'zh'|'en';
  plan?:typeof planSimulationConfiguration;
  sourceGraphIdentity?:NativeSimulationSnapshot['sourceGraphIdentity'];authorize?:()=>Promise<boolean>;
}
const processJobs=globalThis as typeof globalThis & {__miroFishPreparationOwnersV1?:Set<string>};
const owners=processJobs.__miroFishPreparationOwnersV1??=new Set<string>();
const ownerKey=(scope:MiroFishRuntimeScope|undefined,id:string)=>JSON.stringify([scope??null,id]);

export async function startSimulationPreparation(input:MiroFishPrepareInput,dependencies:PreparationDependencies):Promise<SimulationPreparationJob> {
  if (/^(true|1)$/i.test(process.env.RAG_MIROFISH_SIMULATION_MULTI_INSTANCE||'')) throw new Error('SIMULATION_MULTI_INSTANCE_UNSUPPORTED');
  const selected=input.selectedEntityIds?.length?input.graphNodes.filter(node=>input.selectedEntityIds!.includes(node.uuid)):input.graphNodes;
  if (!selected.length||selected.length>50)throw new Error('PREPARE_INVALID_AGENT_COUNT');
  const store=dependencies.store??getMiroFishRuntimeStore(dependencies.scope);const now=new Date().toISOString();
  const existing=await store.list<SimulationPreparationJob>('prepare',{projectId:input.project.id,limit:200});
  if(existing.length>=200)throw new Error('PREPARE_HISTORY_CAPACITY');
  for(const prior of existing){if(prior.status==='processing'&&(await readSimulationPreparation(prior.id,{scope:dependencies.scope,store}))?.status==='processing')throw new Error('PREPARE_ALREADY_RUNNING');}
  const job:SimulationPreparationJob={id:`prepjob_${randomUUID()}`,projectId:input.project.id,status:'processing',stage:'profiles',current:0,total:selected.length,profiles:[],createdAt:now,updatedAt:now};
  if(dependencies.sourceGraphIdentity)job.sourceGraphIdentity=structuredClone(dependencies.sourceGraphIdentity);
  const key=ownerKey(dependencies.scope,job.id);owners.add(key);
  const save=async()=>{job.updatedAt=new Date().toISOString();await store.write('prepare',job.id,job,{projectId:job.projectId});};
  try {await save();const project=await dependencies.projectStore.update(input.project.id,{prepare_task_id:job.id});if(!project)throw new Error('PREPARE_PROJECT_NOT_FOUND');}
  catch(error){job.status='failed';job.stage='failed';job.errorCode='PREPARE_REGISTRATION_FAILED';owners.delete(key);await save();throw error;}
  const run=async()=>{
    try {
      if(dependencies.authorize&&!await dependencies.authorize())throw new Error('PREPARE_SOURCE_UNAVAILABLE');
      const result=await prepareMiroFishSimulation({...input,profileOptions:{...input.profileOptions,language:dependencies.language??input.profileOptions?.language}},{...dependencies.serviceDependencies,onProgress:async(current,total,id,profile)=>{
        job.current=current;job.total=total;job.itemId=id;job.profiles.push(profile);await save();await dependencies.serviceDependencies?.onProgress?.(current,total,id,profile);
      }});
      job.profiles=result.profiles;
      if(dependencies.autoConfig&&!result.already_prepared){
        job.stage='config';job.current=0;job.total=1;await save();
        result.config=await(dependencies.plan??planSimulationConfiguration)({requirement:input.project.simulation_requirement,texts:input.project.texts,profiles:result.profiles,draft:input.config,modelOverride:input.modelOverride,language:dependencies.language});
        result.prepare_fingerprint=createPrepareFingerprint({projectId:input.project.id,simulationRequirement:input.project.simulation_requirement,selectedEntityIds:selected.map(node=>node.uuid),graphNodes:input.graphNodes,config:result.config,modelOverride:input.modelOverride});
      }
      job.stage='persisting';job.current=1;job.total=1;await save();
      if(dependencies.authorize&&!await dependencies.authorize())throw new Error('PREPARE_SOURCE_UNAVAILABLE');
      const updated=await dependencies.projectStore.update(input.project.id,{agent_profiles:result.profiles,simulation_config:result.config,prepare_id:result.prepare_id,prepare_fingerprint:result.prepare_fingerprint,prepared_at:result.prepared_at});
      if(!updated)throw new Error('PREPARE_PROJECT_NOT_FOUND');
      job.result=result;job.stage='completed';job.status='completed';await save();
    }catch(cause){job.status='failed';job.stage='failed';job.errorCode=cause instanceof Error&&cause.message==='PREPARE_SOURCE_UNAVAILABLE'?'PREPARE_SOURCE_UNAVAILABLE':'PREPARE_GENERATION_FAILED';job.recoverable=true;await save();}
    finally{owners.delete(key);}
  };
  void run().catch(()=>{owners.delete(key);});
  return structuredClone(job);
}

export async function readSimulationPreparation(id:string,dependencies:{scope?:MiroFishRuntimeScope;store?:MiroFishRuntimeStore}={}):Promise<SimulationPreparationJob|null>{
  const store=dependencies.store??getMiroFishRuntimeStore(dependencies.scope);const job=await store.read<SimulationPreparationJob>('prepare',id);
  if(job?.status==='processing'&&!owners.has(ownerKey(dependencies.scope,id))){job.status='failed';job.stage='failed';job.errorCode='PREPARE_INTERRUPTED';job.recoverable=true;await store.write('prepare',id,job,{projectId:job.projectId});}
  return job;
}
