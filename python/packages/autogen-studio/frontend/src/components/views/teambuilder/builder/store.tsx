import { create } from "zustand";
import { clone, isEqual } from "lodash";
import {
  CustomNode,
  CustomEdge,
  Position,
  NodeData,
  GraphState,
} from "./types";
import { nanoid } from "nanoid";
import {
  TeamConfig,
  AgentConfig,
  ToolConfig,
  WorkbenchConfig,
  StaticWorkbenchConfig,
  Component,
  ComponentConfig,
} from "../../../types/datamodel";
import {
  convertTeamConfigToGraph,
  getLayoutedElements,
  updateNodeDimensions,
  getUniqueName,
} from "./utils";
import {
  markNodeAsUserPositioned,
  clearUserPositionedFlags,
  generateComponentKey,
} from "./layout-storage";
import {
  isTeamComponent,
  isAgentComponent,
  isToolComponent,
  isWorkbenchComponent,
  isTerminationComponent,
  isModelComponent,
  isSelectorTeam,
  isAssistantAgent,
  isWebSurferAgent,
  isStaticWorkbench,
} from "../../../types/guards";

// Helper function to normalize workbench format (handle both single object and array)
const normalizeWorkbenches = (
  workbench:
    | Component<WorkbenchConfig>[]
    | Component<WorkbenchConfig>
    | undefined
): Component<WorkbenchConfig>[] => {
  if (!workbench) return [];
  return Array.isArray(workbench) ? workbench : [workbench];
};

const MAX_HISTORY = 50;

export interface TeamBuilderState {
  nodes: CustomNode[];
  edges: CustomEdge[];
  selectedNodeId: string | null;
  history: Array<{ nodes: CustomNode[]; edges: CustomEdge[] }>;
  currentHistoryIndex: number;
  originalComponent: Component<TeamConfig> | null;
  teamId: string | null;

  // Simplified actions
  addNode: (
    position: Position,
    component: Component<ComponentConfig>,
    targetNodeId: string
  ) => void;

  updateNode: (nodeId: string, updates: Partial<NodeData>) => void;
  removeNode: (nodeId: string) => void;

  addEdge: (edge: CustomEdge) => void;
  removeEdge: (edgeId: string) => void;

  setSelectedNode: (nodeId: string | null) => void;
  setNodeUserPositioned: (nodeId: string, position: Position) => void;

  undo: () => void;
  redo: () => void;

  // Sync with JSON
  syncToJson: () => Component<TeamConfig> | null;
  loadFromJson: (
    config: Component<TeamConfig>,
    isInitialLoad?: boolean,
    teamId?: string
  ) => GraphState;
  layoutNodes: () => void;
  resetHistory: () => void;
  addToHistory: () => void;
}

const buildTeamComponent = (
  teamNode: CustomNode,
  nodes: CustomNode[],
  edges: CustomEdge[]
): Component<TeamConfig> | null => {
  if (!isTeamComponent(teamNode.data.component)) return null;

  const component = { ...teamNode.data.component };

  // Get participants using edges
  const participantEdges = edges.filter(
    (e) => e.source === teamNode.id && e.type === "agent-connection"
  );
  component.config.participants = participantEdges
    .map((edge) => {
      const agentNode = nodes.find((n) => n.id === edge.target);
      if (!agentNode || !isAgentComponent(agentNode.data.component))
        return null;
      return agentNode.data.component;
    })
    .filter((agent): agent is Component<AgentConfig> => agent !== null);

  return component;
};

