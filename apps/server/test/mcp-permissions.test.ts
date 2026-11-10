import { describe, expect, it } from 'vitest';
import { agentToolNames, createAgentTools, type AgentToolPorts } from '../src/integrations/mcp/agent-tools.js';
import { integrationTools } from '../src/integrations/mcp/catalog.js';
import { createDavoTools } from '../src/integrations/mcp/davo-tools.js';
import { mcpPermissionCapabilities, mcpPrincipalPermitted, mcpToolPermitted } from '../src/integrations/mcp/permissions.js';
import { createWorkerTools, type DeveloperWorkerDependencies } from '../src/integrations/mcp/worker-tools.js';
import { createWorkspaceTools, type WorkspaceToolsDependencies } from '../src/integrations/mcp/workspace-tools.js';

// provide inert ports for descriptor construction
const ports = Object.fromEntries(agentToolNames.map(name => [name, async () => ({ ok: true, version: 'v2', value: {} })])) as AgentToolPorts;

// construct every descriptor without executing a domain operation
function descriptors() {
  return [
    ...integrationTools,
    ...createAgentTools(ports),
    ...createWorkspaceTools({} as WorkspaceToolsDependencies),
    ...createWorkerTools({} as DeveloperWorkerDependencies),
    ...createDavoTools({} as never)
  ];
}

describe('MCP capability permissions', () => {
  // keep the static manifest complete as tool registries evolve
  it('covers every runtime projection with one matching fail-closed lane', () => {
    const capabilities = new Map(mcpPermissionCapabilities.map(capability => [capability.name, capability]));
    const tools = descriptors();
    expect(tools).toHaveLength(152);
    expect(capabilities.size).toBe(135);
    // every audience projection must retain the same configurable lane
    for (const tool of tools) expect(capabilities.get(tool.name)?.mode).toBe(tool.risk === 'read' ? 'read' : 'write');
    expect(new Set(tools.map(tool => tool.name))).toEqual(new Set(capabilities.keys()));
  });

  // preserve the exact branch-baseline defaults
  it('preserves the merge-base surface and defaults only branch-new Davo writes off', () => {
    const disabled = mcpPermissionCapabilities.filter(capability => !capability.defaultEnabled).map(capability => capability.name);
    expect(mcpPermissionCapabilities.filter(capability => capability.defaultEnabled)).toHaveLength(132);
    expect(disabled).toEqual(['answer_davo_choice', 'bind_davo_target', 'delegate_request']);
  });

  // apply sparse overrides without granting unknown lanes
  it('honors explicit supported flags while rejecting unknown names and opposite lanes', () => {
    expect(mcpToolPermitted(undefined, 'list_agents', 'read')).toBe(true);
    expect(mcpToolPermitted({ list_agents: { read: false } }, 'list_agents', 'read')).toBe(false);
    expect(mcpToolPermitted(undefined, 'delegate_request', 'write')).toBe(false);
    expect(mcpToolPermitted({ delegate_request: { write: true } }, 'delegate_request', 'write')).toBe(true);
    expect(mcpToolPermitted({ list_agents: { write: true } }, 'list_agents', 'write')).toBe(false);
    expect(mcpToolPermitted(undefined, 'future_tool', 'read')).toBe(false);
  });

  // child preferences can reduce but never widen the shared ceiling
  it('intersects principal preferences without authoring inherited defaults', () => {
    expect(mcpPrincipalPermitted(undefined, undefined, 'list_agents', 'read')).toBe(true);
    expect(mcpPrincipalPermitted(undefined, { list_agents: { read: false } }, 'list_agents', 'read')).toBe(false);
    expect(mcpPrincipalPermitted({ list_agents: { read: false } }, { list_agents: { read: true } }, 'list_agents', 'read')).toBe(false);
    expect(mcpPrincipalPermitted({ delegate_request: { write: true } }, { delegate_request: { write: false } }, 'delegate_request', 'write')).toBe(false);
    expect(mcpPrincipalPermitted({ delegate_request: { write: false } }, { delegate_request: { write: true } }, 'delegate_request', 'write')).toBe(false);
    expect(mcpPrincipalPermitted(undefined, { list_agents: { write: true } }, 'list_agents', 'write')).toBe(false);
    expect(mcpPrincipalPermitted(undefined, { future_tool: { read: true } } as never, 'future_tool', 'read')).toBe(false);
  });
});
