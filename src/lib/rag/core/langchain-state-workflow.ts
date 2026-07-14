import {
  RunnableLambda,
  type RunnableConfig,
} from '@langchain/core/runnables';

export type StatePatch<TState> = Partial<TState>;
export type StateNode<TState> = (
  state: TState
) => StatePatch<TState> | Promise<StatePatch<TState>>;

export type StateMerge<TState> = (
  state: TState,
  patch: StatePatch<TState>
) => TState;

export interface RunnableStateNode<TState> {
  name: string;
  invoke: (
    state: TState,
    config?: RunnableConfig
  ) => Promise<StatePatch<TState>>;
}

export function createRunnableStateNode<TState>(
  graphName: string,
  nodeName: string,
  node: StateNode<TState>
): RunnableStateNode<TState> {
  const runnable = RunnableLambda.from<TState, StatePatch<TState>>(node);

  return {
    name: nodeName,
    invoke: (state, config) =>
      runnable.invoke(state, withStateNodeConfig(config, graphName, nodeName)),
  };
}

export function applyStatePatch<TState>(
  state: TState,
  patch: StatePatch<TState>,
  appendKeys: Array<keyof TState> = []
): TState {
  const next = { ...state, ...patch };

  for (const key of appendKeys) {
    const currentValue = state[key];
    const patchValue = patch[key];
    if (Array.isArray(patchValue)) {
      const currentItems = Array.isArray(currentValue) ? currentValue : [];
      next[key] = [...currentItems, ...patchValue] as TState[keyof TState];
    }
  }

  return next;
}

function withStateNodeConfig(
  config: RunnableConfig | undefined,
  graphName: string,
  nodeName: string
): RunnableConfig {
  return {
    ...(config ?? {}),
    runName: `${graphName}.${nodeName}`,
    tags: uniqueStrings([
      graphName,
      nodeName,
      ...((config?.tags as string[] | undefined) ?? []),
    ]),
    metadata: {
      ...(config?.metadata ?? {}),
      graph_name: graphName,
      node_name: nodeName,
    },
  };
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}