export const useTeamBuilderStore = create<TeamBuilderState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  history: [],
  currentHistoryIndex: -1,
  originalComponent: null,
  teamId: null,

  setNodeUserPositioned: (nodeId: string, position: Position) => {
    const state = get();
    if (state.teamId) {
      const node = state.nodes.find((n) => n.id === nodeId);
      if (node) {
        markNodeAsUserPositioned(state.teamId, node, position);
      }
    }
  },

  addNode: (
    position: Position,
    component: Component<ComponentConfig>,
    targetNodeId: string
  ) => {
    set((state) => {
      // Deep clone the incoming component to avoid reference issues
      const clonedComponent = JSON.parse(JSON.stringify(component));
      let newNodes = [...state.nodes];
      let newEdges = [...state.edges];

      if (targetNodeId) {
        const targetNode = state.nodes.find((n) => n.id === targetNodeId);

        // console.log("Target node", targetNode);
        if (!targetNode) return state;

        // Handle configuration updates based on component type
        if (isModelComponent(clonedComponent)) {
          if (
            isTeamComponent(targetNode.data.component) &&
            isSelectorTeam(targetNode.data.component)
          ) {
            targetNode.data.component.config.model_client = clonedComponent;
            return {
              nodes: newNodes,
              edges: newEdges,
              history: [
                ...state.history.slice(0, state.currentHistoryIndex + 1),
                { nodes: newNodes, edges: newEdges },
              ].slice(-MAX_HISTORY),
              currentHistoryIndex: state.currentHistoryIndex + 1,
            };
          } else if (
            isAgentComponent(targetNode.data.component) &&
            (isAssistantAgent(targetNode.data.component) ||
              isWebSurferAgent(targetNode.data.component))
          ) {
            targetNode.data.component.config.model_client = clonedComponent;
            return {
              nodes: newNodes,
              edges: newEdges,
              history: [
                ...state.history.slice(0, state.currentHistoryIndex + 1),
                { nodes: newNodes, edges: newEdges },
              ].slice(-MAX_HISTORY),
              currentHistoryIndex: state.currentHistoryIndex + 1,
            };
          }
        } else if (isToolComponent(clonedComponent)) {
          if (
            isAgentComponent(targetNode.data.component) &&
            isAssistantAgent(targetNode.data.component)
          ) {
            // Get or create workbenches array
            if (!targetNode.data.component.config.workbench) {
              targetNode.data.component.config.workbench = [];
            }

            let workbenches = normalizeWorkbenches(
              targetNode.data.component.config.workbench
            );

            // Find existing StaticWorkbench or create one
            let staticWorkbenchIndex = workbenches.findIndex((wb) =>
              isStaticWorkbench(wb)
            );

            if (staticWorkbenchIndex === -1) {
              // Create a new StaticWorkbench
              const newWorkbench: Component<StaticWorkbenchConfig> = {
                provider: "autogen_core.tools.StaticWorkbench",
                component_type: "workbench",
                version: 1,
                component_version: 1,
                config: {
                  tools: [],
                },
                label: "Static Workbench",
                description: "A static workbench for managing custom tools",
              };
              workbenches = [...workbenches, newWorkbench];
              targetNode.data.component.config.workbench = workbenches;
              staticWorkbenchIndex = workbenches.length - 1;
            }

            // Type guard to ensure we have a StaticWorkbench (which supports tools)
            const workbench = workbenches[staticWorkbenchIndex];
            if (isStaticWorkbench(workbench)) {
              const staticWorkbenchConfig =
                workbench.config as StaticWorkbenchConfig;

              // Ensure the workbench has tools array
              if (!staticWorkbenchConfig.tools) {
                staticWorkbenchConfig.tools = [];
              }

              // Generate unique tool name within the workbench
              const toolName = getUniqueName(
                clonedComponent.config.name || clonedComponent.label || "tool",
                staticWorkbenchConfig.tools.map(
                  (t: Component<ToolConfig>) =>
                    t.config.name || t.label || "tool"
                )
              );
              clonedComponent.config.name = toolName;

              // Add tool to workbench
              staticWorkbenchConfig.tools.push(clonedComponent);
            }

            return {
              nodes: newNodes,
              edges: newEdges,
              history: [
                ...state.history.slice(0, state.currentHistoryIndex + 1),
                { nodes: newNodes, edges: newEdges },
              ].slice(-MAX_HISTORY),
              currentHistoryIndex: state.currentHistoryIndex + 1,
            };
          }
        } else if (isTerminationComponent(clonedComponent)) {
          console.log("Termination component added", clonedComponent);
          if (isTeamComponent(targetNode.data.component)) {
            newNodes = state.nodes.map((node) => {
              if (node.id === targetNodeId) {
                return {
                  ...node,
                  data: {
                    ...node.data,
                    component: {
                      ...node.data.component,
                      config: {
                        ...node.data.component.config,
                        termination_condition: clonedComponent,
                      },
                    },
                  },
                };
              }
              return node;
            });

            return {
              nodes: newNodes,
              edges: newEdges,
              history: [
                ...state.history.slice(0, state.currentHistoryIndex + 1),
                { nodes: newNodes, edges: newEdges },
              ].slice(-MAX_HISTORY),
              currentHistoryIndex: state.currentHistoryIndex + 1,
            };
          }
        } else if (isWorkbenchComponent(clonedComponent)) {
          if (
            isAgentComponent(targetNode.data.component) &&
            isAssistantAgent(targetNode.data.component)
          ) {
            // Initialize workbench array if needed
            if (!targetNode.data.component.config.workbench) {
              targetNode.data.component.config.workbench = [];
            }

            // Normalize to array format
            let workbenches = normalizeWorkbenches(
              targetNode.data.component.config.workbench
            );

            // Add the new workbench
            workbenches.push(clonedComponent);
            targetNode.data.component.config.workbench = workbenches;

            return {
              nodes: newNodes,
              edges: newEdges,
              history: [
                ...state.history.slice(0, state.currentHistoryIndex + 1),
                { nodes: newNodes, edges: newEdges },
              ].slice(-MAX_HISTORY),
              currentHistoryIndex: state.currentHistoryIndex + 1,
            };
          }
        }
      }

      // Handle team and agent nodes
      if (isTeamComponent(clonedComponent)) {
        const newNode: CustomNode = {
          id: nanoid(),
          position,
          type: clonedComponent.component_type,
          data: {
            label: clonedComponent.label || "Team",
            component: clonedComponent,
            type: clonedComponent.component_type as NodeData["type"],
          },
        };
        newNodes.push(newNode);
      } else if (isAgentComponent(clonedComponent)) {
        // Find the team node to connect to
        const teamNode = newNodes.find((n) =>
          isTeamComponent(n.data.component)
        );
        if (teamNode) {
          // Ensure unique agent name
          if (
            isAssistantAgent(clonedComponent) &&
            isTeamComponent(teamNode.data.component)
          ) {
            const existingAgents =
              teamNode.data.component.config.participants || [];
            const existingNames = existingAgents.map((p) => p.config.name);
            clonedComponent.config.name = getUniqueName(
              clonedComponent.config.name,
              existingNames
            );
          }

          const newNode: CustomNode = {
            id: nanoid(),
            position,
            type: clonedComponent.component_type,
            data: {
              label: clonedComponent.label || clonedComponent.config.name,
              component: clonedComponent,
              type: clonedComponent.component_type as NodeData["type"],
            },
          };

          newNodes.push(newNode);

          // Add connection to team
          newEdges.push({
            id: nanoid(),
            source: teamNode.id,
            target: newNode.id,
            sourceHandle: `${teamNode.id}-agent-output-handle`,
            targetHandle: `${newNode.id}-agent-input-handle`,
            type: "agent-connection",
          });

          // Update team's participants
          if (isTeamComponent(teamNode.data.component)) {
            if (!teamNode.data.component.config.participants) {
              teamNode.data.component.config.participants = [];
            }
            teamNode.data.component.config.participants.push(
              newNode.data.component as Component<AgentConfig>
            );
          }
        }
      } else if (isWorkbenchComponent(clonedComponent)) {
        const newNode: CustomNode = {
          id: nanoid(),
          position,
          type: clonedComponent.component_type,
          data: {
            label: clonedComponent.label || "Workbench",
            component: clonedComponent,
            type: clonedComponent.component_type as NodeData["type"],
          },
        };
        newNodes.push(newNode);
      }

      // For adding components to existing nodes (tools, models, etc.),
      // only update dimensions to preserve user positioning
      if (targetNodeId) {
        const { nodes: updatedNodes, edges: updatedEdges } =
          updateNodeDimensions(newNodes, newEdges);
        return {
          nodes: updatedNodes,
          edges: updatedEdges,
          history: [
            ...state.history.slice(0, state.currentHistoryIndex + 1),
            { nodes: updatedNodes, edges: updatedEdges },
          ].slice(-MAX_HISTORY),
          currentHistoryIndex: state.currentHistoryIndex + 1,
        };
      }

      // For new team/agent nodes, use full layout
      const { nodes: layoutedNodes, edges: layoutedEdges } =
        getLayoutedElements(newNodes, newEdges, state.teamId || undefined);

      return {
        nodes: layoutedNodes,
        edges: layoutedEdges,
        history: [
          ...state.history.slice(0, state.currentHistoryIndex + 1),
          { nodes: layoutedNodes, edges: layoutedEdges },
        ].slice(-MAX_HISTORY),
        currentHistoryIndex: state.currentHistoryIndex + 1,
      };
    });
  },

  updateNode: (nodeId: string, updates: Partial<NodeData>) => {
    set((state) => {
      const newNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          // If this isn't the directly updated node, check if it needs related updates
          const isTeamWithUpdatedAgent =
            isTeamComponent(node.data.component) &&
            state.edges.some(
              (e) =>
                e.type === "agent-connection" &&
                e.target === nodeId &&
                e.source === node.id
            );

          if (isTeamWithUpdatedAgent && isTeamComponent(node.data.component)) {
            return {
              ...node,
              data: {
                ...node.data,
                component: {
                  ...node.data.component,
                  config: {
                    ...node.data.component.config,
                    participants: node.data.component.config.participants.map(
                      (participant) =>
                        participant ===
                        state.nodes.find((n) => n.id === nodeId)?.data.component
                          ? updates.component
                          : participant
                    ),
                  },
                },
              },
            };
          }
          return node;
        }

        // This is the directly updated node
        const updatedComponent = updates.component || node.data.component;
        return {
          ...node,
          data: {
            ...node.data,
            ...updates,
            component: updatedComponent,
          },
        };
      });

      return {
        nodes: newNodes,
        history: [
          ...state.history.slice(0, state.currentHistoryIndex + 1),
          { nodes: newNodes, edges: state.edges },
        ].slice(-MAX_HISTORY),
        currentHistoryIndex: state.currentHistoryIndex + 1,
      };
    });
  },

  removeNode: (nodeId: string) => {
    set((state) => {
      const nodesToRemove = new Set<string>();
      const updatedNodes = new Map<string, CustomNode>();

      const collectNodesToRemove = (id: string) => {
        const node = state.nodes.find((n) => n.id === id);
        if (!node) return;

        nodesToRemove.add(id);

        // Find all edges connected to this node
        const connectedEdges = state.edges.filter(
          (edge) => edge.source === id || edge.target === id
        );

        // Handle cascading deletes based on component type
        if (isTeamComponent(node.data.component)) {
          // Find and remove all connected agents
          connectedEdges
            .filter((e) => e.type === "agent-connection")
            .forEach((e) => collectNodesToRemove(e.target));
        } else if (isAgentComponent(node.data.component)) {
          // Update team's participants if agent is connected to a team
          const teamEdge = connectedEdges.find(
            (e) => e.type === "agent-connection"
          );
          if (teamEdge) {
            const teamNode = state.nodes.find((n) => n.id === teamEdge.source);
            if (teamNode && isTeamComponent(teamNode.data.component)) {
              const updatedTeamNode = {
                ...teamNode,
                data: {
                  ...teamNode.data,
                  component: {
                    ...teamNode.data.component,
                    config: {
                      ...teamNode.data.component.config,
                      participants:
                        teamNode.data.component.config.participants.filter(
                          (p) => !isEqual(p, node.data.component)
                        ),
                    },
                  },
                },
              };
              updatedNodes.set(teamNode.id, updatedTeamNode);
            }
          }
        }
      };

      // Start the cascade deletion from the initial node
      collectNodesToRemove(nodeId);

      // Create new nodes array with both removals and updates
      const newNodes = state.nodes
        .filter((node) => !nodesToRemove.has(node.id))
        .map((node) => updatedNodes.get(node.id) || node);

      // Remove all affected edges
      const newEdges = state.edges.filter(
        (edge) =>
          !nodesToRemove.has(edge.source) && !nodesToRemove.has(edge.target)
      );

      return {
        nodes: newNodes,
        edges: newEdges,
        history: [
          ...state.history.slice(0, state.currentHistoryIndex + 1),
          { nodes: newNodes, edges: newEdges },
        ].slice(-MAX_HISTORY),
        currentHistoryIndex: state.currentHistoryIndex + 1,
      };
    });
  },

  addEdge: (edge: CustomEdge) => {
    set((state) => ({
      edges: [...state.edges, edge],
      history: [
        ...state.history.slice(0, state.currentHistoryIndex + 1),
        { nodes: state.nodes, edges: [...state.edges, edge] },
      ].slice(-MAX_HISTORY),
      currentHistoryIndex: state.currentHistoryIndex + 1,
    }));
  },

  removeEdge: (edgeId: string) => {
    set((state) => ({
      edges: state.edges.filter((edge) => edge.id !== edgeId),
      history: [
        ...state.history.slice(0, state.currentHistoryIndex + 1),
        {
          nodes: state.nodes,
          edges: state.edges.filter((edge) => edge.id !== edgeId),
        },
      ].slice(-MAX_HISTORY),
      currentHistoryIndex: state.currentHistoryIndex + 1,
    }));
  },

  setSelectedNode: (nodeId: string | null) => {
    set({ selectedNodeId: nodeId });
  },

  undo: () => {
    set((state) => {
      if (state.currentHistoryIndex <= 0) return state;

      const previousState = state.history[state.currentHistoryIndex - 1];
      return {
        ...state,
        nodes: previousState.nodes,
        edges: previousState.edges,
        currentHistoryIndex: state.currentHistoryIndex - 1,
      };
    });
  },

  redo: () => {
    set((state) => {
      if (state.currentHistoryIndex >= state.history.length - 1) return state;

      const nextState = state.history[state.currentHistoryIndex + 1];
      return {
        ...state,
        nodes: nextState.nodes,
        edges: nextState.edges,
        currentHistoryIndex: state.currentHistoryIndex + 1,
      };
    });
  },

  syncToJson: () => {
    const state = get();
    const teamNodes = state.nodes.filter(
      (node) => node.data.component.component_type === "team"
    );
    if (teamNodes.length === 0) return null;

    const teamNode = teamNodes[0];
    return buildTeamComponent(teamNode, state.nodes, state.edges);
  },

  layoutNodes: () => {
    const state = get();
    // Clear user-positioned flags for full layout
    if (state.teamId) {
      clearUserPositionedFlags(state.teamId);
    }

    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      state.nodes,
      state.edges,
      state.teamId || undefined,
      false // Don't preserve user positions for manual layout
    );

    set({
      nodes: layoutedNodes,
      edges: layoutedEdges,
      history: [
        ...state.history.slice(0, state.currentHistoryIndex + 1),
        { nodes: layoutedNodes, edges: layoutedEdges },
      ].slice(-MAX_HISTORY),
      currentHistoryIndex: state.currentHistoryIndex + 1,
    });
  },

  loadFromJson: (
    config: Component<TeamConfig>,
    isInitialLoad: boolean = true,
    teamId?: string
  ) => {
    // Get graph representation of team config
    const { nodes, edges } = convertTeamConfigToGraph(config, teamId);
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      nodes,
      edges,
      teamId
    );

    if (isInitialLoad) {
      // Initial load - reset history
      set({
        nodes: layoutedNodes,
        edges: layoutedEdges,
        originalComponent: config,
        teamId: teamId || null,
        history: [{ nodes: layoutedNodes, edges: layoutedEdges }],
        currentHistoryIndex: 0,
        selectedNodeId: null,
      });
    } else {
      // JSON edit - check if state actually changed
      const currentState = get();
      if (
        !isEqual(layoutedNodes, currentState.nodes) ||
        !isEqual(layoutedEdges, currentState.edges)
      ) {
        set((state) => ({
          nodes: layoutedNodes,
          edges: layoutedEdges,
          teamId: teamId || state.teamId,
          history: [
            ...state.history.slice(0, state.currentHistoryIndex + 1),
            { nodes: layoutedNodes, edges: layoutedEdges },
          ].slice(-MAX_HISTORY),
          currentHistoryIndex: state.currentHistoryIndex + 1,
        }));
      }
    }

    return { nodes: layoutedNodes, edges: layoutedEdges };
  },

  resetHistory: () => {
    set((state) => ({
      history: [{ nodes: state.nodes, edges: state.edges }],
      currentHistoryIndex: 0,
    }));
  },

  addToHistory: () => {
    set((state) => ({
      history: [
        ...state.history.slice(0, state.currentHistoryIndex + 1),
        { nodes: state.nodes, edges: state.edges },
      ].slice(-MAX_HISTORY),
      currentHistoryIndex: state.currentHistoryIndex + 1,
    }));
  },
}));
