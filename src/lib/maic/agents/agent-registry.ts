/**
 * Agent 注册表: 单例,按角色懒加载
 */

import type { AgentRole } from '../types';
import { BaseAgent } from './base-agent';

class AgentRegistry {
  private agents: Map<AgentRole, BaseAgent> = new Map();

  get(role: AgentRole): BaseAgent {
    if (role === 'manager') {
      throw new Error('manager 角色不通过 BaseAgent 调用');
    }
    let agent = this.agents.get(role);
    if (!agent) {
      agent = new BaseAgent(role);
      this.agents.set(role, agent);
    }
    return agent;
  }
}

let instance: AgentRegistry | null = null;

export function getAgentRegistry(): AgentRegistry {
  if (!instance) instance = new AgentRegistry();
  return instance;
}
