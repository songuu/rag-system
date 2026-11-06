import type { EntityProfile } from './types';
import type { NativeSimulationSnapshot } from './simulation-policy';

export interface SimulationExport { content:string;contentType:string;extension:'json'|'csv' }
const csvCell=(value:unknown)=>{let text=String(value??'');if(/^[\s]*[=+@-]/.test(text))text=`'${text}`;return `"${text.replace(/"/g,'""')}"`;};
const persona=(profile:EntityProfile)=>[profile.background,profile.personality_traits.join(', '),profile.speaking_style,...Object.entries(profile.viewpoints).map(([topic,view])=>`${topic}: ${view}`)].filter(Boolean).join('\n');
export function exportSimulation(snapshot:NativeSimulationSnapshot,format:string):SimulationExport {
  const profiles=snapshot.info.agent_profiles;
  if(format==='twitter-csv')return {contentType:'text/csv; charset=utf-8',extension:'csv',content:'\uFEFF'+[['user_id','name','username','user_char','description'],...profiles.map((profile,index)=>[index,profile.full_name||profile.entity_name,`agent_${index}`,persona(profile),profile.background])].map(row=>row.map(csvCell).join(',')).join('\r\n')};
  if(format==='reddit-json')return {contentType:'application/json',extension:'json',content:JSON.stringify(profiles.map((profile,index)=>({user_id:index,entity_id:profile.entity_id,username:`agent_${index}`,name:profile.full_name||profile.entity_name,bio:profile.background,persona:persona(profile),karma:0,created_at:profile.generated_at,age:profile.age,gender:profile.gender,profession:profile.occupation,interested_topics:Object.keys(profile.viewpoints)})),null,2)};
  if(format==='actions-csv')return {contentType:'text/csv; charset=utf-8',extension:'csv',content:'\uFEFF'+[['sequence','round','platform','agent_id','action','target_id','success','content','observation','error_code'],...snapshot.actions.map(event=>[event.sequence,event.round,event.platform,event.agentId,event.action,event.targetId,event.success,event.content,event.observation,event.errorCode])].map(row=>row.map(csvCell).join(',')).join('\r\n')};
  const value=format==='config'?snapshot.info.config:format==='profiles'?profiles:snapshot;
  return {contentType:'application/json',extension:'json',content:JSON.stringify(value,null,2)};
}
