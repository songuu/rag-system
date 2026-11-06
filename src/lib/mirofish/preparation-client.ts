/** Keep the running task reachable even when synchronizing the parent view fails. */
export async function adoptPreparationTask(id:string,callbacks:{onTask:(id:string)=>void;persist?:(id:string)=>Promise<void>|void;onPersistenceError:(error:unknown)=>void}):Promise<void>{
 callbacks.onTask(id);
 try{await callbacks.persist?.(id);}catch(error){callbacks.onPersistenceError(error);}
}
